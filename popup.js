// Translate Switch - popup logic (target language + quick actions).

const LANGUAGES = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["pl", "Polish"],
  ["tr", "Turkish"],
  ["ar", "Arabic"],
  ["fa", "Persian"],
  ["hi", "Hindi"],
  ["bn", "Bengali"],
  ["ur", "Urdu"],
  ["zh", "Chinese (Simplified)"],
  ["zh-Hant", "Chinese (Traditional)"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["vi", "Vietnamese"],
  ["th", "Thai"],
  ["id", "Indonesian"],
  ["ms", "Malay"],
  ["el", "Greek"],
  ["he", "Hebrew"],
  ["sv", "Swedish"],
  ["da", "Danish"],
  ["fi", "Finnish"],
  ["no", "Norwegian"],
  ["cs", "Czech"],
  ["sk", "Slovak"],
  ["ro", "Romanian"],
  ["hu", "Hungarian"],
  ["bg", "Bulgarian"],
  ["hr", "Croatian"],
  ["sr", "Serbian"],
  ["sl", "Slovenian"],
  ["lt", "Lithuanian"],
  ["lv", "Latvian"],
  ["et", "Estonian"],
  ["ca", "Catalan"],
  ["gl", "Galician"],
  ["eu", "Basque"],
  ["af", "Afrikaans"],
  ["sw", "Swahili"],
  ["ta", "Tamil"],
  ["te", "Telugu"],
  ["mr", "Marathi"],
  ["kn", "Kannada"],
  ["fil", "Filipino"]
];

const DEFAULT_LANG_A = "en";
const DEFAULT_LANG_B = "no";

function populateSelect(selectId, selected) {
  const select = document.getElementById(selectId);
  const sorted = [...LANGUAGES].sort((a, b) =>
    a[1].localeCompare(b[1])
  );
  for (const [code, name] of sorted) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${name} (${code})`;
    if (code === selected) opt.selected = true;
    select.appendChild(opt);
  }
}

function loadPair() {
  chrome.storage.sync.get(
    { langA: DEFAULT_LANG_A, langB: DEFAULT_LANG_B },
    (res) => {
      populateSelect("langA", (res && res.langA) || DEFAULT_LANG_A);
      populateSelect("langB", (res && res.langB) || DEFAULT_LANG_B);
    }
  );
}

document.getElementById("langA").addEventListener("change", (e) => {
  chrome.storage.sync.set({ langA: e.target.value });
});

document.getElementById("langB").addEventListener("change", (e) => {
  chrome.storage.sync.set({ langB: e.target.value });
});

document.getElementById("toggle").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "toggle-active-tab" }, () => {
    window.close();
  });
});

document.getElementById("shortcut").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

function baseLang(code) {
  const b = (code || "").toLowerCase().split("-")[0];
  if (b === "nb" || b === "nn") return "no";
  return b;
}

function getPair() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { langA: DEFAULT_LANG_A, langB: DEFAULT_LANG_B },
      (res) => {
        resolve({
          langA: (res && res.langA) || DEFAULT_LANG_A,
          langB: (res && res.langB) || DEFAULT_LANG_B
        });
      }
    );
  });
}

// Both translation directions we may need for the configured pair.
function pairDirections(pair) {
  const dirs = [
    { sourceLanguage: pair.langA, targetLanguage: pair.langB },
    { sourceLanguage: pair.langB, targetLanguage: pair.langA }
  ];
  return dirs.filter((d) => baseLang(d.sourceLanguage) !== baseLang(d.targetLanguage));
}

async function reportEngine() {
  const status = document.getElementById("status");
  const downloadBtn = document.getElementById("download");
  downloadBtn.style.display = "none";

  if (!("Translator" in self)) {
    status.innerHTML =
      "<b>Engine:</b> Built-in translation not detected. The Google Translate fallback will be used.";
    return;
  }

  try {
    const pair = await getPair();
    const dirs = pairDirections(pair);
    const states = await Promise.all(
      dirs.map((d) => Translator.availability(d).catch(() => "unavailable"))
    );

    const allReady = states.every((s) => s === "available");
    const anyDownloadable = states.some(
      (s) => s === "downloadable" || s === "downloading"
    );
    const anyUnavailable = states.some((s) => s === "unavailable");

    if (allReady) {
      status.innerHTML = "<b>Engine:</b> Chrome built-in translation (ready).";
    } else if (anyDownloadable) {
      status.innerHTML =
        "<b>Engine:</b> Chrome built-in translation. A one-time model download is needed. Click below to prepare it.";
      downloadBtn.style.display = "block";
    } else if (anyUnavailable) {
      status.innerHTML =
        "<b>Engine:</b> Built-in models unavailable for this pair. The Google Translate fallback will be used.";
    } else {
      status.innerHTML = "<b>Engine:</b> Chrome built-in translation detected.";
    }
  } catch (e) {
    status.innerHTML = "<b>Engine:</b> Chrome built-in translation detected.";
  }
}

document.getElementById("download").addEventListener("click", async () => {
  const status = document.getElementById("status");
  const downloadBtn = document.getElementById("download");
  downloadBtn.disabled = true;
  try {
    if ("LanguageDetector" in self) {
      const ld = await LanguageDetector.availability();
      if (ld === "downloadable" || ld === "downloading") {
        status.innerHTML = "<b>Engine:</b> Downloading language detector...";
        const det = await LanguageDetector.create({
          monitor(m) {
            m.addEventListener("downloadprogress", (e) => {
              status.innerHTML = `<b>Engine:</b> Detector ${Math.round(
                (e.loaded || 0) * 100
              )}%`;
            });
          }
        });
        det.destroy && det.destroy();
      }
    }

    const pair = await getPair();
    const dirs = pairDirections(pair);
    for (const dir of dirs) {
      const avail = await Translator.availability(dir).catch(() => "unavailable");
      if (avail === "unavailable" || avail === "available") continue;
      status.innerHTML = `<b>Engine:</b> Downloading ${dir.sourceLanguage} to ${dir.targetLanguage}...`;
      const t = await Translator.create({
        ...dir,
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            status.innerHTML = `<b>Engine:</b> ${dir.sourceLanguage} to ${
              dir.targetLanguage
            }: ${Math.round((e.loaded || 0) * 100)}%`;
          });
        }
      });
      t.destroy && t.destroy();
    }

    status.innerHTML = "<b>Engine:</b> Models ready. Use the shortcut to translate.";
  } catch (e) {
    status.innerHTML =
      "<b>Engine:</b> Download failed: " + (e && e.message ? e.message : e);
  } finally {
    downloadBtn.disabled = false;
    reportEngine();
  }
});

// --------------------------------------------------- looked-up word frequency
const LOOKUP_KEY = "wordLookups";
const FREQ_LIMIT = 50;

// Display direction: "t2o" = Translated -> Origin, "o2t" = Origin -> Translated.
let freqDir = "t2o";

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const sec = Math.round(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.round(mon / 12)}y ago`;
}

function getLookups() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [LOOKUP_KEY]: {} }, (res) => {
      const map = (res && res[LOOKUP_KEY]) || {};
      resolve(
        Object.values(map).sort(
          (a, b) => b.count - a.count || (b.last || 0) - (a.last || 0)
        )
      );
    });
  });
}

async function renderFrequency() {
  const list = document.getElementById("freq-list");
  const items = await getLookups();
  if (!items.length) {
    list.innerHTML =
      '<div class="freq-empty">No lookups yet. Translate a page or PDF, then select a translated word to see (and record) its origin.</div>';
    return;
  }
  list.innerHTML = items
    .slice(0, FREQ_LIMIT)
    .map((it, i) => {
      const primary = freqDir === "t2o" ? it.term : it.origin || it.term;
      const secondary = freqDir === "t2o" ? it.origin : it.term;
      const sec = secondary
        ? ` <span class="freq-origin">&rarr; ${escapeHtml(secondary)}</span>`
        : "";
      const when = relativeTime(it.last);
      const time = when ? `<span class="freq-time">${when}</span>` : "";
      return (
        '<div class="freq-item">' +
        `<span class="freq-rank">${i + 1}</span>` +
        `<span class="freq-words"><span class="freq-term">${escapeHtml(
          primary
        )}</span>${sec}${time}</span>` +
        `<span class="freq-count">${it.count}</span>` +
        "</div>"
      );
    })
    .join("");
}

function toCsv(items) {
  const header = [
    "term",
    "origin",
    "source",
    "target",
    "count",
    "first_seen",
    "last_seen"
  ];
  const esc = (v) => {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = items.map((it) => [
    it.term,
    it.origin,
    it.src,
    it.tgt,
    it.count,
    it.first ? new Date(it.first).toISOString() : "",
    it.last ? new Date(it.last).toISOString() : ""
  ]);
  return [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

async function exportCsv() {
  const items = await getLookups();
  if (!items.length) return;
  const blob = new Blob([toCsv(items)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "translate-switch-word-frequency.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById("freq-toggle").addEventListener("click", () => {
  const panel = document.getElementById("freq-panel");
  const show = panel.style.display === "none";
  panel.style.display = show ? "block" : "none";
  if (show) renderFrequency();
});

document.getElementById("freq-direction").addEventListener("click", (e) => {
  freqDir = freqDir === "t2o" ? "o2t" : "t2o";
  e.target.innerHTML =
    freqDir === "t2o"
      ? "Direction: Translated &rarr; Origin"
      : "Direction: Origin &rarr; Translated";
  renderFrequency();
});

document.getElementById("freq-export").addEventListener("click", exportCsv);

document.getElementById("freq-clear").addEventListener("click", () => {
  chrome.storage.local.set({ [LOOKUP_KEY]: {} }, renderFrequency);
});

loadPair();
reportEngine();
