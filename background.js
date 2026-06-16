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

async function toggleActiveTab(tab) {
  if (!tab || !tab.id) return;
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
