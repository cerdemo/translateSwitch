// Translate Switch - shared "word origin" gloss helpers.
//
// Exposed as globalThis.TSGloss so it can be reused by both the injected
// content script (classic script) and the PDF viewer (which loads this via a
// <script> tag before its module). The built-in Translator API gives no
// alignment, so to map a translated word back to its source we back-translate
// the word (target -> source) on-device and fuzzy-locate it in the known
// source text.

(() => {
  "use strict";

  if (globalThis.TSGloss) return; // idempotent (content script re-injection)

  // -------------------------------------------------------- translator cache
  const translatorCache = new Map(); // "src|tgt" -> Promise<Translator|null>

  function getTranslator(src, tgt) {
    if (!src || !tgt || src === tgt) return Promise.resolve(null);
    const key = `${src}|${tgt}`;
    if (translatorCache.has(key)) return translatorCache.get(key);

    const promise = (async () => {
      if (!("Translator" in self)) return null;
      const options = { sourceLanguage: src, targetLanguage: tgt };
      let availability;
      try {
        availability = await Translator.availability(options);
      } catch (e) {
        return null;
      }
      if (availability === "unavailable") return null;
      try {
        return await Translator.create(options);
      } catch (e) {
        return null;
      }
    })();

    translatorCache.set(key, promise);
    // Don't cache failures/"not ready yet" forever: drop the entry so a later
    // lookup retries once the model has finished downloading.
    promise
      .then((t) => {
        if (!t) translatorCache.delete(key);
      })
      .catch(() => translatorCache.delete(key));
    return promise;
  }

  // ------------------------------------------------------------ back-translate
  const backCache = new Map(); // "from|to|text" -> Promise<string|null>

  function backTranslate(text, fromLang, toLang) {
    const trimmed = (text || "").trim();
    if (!trimmed) return Promise.resolve(null);
    const key = `${fromLang}|${toLang}|${trimmed.toLowerCase()}`;
    if (backCache.has(key)) return backCache.get(key);

    const promise = (async () => {
      const translator = await getTranslator(fromLang, toLang);
      if (!translator) return null;
      try {
        const out = await translator.translate(trimmed);
        return (out || "").trim() || null;
      } catch (e) {
        return null;
      }
    })();

    backCache.set(key, promise);
    return promise;
  }

  // ------------------------------------------------------------- text helpers
  function normalize(s) {
    return (s || "")
      .normalize("NFC")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  // Strip surrounding (but not intra-word) punctuation from a single token.
  function normalizeToken(s) {
    return (s || "")
      .normalize("NFC")
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/[^\p{L}\p{N}]+$/u, "");
  }

  function tokenize(text) {
    const tokens = [];
    const re = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
    let m;
    while ((m = re.exec(text)) !== null) {
      tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }
    return tokens;
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    const al = a.length;
    const bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    let prev = new Array(bl + 1);
    let cur = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) prev[j] = j;
    for (let i = 1; i <= al; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= bl; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const tmp = prev;
      prev = cur;
      cur = tmp;
    }
    return prev[bl];
  }

  function similarity(a, b) {
    if (!a && !b) return 1;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshtein(a, b) / maxLen;
  }

  // Find the span in sourceText that best corresponds to backText.
  // Returns { start, end, text, approximate, score } or null.
  function locate(backText, sourceText, opts = {}) {
    const threshold = opts.threshold == null ? 0.55 : opts.threshold;
    // Normalize the back-translation through the same token pipeline used for
    // candidates so surrounding punctuation never skews the similarity score.
    const backTokens = tokenize(backText)
      .map((t) => normalizeToken(t.text))
      .filter(Boolean);
    const normBack = backTokens.join(" ");
    if (!normBack || !sourceText) return null;

    const tokens = tokenize(sourceText);
    if (!tokens.length) return null;
    const normTokens = tokens.map((t) => normalizeToken(t.text));

    const wordCount = backTokens.length;
    const windowSizes = new Set(
      [wordCount, wordCount + 1, Math.max(1, wordCount - 1)].filter((n) => n >= 1)
    );
    // backText and sourceText are the same language, so literal token overlap is
    // a dependable signal. We use it to break ties between windows that score
    // equally on character similarity (e.g. a word repeated across the page).
    const backCounts = new Map();
    for (const t of backTokens) backCounts.set(t, (backCounts.get(t) || 0) + 1);

    let best = null;
    for (const w of windowSizes) {
      for (let i = 0; i + w <= tokens.length; i++) {
        const candTokens = normTokens.slice(i, i + w);
        const candidate = candTokens.join(" ");
        if (!candidate) continue;
        const score = similarity(candidate, normBack);

        const seen = new Map();
        let overlap = 0;
        for (const ct of candTokens) {
          const cap = backCounts.get(ct) || 0;
          const used = seen.get(ct) || 0;
          if (used < cap) {
            overlap++;
            seen.set(ct, used + 1);
          }
        }
        const overlapRatio = overlap / Math.max(candTokens.length, wordCount);

        const better =
          !best ||
          score > best.score + 1e-9 ||
          (Math.abs(score - best.score) <= 1e-9 && overlapRatio > best.overlap);
        if (better) {
          best = {
            score,
            overlap: overlapRatio,
            start: tokens[i].start,
            end: tokens[i + w - 1].end
          };
        }
        if (score >= 0.999 && overlapRatio >= 1) break;
      }
      if (best && best.score >= 0.999 && best.overlap >= 1) break;
    }

    if (!best || best.score < threshold) return null;
    return {
      start: best.start,
      end: best.end,
      text: sourceText.slice(best.start, best.end),
      approximate: best.score < 0.999,
      score: best.score
    };
  }

  // ----------------------------------------------------- word/selection at point
  function isWordChar(ch) {
    return /[\p{L}\p{N}_'’\-]/u.test(ch);
  }

  function wordRangeFromCaret(node, offset) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const text = node.nodeValue || "";
    if (!text) return null;
    let start = Math.max(0, Math.min(offset, text.length));
    let end = start;
    while (start > 0 && isWordChar(text[start - 1])) start--;
    while (end < text.length && isWordChar(text[end])) end++;
    if (start >= end) return null;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return { text: text.slice(start, end), range, node, start, end };
  }

  // Returns { text, range, node, start, end } for the word/selection at (x, y),
  // or null. A non-collapsed selection takes priority (multi-word phrases).
  function wordAtPoint(x, y) {
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed) {
      const selected = sel.toString().trim();
      if (selected) {
        let range = null;
        try {
          range = sel.getRangeAt(0);
        } catch (e) {
          range = null;
        }
        const node = range ? range.startContainer : null;
        return { text: selected, range, node, start: null, end: null };
      }
    }

    let node = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) {
        node = pos.offsetNode;
        offset = pos.offset;
      }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) {
        node = r.startContainer;
        offset = r.startOffset;
      }
    }
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    return wordRangeFromCaret(node, offset);
  }

  // ------------------------------------------------ looked-up word logging
  // Records each successful origin lookup in chrome.storage.local so the popup
  // can show the most frequently looked-up words. Entries are keyed by the
  // language pair + the selected term (case-insensitive).
  const LOOKUP_KEY = "wordLookups";
  const LOOKUP_CAP = 2000;

  function logLookup(entry) {
    try {
      if (!entry || !entry.term) return;
      const term = entry.term.trim();
      if (!term || term.length > 80) return;
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
        return;
      }
      const src = entry.src || "";
      const tgt = entry.tgt || "";
      const key = `${tgt}|${src}|${term.toLowerCase()}`;
      chrome.storage.local.get({ [LOOKUP_KEY]: {} }, (res) => {
        const map = (res && res[LOOKUP_KEY]) || {};
        const now = Date.now();
        const cur = map[key] || {
          term,
          origin: entry.origin || "",
          src,
          tgt,
          count: 0,
          first: now
        };
        cur.count += 1;
        cur.last = now;
        cur.term = term;
        if (entry.origin) cur.origin = entry.origin;
        map[key] = cur;

        const keys = Object.keys(map);
        if (keys.length > LOOKUP_CAP) {
          keys.sort(
            (a, b) =>
              map[a].count - map[b].count || (map[a].last || 0) - (map[b].last || 0)
          );
          for (let i = 0; i < keys.length - LOOKUP_CAP; i++) delete map[keys[i]];
        }
        chrome.storage.local.set({ [LOOKUP_KEY]: map });
      });
    } catch (e) {
      /* logging is best-effort */
    }
  }

  globalThis.TSGloss = {
    LOOKUP_KEY,
    getTranslator,
    backTranslate,
    normalize,
    normalizeToken,
    tokenize,
    similarity,
    locate,
    wordAtPoint,
    logLookup
  };
})();
