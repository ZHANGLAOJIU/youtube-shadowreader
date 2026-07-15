"use strict";

const YOUTUBE_ORIGIN = "https://www.youtube.com";

async function openReaderForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith(`${YOUTUBE_ORIGIN}/watch`)) return false;

  await chrome.windows.create({
    url: chrome.runtime.getURL(`reader.html?tabId=${tab.id}`),
    type: "popup",
    width: 1200,
    height: 820
  });
  return true;
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-reader") openReaderForActiveTab().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "reader-on-chrome:fetch-text") {
    return false;
  }

  let url;
  try {
    url = new URL(message.url);
  } catch {
    sendResponse({ ok: false, status: 0, error: "Invalid URL" });
    return false;
  }

  if (url.origin !== YOUTUBE_ORIGIN) {
    sendResponse({ ok: false, status: 0, error: "Blocked non-YouTube URL" });
    return false;
  }

  fetch(url.href, {
    credentials: message.credentials === "omit" ? "omit" : "include",
    headers: {
      Accept: message.accept || "*/*",
      "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8"
    }
  })
    .then(async (response) => {
      sendResponse({
        ok: response.ok,
        status: response.status,
        text: await response.text()
      });
    })
    .catch((error) => {
      sendResponse({ ok: false, status: 0, error: String(error) });
    });

  return true;
});
