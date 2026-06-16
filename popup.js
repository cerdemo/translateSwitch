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
  for (const [code, name] of LANGUAGES) {
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

loadPair();
reportEngine();
