// Translate Switch - PDF viewer.
// Renders a PDF with PDF.js (left column) and shows translated text per page
// (right column), using Chrome's built-in on-device Translator API. The text
// pane toggles between the extracted original and the translation.

import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "vendor/pdfjs/pdf.worker.min.mjs"
);

const DEFAULT_LANG_A = "en";
const DEFAULT_LANG_B = "no";
const RENDER_SCALE = 1.4;
const MAX_CHUNK_CHARS = 1800;

// ---------------------------------------------------------------- DOM refs
const els = {
  title: document.getElementById("doc-title"),
  lang: document.getElementById("lang-indicator"),
  status: document.getElementById("status"),
  pages: document.getElementById("pages"),
  back: document.getElementById("back-link"),
  btnOriginal: document.getElementById("btn-original"),
  btnTranslated: document.getElementById("btn-translated")
};

// ------------------------------------------------------------------- state
const app = {
  fileUrl: null,
  pdf: null,
  source: null,
  target: null,
  translator: null,
  translatorReady: false,
  mode: "translated", // "original" | "translated"
  records: [] // per page: see makeRecord()
};

// ---------------------------------------------------------------- helpers
function setStatus(message, isError = false) {
  els.status.textContent = message || "";
  els.status.classList.toggle("is-error", !!isError);
}

function baseLang(code) {
  const b = (code || "").toLowerCase().split("-")[0];
  if (b === "nb" || b === "nn") return "no";
  return b;
}

function pickTarget(source, pair) {
  return baseLang(source) === baseLang(pair.langA) ? pair.langB : pair.langA;
}

function getLanguagePair() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(
        { langA: DEFAULT_LANG_A, langB: DEFAULT_LANG_B },
        (res) => {
          resolve({
            langA: (res && res.langA) || DEFAULT_LANG_A,
            langB: (res && res.langB) || DEFAULT_LANG_B
          });
        }
      );
    } catch (e) {
      resolve({ langA: DEFAULT_LANG_A, langB: DEFAULT_LANG_B });
    }
  });
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").pop() || "");
    return last || url;
  } catch (e) {
    return url;
  }
}

// Reconstruct readable text from a page's text content items. PDF.js marks
// line ends with hasEOL; we also insert a blank line on large vertical gaps
// so paragraphs stay separated.
function itemsToText(textContent) {
  const items = textContent.items || [];
  let out = "";
  let prevY = null;
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const y = it.transform ? it.transform[5] : null;
    if (prevY != null && y != null && Math.abs(prevY - y) > 18 && !out.endsWith("\n\n")) {
      out += "\n";
    }
    out += it.str;
    if (it.hasEOL) out += "\n";
    if (y != null) prevY = y;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildDetectionSample(texts) {
  const sorted = texts
    .map((t) => (t || "").trim())
    .filter((t) => t.length > 0)
    .sort((a, b) => b.length - a.length);
  let sample = "";
  for (const t of sorted) {
    sample += t + "\n";
    if (sample.length >= 4000) break;
  }
  return sample.slice(0, 4000);
}

async function detectSourceLanguage(sample) {
  try {
    if ("LanguageDetector" in self) {
      const availability = await LanguageDetector.availability();
      if (availability !== "unavailable") {
        const detector = await LanguageDetector.create();
        const results = await detector.detect(sample);
        try {
          detector.destroy && detector.destroy();
        } catch (e) {
          /* noop */
        }
        const best = results && results[0];
        if (
          best &&
          best.detectedLanguage &&
          best.detectedLanguage !== "und" &&
          (best.confidence == null || best.confidence >= 0.5)
        ) {
          return best.detectedLanguage;
        }
      }
    }
  } catch (e) {
    // fall through
  }
  return DEFAULT_LANG_A;
}

// --------------------------------------------------------------- translation
async function ensureTranslator() {
  if (app.translatorReady) return app.translator;

  if (!("Translator" in self)) {
    throw new Error(
      "Chrome's built-in Translator API is not available in this browser. PDF translation requires Chrome 138+ with the on-device translation models."
    );
  }

  const options = { sourceLanguage: app.source, targetLanguage: app.target };
  let availability;
  try {
    availability = await Translator.availability(options);
  } catch (e) {
    availability = "unavailable";
  }

  if (availability === "unavailable") {
    throw new Error(
      `Built-in translation model for ${app.source} -> ${app.target} is unavailable.`
    );
  }

  const needsDownload = availability !== "available";
  if (needsDownload) {
    setStatus(`Preparing ${app.source} -> ${app.target} model...`);
  }

  try {
    app.translator = await Translator.create({
      ...options,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          if (!needsDownload) return;
          const pct = Math.round((e.loaded || 0) * 100);
          setStatus(`Downloading ${app.source} -> ${app.target} model... ${pct}%`);
        });
      }
    });
  } catch (e) {
    if (e && e.name === "NotAllowedError") {
      throw new Error(
        "First-time model download needed. Open the Translate Switch popup and click 'Download translation models', then reopen this PDF."
      );
    }
    throw e;
  }

  app.translatorReady = true;
  if (needsDownload) setStatus("");
  return app.translator;
}

async function translateText(translator, text) {
  if (!text || !text.trim()) return text;
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let cur = "";
  for (const p of paragraphs) {
    const candidate = cur ? cur + "\n\n" + p : p;
    if (candidate.length > MAX_CHUNK_CHARS && cur) {
      chunks.push(cur);
      cur = p;
    } else {
      cur = candidate;
    }
  }
  if (cur) chunks.push(cur);

  const out = [];
  for (const c of chunks) {
    try {
      out.push(await translator.translate(c));
    } catch (e) {
      out.push(c); // keep original chunk on failure
    }
  }
  return out.join("\n\n");
}

// ----------------------------------------------------------------- rendering
function makeRecord(num) {
  const row = document.createElement("section");
  row.className = "page-row";

  const canvasCol = document.createElement("div");
  canvasCol.className = "page-col canvas-col";
  const canvasLabel = document.createElement("div");
  canvasLabel.className = "page-label";
  canvasLabel.textContent = `Page ${num}`;
  const canvasWrap = document.createElement("div");
  canvasWrap.style.width = "100%";
  canvasWrap.appendChild(canvasLabel);
  canvasCol.appendChild(canvasWrap);

  const textCol = document.createElement("div");
  textCol.className = "page-col text-col";
  const textLabel = document.createElement("div");
  textLabel.className = "page-label";
  textLabel.textContent = `Page ${num}`;
  const textBody = document.createElement("div");
  textBody.className = "text-placeholder";
  textBody.textContent = "...";
  textCol.appendChild(textLabel);
  textCol.appendChild(textBody);

  row.appendChild(canvasCol);
  row.appendChild(textCol);

  return {
    num,
    row,
    canvasCol,
    textBody,
    rendered: false,
    extracted: false,
    translated: false,
    processing: false,
    originalText: "",
    translatedText: ""
  };
}

function renderTextBody(rec) {
  const wantOriginal = app.mode === "original";
  const text = wantOriginal ? rec.originalText : rec.translatedText;

  if (rec.extracted && !rec.originalText.trim()) {
    rec.textBody.className = "text-placeholder";
    rec.textBody.textContent = "(No extractable text on this page.)";
    return;
  }
  if (!wantOriginal && !rec.translated) {
    rec.textBody.className = "text-placeholder";
    rec.textBody.textContent = rec.extracted ? "Translating..." : "...";
    return;
  }
  rec.textBody.className = "text-body";
  rec.textBody.textContent = text;
}

async function renderCanvas(rec, page) {
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = "100%";
  rec.canvasCol.querySelector("div").appendChild(canvas);
  await page.render({
    canvasContext: ctx,
    viewport,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined
  }).promise;
}

async function processPage(rec) {
  if (rec.processing) return;
  rec.processing = true;
  try {
    const page = await app.pdf.getPage(rec.num);

    if (!rec.rendered) {
      await renderCanvas(rec, page);
      rec.rendered = true;
    }

    if (!rec.extracted) {
      const textContent = await page.getTextContent();
      rec.originalText = itemsToText(textContent);
      rec.extracted = true;
      renderTextBody(rec);
    }

    if (!rec.translated && rec.originalText.trim()) {
      const translator = await ensureTranslator();
      rec.translatedText = await translateText(translator, rec.originalText);
      rec.translated = true;
      renderTextBody(rec);
    } else {
      renderTextBody(rec);
    }
  } catch (e) {
    console.error("Translate Switch (PDF):", e);
    setStatus((e && e.message) || String(e), true);
    rec.textBody.className = "text-placeholder";
    if (!rec.translated) {
      rec.textBody.textContent = rec.originalText || "(Translation failed.)";
      if (rec.originalText) rec.textBody.className = "text-body";
    }
  } finally {
    rec.processing = false;
  }
}

// ------------------------------------------------------------------- toggle
function setMode(mode) {
  app.mode = mode;
  els.btnOriginal.classList.toggle("is-active", mode === "original");
  els.btnTranslated.classList.toggle("is-active", mode === "translated");
  for (const rec of app.records) {
    if (rec.extracted) renderTextBody(rec);
    // Switching to translated may reveal pages that have not been translated
    // yet because they were never scrolled into view; process them on demand.
    if (mode === "translated" && rec.extracted && !rec.translated && !rec.processing) {
      processPage(rec);
    }
  }
}

els.btnOriginal.addEventListener("click", () => setMode("original"));
els.btnTranslated.addEventListener("click", () => setMode("translated"));

// --------------------------------------------------------------------- init
async function init() {
  const params = new URLSearchParams(location.search);
  const fileUrl = params.get("file");
  if (!fileUrl) {
    setStatus("No PDF specified.", true);
    return;
  }
  app.fileUrl = fileUrl;
  els.title.textContent = filenameFromUrl(fileUrl);
  els.title.title = fileUrl;
  els.back.href = fileUrl;

  setStatus("Loading PDF...");
  let data;
  try {
    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.arrayBuffer();
  } catch (e) {
    setStatus(
      `Could not load the PDF (${(e && e.message) || e}). For local files, enable "Allow access to file URLs" on the extension's details page.`,
      true
    );
    return;
  }

  try {
    app.pdf = await pdfjsLib.getDocument({ data }).promise;
  } catch (e) {
    setStatus(`Failed to parse the PDF: ${(e && e.message) || e}`, true);
    return;
  }

  const numPages = app.pdf.numPages;

  // Build all page rows up front (cheap placeholders).
  for (let i = 1; i <= numPages; i++) {
    const rec = makeRecord(i);
    app.records.push(rec);
    els.pages.appendChild(rec.row);
  }
  els.pages.setAttribute("aria-busy", "false");

  // Detect source language from the first pages' text, then pick the target.
  setStatus("Detecting language...");
  const sampleTexts = [];
  const probeCount = Math.min(3, numPages);
  for (let i = 1; i <= probeCount; i++) {
    try {
      const page = await app.pdf.getPage(i);
      const tc = await page.getTextContent();
      sampleTexts.push(itemsToText(tc));
    } catch (e) {
      /* ignore */
    }
  }
  const sample = buildDetectionSample(sampleTexts);
  const pair = await getLanguagePair();
  app.source = baseLang(await detectSourceLanguage(sample));
  app.target = pickTarget(app.source, pair);

  if (baseLang(app.source) === baseLang(app.target)) {
    els.lang.textContent = `Detected ${app.source} (already in target language)`;
    setStatus("");
    // Still extract/render so the user can read the document.
  } else {
    els.lang.textContent = `${app.source} -> ${app.target}`;
    setStatus("");
  }

  // Lazily render + translate pages as they scroll into view.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const rec = app.records.find((r) => r.row === entry.target);
        if (rec && !rec.processing && !(rec.rendered && rec.extracted && rec.translated)) {
          processPage(rec);
        }
      }
    },
    { root: els.pages, rootMargin: "400px 0px" }
  );
  for (const rec of app.records) observer.observe(rec.row);
}

init();
