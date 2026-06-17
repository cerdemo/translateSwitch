// Translate Switch - content script.
// Idempotent: the first injection sets everything up and translates; every
// later injection just calls toggle() on the existing instance.

(() => {
  "use strict";

  // If we are already loaded in this page, a new injection means "toggle".
  if (window.__translateSwitch) {
    window.__translateSwitch.toggle();
    return;
  }

  // Default language pair. The page's language is auto-detected and the
  // extension translates into whichever side of the pair it is NOT.
  const DEFAULT_LANG_A = "en";
  const DEFAULT_LANG_B = "no";
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE",
    "TEXTAREA", "KBD", "SAMP", "VAR", "TT"
  ]);

  const state = {
    mode: "original", // "original" | "translated"
    busy: false,
    translatedOnce: false,
    usingFallback: false,
    targetLanguage: DEFAULT_LANG_A,
    sourceLanguage: null,
    // entries: { node, original, translated }
    entries: []
  };

  // ---------------------------------------------------------------- UI toast
  function toast(message, opts = {}) {
    let el = document.getElementById("__ts_toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "__ts_toast";
      el.setAttribute("data-ts-toast", "");
      Object.assign(el.style, {
        position: "fixed",
        bottom: "16px",
        right: "16px",
        zIndex: "2147483647",
        maxWidth: "320px",
        padding: "10px 14px",
        borderRadius: "10px",
        font: "13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        color: "#fff",
        boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
        opacity: "0",
        transition: "opacity 0.2s ease",
        pointerEvents: "none"
      });
      // Attach to <html> so it is outside <body> and never gets translated.
      document.documentElement.appendChild(el);
    }
    el.textContent = message;
    el.style.background = opts.error ? "#b00020" : "rgba(32,33,36,0.95)";
    el.style.opacity = "1";
    clearTimeout(el.__hideTimer);
    if (!opts.sticky) {
      el.__hideTimer = setTimeout(() => {
        el.style.opacity = "0";
      }, opts.duration || 2400);
    }
    return el;
  }

  function hideToast() {
    const el = document.getElementById("__ts_toast");
    if (el) {
      clearTimeout(el.__hideTimer);
      el.style.opacity = "0";
    }
  }

  // ------------------------------------------------------------ settings I/O
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

  // Normalize a BCP-47 code to a base code for comparison/translation.
  // Norwegian variants (Bokmal "nb", Nynorsk "nn") collapse to "no".
  function baseLang(code) {
    const b = (code || "").toLowerCase().split("-")[0];
    if (b === "nb" || b === "nn") return "no";
    return b;
  }

  // Given the detected source and the configured pair, pick the target:
  // the side of the pair the page is NOT already in (defaulting to langA).
  function pickTarget(source, pair) {
    return baseLang(source) === baseLang(pair.langA) ? pair.langB : pair.langA;
  }

  // ----------------------------------------------------------- DOM traversal
  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  function collectTextNodes() {
    if (!document.body) return [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const text = node.nodeValue;
          if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
          if (parent.closest("[data-ts-toast], #__ts_google_element")) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.getAttribute && parent.getAttribute("translate") === "no") {
            return NodeFilter.FILTER_REJECT;
          }
          if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // ---------------------------------------------------- language detection
  // Build a representative sample for detection. We prefer the LONGEST text
  // nodes (real article/body copy) over the first ones, because the first
  // nodes on a page are usually nav/header/cookie boilerplate that is often
  // in English even when the page content is not -> misdetection.
  function buildDetectionSample(nodes) {
    const texts = nodes
      .map((n) => (n.nodeValue || "").trim())
      .filter((t) => t.length > 0)
      .sort((a, b) => b.length - a.length);
    let sample = "";
    for (const t of texts) {
      sample += t + "\n";
      if (sample.length >= 4000) break;
    }
    return sample.slice(0, 4000);
  }

  async function detectSourceLanguage(sample) {
    const docLang = baseLang(document.documentElement.lang || "");
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
          if (results && results.length) {
            // If the page declares a language and the detector also lists it
            // with non-trivial confidence, trust the declared language. This
            // prevents a Norwegian article from being read as English just
            // because its menu/cookie text is English.
            if (docLang) {
              const declared = results.find(
                (r) => baseLang(r.detectedLanguage) === docLang
              );
              if (declared && (declared.confidence == null || declared.confidence >= 0.1)) {
                return docLang;
              }
            }
            const best = results[0];
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
      }
    } catch (e) {
      // ignore and fall through to document language
    }
    return docLang || "en";
  }

  // -------------------------------------------------- instant cached toggle
  function applyTranslated() {
    for (const entry of state.entries) {
      if (entry.translated != null && entry.node.isConnected) {
        entry.node.nodeValue = entry.translated;
      }
    }
    state.mode = "translated";
    enableGloss();
    toast("Translated");
  }

  function restoreOriginal() {
    for (const entry of state.entries) {
      if (entry.node.isConnected) {
        entry.node.nodeValue = entry.original;
      }
    }
    state.mode = "original";
    disableGloss();
    toast("Original");
  }

  // -------------------------------------------- word origin gloss (hover)
  // Only meaningful for the built-in path, where we cache per-node originals.
  const gloss = {
    enabled: false,
    tip: null,
    highlight: null,
    timer: null,
    reqId: 0,
    lastKey: null
  };

  function ensureGlossUi() {
    if (!gloss.tip) {
      const tip = document.createElement("div");
      tip.id = "__ts_gloss_tip";
      Object.assign(tip.style, {
        position: "fixed",
        zIndex: "2147483647",
        maxWidth: "320px",
        padding: "8px 10px",
        borderRadius: "8px",
        background: "rgba(32,33,36,0.97)",
        color: "#fff",
        font: "13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        boxShadow: "0 6px 20px rgba(0,0,0,0.3)",
        opacity: "0",
        transition: "opacity 0.12s ease",
        pointerEvents: "none"
      });
      document.documentElement.appendChild(tip);
      gloss.tip = tip;
    }
    if (
      !gloss.highlight &&
      typeof Highlight !== "undefined" &&
      typeof CSS !== "undefined" &&
      CSS.highlights
    ) {
      try {
        gloss.highlight = new Highlight();
        CSS.highlights.set("ts-origin", gloss.highlight);
        const style = document.createElement("style");
        style.id = "__ts_gloss_style";
        style.textContent =
          "::highlight(ts-origin){background-color:rgba(26,115,232,0.30);}";
        document.documentElement.appendChild(style);
      } catch (e) {
        gloss.highlight = null;
      }
    }
  }

  function setGlossHighlight(range) {
    if (!gloss.highlight) return;
    try {
      gloss.highlight.clear();
      if (range) gloss.highlight.add(range);
    } catch (e) {
      /* noop */
    }
  }

  function positionTip(x, y) {
    const tip = gloss.tip;
    if (!tip) return;
    const pad = 14;
    const rect = tip.getBoundingClientRect();
    let left = x + pad;
    let top = y + pad;
    if (left + rect.width > window.innerWidth - 8) {
      left = Math.max(8, x - pad - rect.width);
    }
    if (top + rect.height > window.innerHeight - 8) {
      top = Math.max(8, y - pad - rect.height);
    }
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
      orig.style.fontWeight = "600";
      orig.style.fontSize = "15px";
      orig.textContent = (parts.approximate ? "≈ " : "") + parts.original;
      tip.appendChild(orig);

      const cap = document.createElement("div");
      cap.style.opacity = "0.7";
      cap.style.fontSize = "12px";
      cap.style.marginTop = "2px";
      cap.textContent = `${state.targetLanguage} "${parts.word}" -> ${state.sourceLanguage}`;
      tip.appendChild(cap);
    }
    tip.style.opacity = "1";
    positionTip(x, y);
  }

  function hideTip() {
    if (gloss.tip) gloss.tip.style.opacity = "0";
    gloss.lastKey = null;
    setGlossHighlight(null);
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

  function findEntryForSelection(info) {
    let entry = state.entries.find((en) => en.node === info.node);
    if (entry) return entry;
    // Selection may start in an element or span nodes: fall back to the first
    // cached node the range touches.
    if (info.range.intersectsNode) {
      entry = state.entries.find((en) => {
        try {
          return info.range.intersectsNode(en.node);
        } catch (e) {
          return false;
        }
      });
    }
    return entry || null;
  }

  async function processSelection() {
    if (!gloss.enabled || state.mode !== "translated") return;
    const info = getSelectionInfo();
    if (!info) {
      hideTip();
      return;
    }
    // Ignore selections inside our own tooltip.
    if (
      info.node &&
      info.node.parentElement &&
      info.node.parentElement.closest("#__ts_gloss_tip")
    ) {
      return;
    }
    const entry = findEntryForSelection(info);
    if (!entry || !entry.original) {
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

    const key = entry.original + "::" + phrase;
    if (key === gloss.lastKey && gloss.tip && gloss.tip.style.opacity === "1") {
      positionTip(x, y);
      return;
    }
    gloss.lastKey = key;
    renderTip(x, y, { loading: true });

    const myReq = ++gloss.reqId;
    const back = await TSGloss.backTranslate(
      phrase,
      state.targetLanguage,
      state.sourceLanguage
    );
    if (myReq !== gloss.reqId) return; // a newer selection superseded this one

    if (!back) {
      renderTip(x, y, {
        word: phrase,
        original: "origin model not ready - open the popup and click 'Download translation models'",
        approximate: true
      });
      return;
    }
    const found = TSGloss.locate(back, entry.original);
    const origin = found ? found.text : back;
    renderTip(x, y, {
      word: phrase,
      original: origin,
      approximate: !found || found.approximate
    });
    TSGloss.logLookup({
      term: phrase,
      origin,
      src: state.sourceLanguage,
      tgt: state.targetLanguage
    });
  }

  function onGlossMouseUp() {
    if (!gloss.enabled || state.mode !== "translated") return;
    // Let the selection settle before reading it.
    clearTimeout(gloss.timer);
    gloss.timer = setTimeout(processSelection, 0);
  }

  function onGlossSelectionChange() {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) hideTip();
  }

  function onGlossScroll() {
    hideTip();
  }

  function onGlossKey(e) {
    if (e.key === "Escape") hideTip();
  }

  function enableGloss() {
    if (gloss.enabled || state.usingFallback) return;
    if (typeof TSGloss === "undefined") return;
    if (!("Translator" in self)) return;
    ensureGlossUi();
    document.addEventListener("mouseup", onGlossMouseUp);
    document.addEventListener("selectionchange", onGlossSelectionChange);
    window.addEventListener("scroll", onGlossScroll, { passive: true, capture: true });
    document.addEventListener("keydown", onGlossKey);
    gloss.enabled = true;
  }

  function disableGloss() {
    if (!gloss.enabled) return;
    clearTimeout(gloss.timer);
    document.removeEventListener("mouseup", onGlossMouseUp);
    document.removeEventListener("selectionchange", onGlossSelectionChange);
    window.removeEventListener("scroll", onGlossScroll, { capture: true });
    document.removeEventListener("keydown", onGlossKey);
    hideTip();
    gloss.enabled = false;
  }

  // ----------------------------------------------- built-in Translator path
  async function translateBuiltIn(pair) {
    const nodes = collectTextNodes();
    if (nodes.length === 0) {
      toast("No translatable text found.");
      return false;
    }

    const sample = buildDetectionSample(nodes);
    const source = baseLang(await detectSourceLanguage(sample));
    const target = pickTarget(source, pair);
    state.sourceLanguage = source;
    state.targetLanguage = target;

    if (source === baseLang(target)) {
      toast(`Page already looks like '${target}'.`);
      return false;
    }

    const options = { sourceLanguage: source, targetLanguage: target };
    let availability;
    try {
      availability = await Translator.availability(options);
    } catch (e) {
      availability = "unavailable";
    }

    if (availability === "unavailable") {
      // No model for this pair -> let caller try the fallback widget.
      return "unsupported-pair";
    }

    // The model is only actually fetched when it is not already on-device.
    // When it is cached, create() still emits downloadprogress events (going
    // straight to 100%), so we must NOT show a "Downloading" toast in that
    // case or it would appear on every page.
    const needsDownload = availability !== "available";

    toast(
      needsDownload
        ? `Preparing ${source} -> ${target} model...`
        : `Translating ${source} -> ${target}...`,
      { sticky: true }
    );

    let translator;
    try {
      translator = await Translator.create({
        ...options,
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            if (!needsDownload) return;
            const pct = Math.round((e.loaded || 0) * 100);
            toast(`Downloading model... ${pct}%`, { sticky: true });
          });
        }
      });
    } catch (e) {
      if (e && e.name === "NotAllowedError") {
        throw new Error(
          "First-time model download needed. Open the Translate Switch popup and click 'Download translation models', then use the shortcut."
        );
      }
      throw e;
    }

    state.entries = [];
    let done = 0;
    for (const node of nodes) {
      const original = node.nodeValue;
      try {
        const translated = await translator.translate(original);
        state.entries.push({ node, original, translated });
        if (node.isConnected) node.nodeValue = translated;
      } catch (e) {
        // Keep the original text for this node on failure.
        state.entries.push({ node, original, translated: original });
      }
      done++;
      if (done % 20 === 0) {
        toast(`Translating... ${done}/${nodes.length}`, { sticky: true });
      }
    }

    try {
      translator.destroy && translator.destroy();
    } catch (e) {
      /* noop */
    }

    state.translatedOnce = true;
    state.mode = "translated";
    enableGloss();
    hideToast();
    toast(`Translated ${source} -> ${target}`);
    return true;
  }

  // ----------------------------------------------- Google widget fallback
  function loadGoogleWidget(source) {
    return new Promise((resolve, reject) => {
      if (window.__tsGoogleLoaded) {
        resolve();
        return;
      }
      let div = document.getElementById("__ts_google_element");
      if (!div) {
        div = document.createElement("div");
        div.id = "__ts_google_element";
        div.style.display = "none";
        document.body.appendChild(div);
      }
      window.googleTranslateElementInit = function () {
        try {
          // eslint-disable-next-line no-undef
          new google.translate.TranslateElement(
            { pageLanguage: source || "auto", autoDisplay: false },
            "__ts_google_element"
          );
          window.__tsGoogleLoaded = true;
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      const s = document.createElement("script");
      s.src =
        "https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
      s.onerror = () =>
        reject(
          new Error("Could not load Google Translate (the site's CSP may block it).")
        );
      document.head.appendChild(s);
    });
  }

  function setWidgetLanguage(lang) {
    return new Promise((resolve) => {
      let tries = 0;
      const iv = setInterval(() => {
        const combo = document.querySelector(".goog-te-combo");
        if (combo) {
          combo.value = lang;
          combo.dispatchEvent(new Event("change"));
          clearInterval(iv);
          resolve(true);
        } else if (++tries > 50) {
          clearInterval(iv);
          resolve(false);
        }
      }, 100);
    });
  }

  async function translateFallback(pair) {
    const nodes = collectTextNodes();
    const sample = buildDetectionSample(nodes);
    const source = baseLang(await detectSourceLanguage(sample));
    const target = pickTarget(source, pair);
    state.sourceLanguage = source;
    state.targetLanguage = target;

    toast("Using Google Translate fallback...", { sticky: true });
    await loadGoogleWidget(source);
    const ok = await setWidgetLanguage(target);
    hideToast();
    if (!ok) {
      toast("Fallback translation widget did not load.", { error: true });
      return false;
    }
    state.usingFallback = true;
    state.translatedOnce = true;
    state.mode = "translated";
    toast(`Translated -> ${target}`);
    return true;
  }

  // --------------------------------------------------------------- toggle
  async function toggle() {
    if (state.busy) return;

    // Fast path: we already translated once, so just swap cached text.
    if (state.translatedOnce && !state.usingFallback) {
      if (state.mode === "translated") restoreOriginal();
      else applyTranslated();
      return;
    }
    if (state.translatedOnce && state.usingFallback) {
      if (state.mode === "translated") {
        await setWidgetLanguage(state.sourceLanguage || "en");
        state.mode = "original";
        toast("Original");
      } else {
        await setWidgetLanguage(state.targetLanguage);
        state.mode = "translated";
        toast("Translated");
      }
      return;
    }

    // First run: actually translate.
    state.busy = true;
    try {
      const pair = await getLanguagePair();

      if ("Translator" in self) {
        const result = await translateBuiltIn(pair);
        if (result === "unsupported-pair") {
          toast("Built-in model unavailable for this pair, trying fallback...");
          await translateFallback(pair);
        }
      } else {
        await translateFallback(pair);
      }
    } catch (e) {
      console.error("Translate Switch:", e);
      hideToast();
      toast("Translation failed: " + (e && e.message ? e.message : e), {
        error: true,
        duration: 5000
      });
    } finally {
      state.busy = false;
    }
  }

  window.__translateSwitch = { toggle, state };
  toggle();
})();
