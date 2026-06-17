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

// Reconstruct readable text from a page's text content items.
//
// PDF text is a bag of positioned glyph runs, so naive concatenation produces
// run-together words and one hard line break per visual line. We instead:
//   1. group runs into visual lines (by baseline Y, respecting hasEOL),
//   2. join runs within a line, inserting spaces where there is a horizontal
//      gap (PDF.js often omits the spaces between runs),
//   3. merge consecutive lines into flowing paragraphs, joining hyphenated
//      word breaks, and start a new paragraph on a large vertical gap or when
//      the text jumps to a new column/region.
function itemsToText(textContent) {
  const raw = (textContent.items || []).filter(
    (it) => it && typeof it.str === "string" && it.transform
  );
  if (!raw.length) return "";

  // ---- 1. group runs into visual lines ----------------------------------
  const lines = [];
  let current = null;
  for (const it of raw) {
    const x = it.transform[4];
    const y = it.transform[5];
    const w = it.width || 0;
    const h = it.height || Math.abs(it.transform[3]) || 10;

    if (!current || Math.abs(current.y - y) > Math.max(2, current.h * 0.5)) {
      current = { y, h, runs: [] };
      lines.push(current);
    }
    if (it.str) current.runs.push({ str: it.str, x, w });
    current.h = Math.max(current.h, h);
    if (it.hasEOL) current = null; // force the next run onto a new line
  }

  // ---- 2. build each line's text, restoring inter-word spaces ------------
  const built = [];
  for (const line of lines) {
    const runs = line.runs.sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd = null;
    for (const r of runs) {
      if (prevEnd != null) {
        const gap = r.x - prevEnd;
        const avgChar = r.w && r.str.length ? r.w / r.str.length : 0;
        const needsSpace = gap > Math.max(1, avgChar * 0.3);
        if (needsSpace && !/\s$/.test(text) && !/^\s/.test(r.str)) {
          text += " ";
        }
      }
      text += r.str;
      prevEnd = r.x + r.w;
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text) built.push({ text, y: line.y, h: line.h });
  }
  if (!built.length) return "";

  // ---- 3. merge lines into paragraphs -----------------------------------
  let out = built[0].text;
  for (let i = 1; i < built.length; i++) {
    const line = built[i];
    const prev = built[i - 1];
    const delta = prev.y - line.y; // PDF Y grows upward; reading goes downward
    const lineHeight = Math.max(prev.h, line.h, 1);
    const newParagraph = delta < -2 || delta > lineHeight * 1.6;

    if (newParagraph) {
      out += "\n\n";
      out += line.text;
    } else if (/[\u00AD-]$/.test(out) && /[A-Za-zÀ-ÿ]/.test(line.text[0] || "")) {
      // Join a hyphenated word split across lines.
      out = out.replace(/[\u00AD-]$/, "") + line.text;
    } else {
      out += " " + line.text;
    }
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

// Translate a single paragraph (no internal blank lines). Long paragraphs are
// split on sentence boundaries so we never send an oversized request.
async function translateParagraph(translator, para) {
  const trimmed = para.trim();
  if (!trimmed) return "";
  if (trimmed.length <= MAX_CHUNK_CHARS) {
    try {
      return (await translator.translate(trimmed)).trim();
    } catch (e) {
      return trimmed;
    }
  }

  const sentences = trimmed.match(/[^.!?]+[.!?]+[\])'"`’”]*|\S[^.!?]*$/g) || [
    trimmed
  ];
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    const candidate = cur ? cur + " " + s.trim() : s.trim();
    if (candidate.length > MAX_CHUNK_CHARS && cur) {
      chunks.push(cur);
      cur = s.trim();
    } else {
      cur = candidate;
    }
  }
  if (cur) chunks.push(cur);

  const out = [];
  for (const c of chunks) {
    try {
      out.push((await translator.translate(c)).trim());
    } catch (e) {
      out.push(c);
    }
  }
  return out.join(" ");
}

// Translate text paragraph-by-paragraph so paragraph spacing is preserved
// regardless of how the model treats blank lines inside a single request.
async function translateText(translator, text) {
  if (!text || !text.trim()) return text;
  const paragraphs = text.split(/\n{2,}/);
  const out = [];
  for (const p of paragraphs) {
    if (!p.trim()) continue;
    out.push(await translateParagraph(translator, p));
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
    canvasWrap,
    textBody,
    rendered: false,
    extracted: false,
    translated: false,
    processing: false,
    originalText: "",
    translatedText: "",
    highlightLayer: null,
    spanText: "",
    words: [],
    glossCache: new Map()
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
  rec.textBody.textContent = "";
  const paragraphs = text.split(/\n{2,}/);
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const p = document.createElement("p");
    p.className = "para";
    p.textContent = para;
    rec.textBody.appendChild(p);
  }
}

// Build per-word boxes (in viewport/CSS pixels at RENDER_SCALE) plus a parallel
// source-text string with char offsets, so a located source range can be mapped
// to exact rectangles over the rendered page. Geometry comes from the same
// viewport transform used to paint the canvas, so highlights always align.
function buildWordIndex(rec, textContent, viewport) {
  const items = (textContent.items || []).filter(
    (it) => it && typeof it.str === "string" && it.transform
  );
  let text = "";
  const words = [];
  const wordRe = /\S+/g;

  for (const it of items) {
    const str = it.str;
    if (!str || !str.trim()) {
      if (it.hasEOL && text && !text.endsWith(" ")) text += " ";
      continue;
    }
    const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]) || 10;
    const itemLeft = tx[4];
    const itemTop = tx[5] - fontHeight;
    const itemWidth = (it.width || 0) * viewport.scale;
    const len = str.length;

    let m;
    wordRe.lastIndex = 0;
    while ((m = wordRe.exec(str)) !== null) {
      const startFrac = len ? m.index / len : 0;
      const widthFrac = len ? m[0].length / len : 1;
      const start = text.length;
      text += m[0];
      words.push({
        start,
        end: text.length,
        left: itemLeft + itemWidth * startFrac,
        top: itemTop,
        width: itemWidth * widthFrac,
        height: fontHeight
      });
      text += " ";
    }
  }

  rec.spanText = text;
  rec.words = words;
}

async function renderCanvas(rec, page, textContent) {
  const viewport = page.getViewport({ scale: RENDER_SCALE });

  const pageScale = document.createElement("div");
  pageScale.className = "page-scale";

  const pdfPage = document.createElement("div");
  pdfPage.className = "pdf-page";
  pdfPage.style.width = viewport.width + "px";
  pdfPage.style.height = viewport.height + "px";

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = viewport.width + "px";
  canvas.style.height = viewport.height + "px";
  pdfPage.appendChild(canvas);

  const hlLayer = document.createElement("div");
  hlLayer.className = "highlight-layer";
  pdfPage.appendChild(hlLayer);
  rec.highlightLayer = hlLayer;

  pageScale.appendChild(pdfPage);
  rec.canvasWrap.appendChild(pageScale);

  await page.render({
    canvasContext: ctx,
    viewport,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined
  }).promise;

  try {
    buildWordIndex(rec, textContent || (await page.getTextContent()), viewport);
  } catch (e) {
    // Highlighting just won't be available for this page.
  }

  // Scale the whole page (canvas + overlay together) to fit the column; the
  // highlight overlay uses the same coordinate space so it stays aligned.
  const applyScale = () => {
    const avail = pageScale.clientWidth;
    if (!avail) return;
    const scale = Math.min(1, avail / viewport.width);
    pdfPage.style.transform = `scale(${scale})`;
    pageScale.style.height = viewport.height * scale + "px";
  };
  applyScale();
  try {
    new ResizeObserver(applyScale).observe(pageScale);
  } catch (e) {
    window.addEventListener("resize", applyScale);
  }
}

async function processPage(rec) {
  if (rec.processing) return;
  rec.processing = true;
  try {
    const page = await app.pdf.getPage(rec.num);
    const textContent = await page.getTextContent();

    if (!rec.rendered) {
      await renderCanvas(rec, page, textContent);
      rec.rendered = true;
    }

    if (!rec.extracted) {
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
  hideTip();
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

// ----------------------------------------------------- word origin gloss
const gloss = {
  tip: document.getElementById("gloss-tip"),
  activeLayer: null,
  timer: null,
  reqId: 0,
  lastKey: null
};

function clearGlossHighlight() {
  if (gloss.activeLayer) {
    gloss.activeLayer.textContent = "";
    gloss.activeLayer = null;
  }
}

// Draw highlight boxes over the words whose spanText offsets fall in [start,end).
function highlightSourceRange(rec, start, end) {
  if (!rec.highlightLayer || !rec.words) return false;
  clearGlossHighlight();
  let drew = false;
  for (const w of rec.words) {
    if (w.end <= start || w.start >= end) continue; // no overlap
    const box = document.createElement("div");
    box.className = "highlight-box";
    box.style.left = w.left + "px";
    box.style.top = w.top + "px";
    box.style.width = Math.max(2, w.width) + "px";
    box.style.height = w.height + "px";
    rec.highlightLayer.appendChild(box);
    drew = true;
  }
  if (drew) gloss.activeLayer = rec.highlightLayer;
  return drew;
}

function recordFromNode(node) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body) {
    if (el.classList && el.classList.contains("text-body")) {
      return app.records.find((r) => r.textBody === el) || null;
    }
    el = el.parentElement;
  }
  return null;
}

function positionTip(x, y) {
  const tip = gloss.tip;
  if (!tip) return;
  const pad = 14;
  const rect = tip.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > window.innerWidth - 8) left = Math.max(8, x - pad - rect.width);
  if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - pad - rect.height);
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}

function renderTip(x, y, parts) {
  const tip = gloss.tip;
  if (!tip) return;
  tip.textContent = "";
  if (parts.loading) {
    tip.textContent = "Looking up origin...";
  } else {
    const orig = document.createElement("div");
    orig.className = "gloss-origin";
    orig.textContent = (parts.approximate ? "≈ " : "") + parts.original;
    tip.appendChild(orig);
    const cap = document.createElement("div");
    cap.className = "gloss-caption";
    cap.textContent = `${app.target} "${parts.word}" -> ${app.source}`;
    tip.appendChild(cap);
  }
  tip.classList.add("is-visible");
  positionTip(x, y);
}

function hideTip() {
  if (gloss.tip) gloss.tip.classList.remove("is-visible");
  gloss.lastKey = null;
  clearGlossHighlight();
}

function getSelectionInfo() {
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  let range;
  try {
    range = sel.getRangeAt(0);
  } catch (e) {
    return null;
  }
  return { text, range, node: range.startContainer };
}

async function processSelection() {
  if (app.mode !== "translated") {
    hideTip();
    return;
  }
  const info = getSelectionInfo();
  if (!info) {
    hideTip();
    return;
  }
  // Only react to selections made in the translated (right) column.
  const rec = recordFromNode(info.node);
  if (!rec || !rec.spanText) {
    hideTip();
    return;
  }
  const phrase = info.text;
  if (!/[\p{L}\p{N}]/u.test(phrase)) {
    hideTip();
    return;
  }

  const rect = info.range.getBoundingClientRect();
  const x = rect.left;
  const y = rect.bottom;

  const key = rec.num + "::" + phrase;
  if (key === gloss.lastKey && gloss.tip.classList.contains("is-visible")) {
    positionTip(x, y);
    return;
  }
  gloss.lastKey = key;
  clearGlossHighlight();
  renderTip(x, y, { loading: true });

  const myReq = ++gloss.reqId;
  let result = rec.glossCache.get(phrase);
  if (!result) {
    const back = await TSGloss.backTranslate(phrase, app.target, app.source);
    if (myReq !== gloss.reqId) return;
    const found = back ? TSGloss.locate(back, rec.spanText) : null;
    result = { back, found };
    rec.glossCache.set(phrase, result);
  }
  if (myReq !== gloss.reqId) return;

  if (!result.back) {
    renderTip(x, y, {
      word: phrase,
      original: "origin model not ready - click 'Download translation models' in the popup",
      approximate: true
    });
    return;
  }
  const original = result.found ? result.found.text : result.back;
  renderTip(x, y, {
    word: phrase,
    original,
    approximate: !result.found || result.found.approximate
  });

  if (result.found) {
    highlightSourceRange(rec, result.found.start, result.found.end);
  }
}

els.pages.addEventListener("mouseup", () => {
  if (typeof TSGloss === "undefined") return;
  clearTimeout(gloss.timer);
  gloss.timer = setTimeout(processSelection, 0);
});
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed) hideTip();
});
els.pages.addEventListener(
  "scroll",
  () => {
    hideTip();
  },
  { passive: true }
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideTip();
});

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
