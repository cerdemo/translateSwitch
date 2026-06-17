// Translate Switch - background service worker.
// Injects the content script into the active tab on the keyboard shortcut.
// The content script is idempotent: re-injecting it simply toggles the page.

const RESTRICTED_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "about:",
  "https://chromewebstore.google.com",
  "https://chrome.google.com/webstore"
];

function isInjectable(url) {
  if (!url) return false;
  return !RESTRICTED_PREFIXES.some((p) => url.startsWith(p));
}

// A PDF can't be translated like an HTML page (its text lives inside the
// PDFium plugin and is unreachable by content scripts). We detect PDFs and
// open our own PDF.js-based viewer instead.
function isPdfByExtension(url) {
  try {
    const u = new URL(url);
    if (!["http:", "https:", "file:"].includes(u.protocol)) return false;
    return /\.pdf$/i.test(u.pathname);
  } catch (e) {
    return false;
  }
}

async function looksLikePdf(url) {
  if (!url) return false;
  if (isPdfByExtension(url)) return true;
  // Extensionless URLs: probe the content type (http/https only).
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const resp = await fetch(url, { method: "HEAD" });
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    return ct.includes("application/pdf");
  } catch (e) {
    return false;
  }
}

function openPdfViewer(tab, fileUrl) {
  const viewer =
    chrome.runtime.getURL("pdf/viewer.html") +
    "?file=" +
    encodeURIComponent(fileUrl);
  chrome.tabs.create({
    url: viewer,
    index: typeof tab.index === "number" ? tab.index + 1 : undefined
  });
}

async function toggleActiveTab(tab) {
  if (!tab || !tab.id || !tab.url) return;

  if (await looksLikePdf(tab.url)) {
    openPdfViewer(tab, tab.url);
    return;
  }

  if (!isInjectable(tab.url)) {
    console.warn("Translate Switch: cannot run on this page:", tab.url);
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: ["content.js"]
    });
  } catch (err) {
    console.error("Translate Switch: injection failed", err);
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translate") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await toggleActiveTab(tab);
});

// Allow the popup to trigger a toggle on the active tab.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "toggle-active-tab") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      toggleActiveTab(tab).then(() => sendResponse({ ok: true }));
    });
    return true; // async response
  }
});
