# Translate Switch

A `Google Chrome extension that toggles any web page between its
**original text** and a **chosen translation language** with a single keyboard
shortcut. Press once to translate, press again to switch back — instantly.

## Why a workaround?

Chrome's native "Translate this page" bar has **no public API** that lets an
extension trigger it programmatically (there is only an open standards proposal,
nothing shipped). So this extension performs the translation itself using a
**built-in mechanism**:

1. **Primary:** Chrome's built-in, on-device [`Translator` API](https://developer.chrome.com/docs/ai/translator-api)
   (Chrome 138+, desktop). Private, offline-capable, no API keys.
2. **Fallback:** if the built-in API is unavailable, it injects the Google
   Translate widget to translate the page.

The first translation walks the page's text, translates it, and caches both the
original and translated strings per text node. Every toggle after that just
swaps cached text, so it is instant.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. (Optional) Pin the extension so you can open its popup.

## Usage

- Open any page and press **Ctrl + Shift + E** (macOS: **Cmd + Shift + E**).
  This combo is reachable with one hand.
- Press again to switch back to the original. Toggle as many times as you like.
- The page's language is auto-detected and translated into the **other** side of
  your language pair. The default pair is **English <-> Norwegian**, so a
  Norwegian page becomes English and an English page becomes Norwegian.
- Open the popup (toolbar icon) to:
  - set the **language pair** (Language A / Language B),
  - **toggle the current page** with a button,
  - jump to Chrome's shortcut settings.

### Translating PDFs

Chrome renders PDFs with its internal PDFium plugin, whose text is unreachable
by normal page scripts, so PDFs use a dedicated viewer.

- While viewing a PDF, press the **shortcut** (or click **Toggle this page** in
  the popup). The extension opens a **side-by-side viewer** in a new tab: the
  rendered PDF page on the left, its translated text on the right.
- Use the **Original / Translated** switch in the viewer's toolbar to flip the
  text pane between the extracted original text and the translation.
- Pages are rendered and translated **as you scroll**, and results are cached so
  switching is instant.
- **Local PDFs** (`file://`) work too, but you must enable
  **"Allow access to file URLs"** on the extension's details page
  (`chrome://extensions` -> Translate Switch -> Details).
- The same language pair and on-device models are used as for web pages.

### See a word's origin (back-translation gloss)

When you are reading translated text, you can check where a word came from:

- **Select** a translated word or phrase with the mouse (double-click a word, or
  click-drag a phrase).
  - On a **web page**, a tooltip shows the **original word** in the source
    language.
  - In a **PDF**, the matching word(s) are also **highlighted on the original
    page** in the left column.
- Example: on the English translation of a Norwegian page, selecting
  "care responsibility" reveals it came from **"omsorgsansvar"**.
- How it works: the built-in translator returns no word alignment, so the
  extension **back-translates** the hovered word on-device (target -> source)
  and fuzzy-matches it against the known source text. Approximate matches are
  prefixed with "≈".
- This needs the **reverse-direction** model (e.g. both `en -> no` and
  `no -> en`). The popup's "Download translation models" prepares both
  directions of your pair.
- It works only on **built-in-translated** content (not the Google Translate
  fallback) and only while the **translation** is shown.

### Word frequency (vocabulary you look up)

Every successful origin lookup is recorded locally (in `chrome.storage.local`).
Open the popup and click **Word frequency** to see your **most frequently
looked-up words** ranked by count, each shown as `selected word -> origin` with a
"last seen" time. This is meant as a personal study aid.

- **Direction** toggles the display between `Translated -> Origin` and
  `Origin -> Translated`.
- **Export CSV** downloads the full history (term, origin, source, target,
  count, first/last seen) for use in a spreadsheet or flashcard app.
- **Clear history** resets the list.

The list never leaves your device.

## Requirements

- **Chrome 138+ on desktop** (Windows, macOS, Linux, ChromeOS) for the built-in
  engine. The API does not exist on mobile.
- On first use of a language pair, Chrome must **download a small on-device
  model**. Chrome only allows this download during a genuine click, so open the
  **extension popup and click "Download translation models"** once. The popup
  shows this button automatically and reports progress. After the download the
  keyboard shortcut works without any further prompts (the model is shared
  across all pages).
- If your build doesn't expose the API yet, enable these at `chrome://flags` and
  restart Chrome:
  - `#translation-api` (or `#language-detection-api` on newer builds)
  - `#optimization-guide-on-device-model`
- When the built-in engine is unavailable, the **Google Translate fallback** is
  used automatically. Some sites with a strict Content Security Policy may block
  the fallback widget; in that case the built-in engine is required.

## Change the shortcut

Go to `chrome://extensions/shortcuts` (or click "Change keyboard shortcut" in
the popup) and rebind **Toggle the page between original and translated**.

## Change the language

Open the popup and set **Language A** and **Language B** (default English and
Norwegian). The extension auto-detects the page language and translates into
whichever side of the pair it is not (falling back to Language A if the page is
in neither). The pair is saved with `chrome.storage.sync`, so it follows your
Chrome profile.

## How it works

```
Shortcut ──> background.js ──(chrome.scripting)──> content.js (active tab)
                                                      │
                          ┌───────────────────────────┴───────────────────────────┐
                          │ first run                                               │ later runs
                          ▼                                                         ▼
   detect source + translate visible text nodes,                      swap cached original/translated
   cache {original, translated} per node                              text (instant), no re-translation
```

- `manifest.json` — MV3 config, the `toggle-translate` command, popup, and
  permissions (`scripting`, `activeTab`, `storage`, plus `host_permissions` for
  fetching PDF bytes).
- `background.js` — listens for the shortcut. For normal pages it injects
  `content.js` into the active tab (idempotent: re-injection just toggles). For
  PDFs it opens the bundled PDF viewer instead.
- `content.js` — text-node collection, language detection, translation, instant
  cached toggling, the Google Translate fallback, and an on-page status toast.
- `popup.html` / `popup.js` — target language selection, quick actions, and the
  word-frequency view of your looked-up words.
- `pdf/viewer.html` / `pdf/viewer.css` / `pdf/viewer.js` — side-by-side PDF
  viewer: PDF.js renders each page (left) and translates its extracted text
  (right), with an Original/Translated toggle, lazy cached per-page work, and the
  selection word-origin gloss (highlight boxes overlaid on the original page).
- `gloss.js` — shared word-origin helpers (`globalThis.TSGloss`): on-device
  back-translation cache, fuzzy source location, and word/selection hit-testing.
  Used by both `content.js` (injected before it) and the PDF viewer.
- `vendor/pdfjs/` — bundled [PDF.js](https://mozilla.github.io/pdf.js/) build
  (no remote code, as required by MV3).

## Limitations

- Dynamically loaded content is translated as of the moment you toggle; new
  content added afterward keeps its original language until you toggle again.
- Very large pages take longer on first translation (text is translated
  sequentially); subsequent toggles remain instant.
- The fallback widget relies on Google's public service and the page's CSP.
- **PDFs:** scanned/image-only PDFs have no text layer and can't be translated
  (no OCR). The translated text is reflowed, not pixel-aligned to the original
  lines, and auth-gated PDFs may fail to load if cookies aren't sent. The PDF
  viewer requires the built-in `Translator` API (no Google fallback).
- **Word origin:** the mapping is a back-translation estimate, so it can differ
  from the literal source for idioms or function words (such cases are flagged
  with "≈"). It needs the reverse-direction model and works only on
  built-in-translated content, not the Google fallback or scanned PDFs.
