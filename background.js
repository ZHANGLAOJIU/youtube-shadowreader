"use strict";

const YOUTUBE_ORIGIN = "https://www.youtube.com";
const READER_URL = chrome.runtime.getURL("reader.html");
const READER_LINKS_KEY = "readerTabLinks";

async function readerLinks() {
  const stored = await chrome.storage.session.get(READER_LINKS_KEY);
  return stored[READER_LINKS_KEY] || {};
}

async function linkReaderTab(readerTabId, sourceTabId) {
  if (!Number.isInteger(readerTabId) || !Number.isInteger(sourceTabId)) return;
  const links = await readerLinks();
  links[readerTabId] = sourceTabId;
  await chrome.storage.session.set({ [READER_LINKS_KEY]: links });
}

async function unlinkTab(tabId) {
  const links = await readerLinks();
  let changed = false;
  for (const [readerTabId, sourceTabId] of Object.entries(links)) {
    if (Number(readerTabId) === tabId || sourceTabId === tabId) {
      delete links[readerTabId];
      changed = true;
    }
  }
  if (changed) await chrome.storage.session.set({ [READER_LINKS_KEY]: links });
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function linkedReaderTabs(windowId, sourceTabId = null) {
  const links = await readerLinks();
  const tabs = await Promise.all(
    Object.entries(links).map(async ([readerTabId, linkedSourceTabId]) => {
      if (sourceTabId !== null && linkedSourceTabId !== sourceTabId) return null;
      try {
        return await chrome.tabs.get(Number(readerTabId));
      } catch {
        return null;
      }
    })
  );
  return tabs.filter((tab) => tab?.windowId === windowId);
}

async function openPinnedReader(sourceTab) {
  const url = `${READER_URL}?tabId=${sourceTab.id}`;
  const readerTabs = await linkedReaderTabs(sourceTab.windowId, sourceTab.id);
  const [existing] = readerTabs;

  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, pinned: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    await linkReaderTab(existing.id, sourceTab.id);
    return { ok: true, created: false, tabId: existing.id };
  }

  const readerTab = await chrome.tabs.create({
    windowId: sourceTab.windowId,
    url,
    active: true,
    pinned: true,
    index: 0
  });
  await linkReaderTab(readerTab.id, sourceTab.id);
  return { ok: true, created: true, tabId: readerTab.id };
}

async function openReaderWindow(sourceTab) {
  const readerWindow = await chrome.windows.create({
    url: `${READER_URL}?tabId=${sourceTab.id}`,
    type: "popup",
    width: 1200,
    height: 820
  });
  const [readerTab] = await chrome.tabs.query({ windowId: readerWindow.id });
  await linkReaderTab(readerTab.id, sourceTab.id);
  return { ok: true, windowId: readerWindow.id, tabId: readerTab.id };
}

async function sourceTab(tabId) {
  const tab = await chrome.tabs.get(Number(tabId));
  return tab?.id && tab.url?.startsWith(`${YOUTUBE_ORIGIN}/watch`) ? tab : null;
}

async function toggleReaderForActiveTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return false;

  const links = await readerLinks();
  const linkedSourceTabId = links[activeTab.id];
  if (Number.isInteger(linkedSourceTabId)) {
    try {
      const linkedSourceTab = await chrome.tabs.get(linkedSourceTabId);
      await focusTab(linkedSourceTab);
      return true;
    } catch {
      return false;
    }
  }

  if (activeTab.url?.startsWith(`${YOUTUBE_ORIGIN}/watch`)) {
    await openPinnedReader(activeTab);
    return true;
  }

  const readerTabs = await linkedReaderTabs(activeTab.windowId);
  if (!readerTabs.length) return false;
  await focusTab(
    readerTabs.sort(
      (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)
    )[0]
  );
  return true;
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-reader") toggleReaderForActiveTab().catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  unlinkTab(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "reader-on-chrome:register-reader") {
    linkReaderTab(sender.tab?.id, Number(message.tabId))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (
    message?.type === "reader-on-chrome:open-reader-tab" ||
    message?.type === "reader-on-chrome:open-reader-window"
  ) {
    sourceTab(message.tabId)
      .then((tab) => {
        if (!tab) return { ok: false };
        return message.type === "reader-on-chrome:open-reader-window"
          ? openReaderWindow(tab)
          : openPinnedReader(tab);
      })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

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
