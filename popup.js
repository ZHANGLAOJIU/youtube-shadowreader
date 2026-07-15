"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  displayMode: "bilingual",
  fontSize: 28,
  bottomPercent: 13,
  backgroundOpacity: 0.72
};

const fields = Object.keys(DEFAULT_SETTINGS);

function updateOutputs() {
  document.querySelector("#fontSizeValue").textContent =
    `${document.querySelector("#fontSize").value}px`;
  document.querySelector("#bottomPercentValue").textContent =
    `${document.querySelector("#bottomPercent").value}%`;
  document.querySelector("#backgroundOpacityValue").textContent =
    `${Math.round(Number(document.querySelector("#backgroundOpacity").value) * 100)}%`;
}

function readField(field) {
  const element = document.querySelector(`#${field}`);
  if (element.type === "checkbox") return element.checked;
  if (element.type === "range") return Number(element.value);
  return element.value;
}

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  for (const field of fields) {
    const element = document.querySelector(`#${field}`);
    if (element.type === "checkbox") element.checked = settings[field];
    else element.value = String(settings[field]);
  }
  updateOutputs();
});

for (const field of fields) {
  document.querySelector(`#${field}`).addEventListener("input", () => {
    chrome.storage.sync.set({ [field]: readField(field) });
    updateOutputs();
  });
}

async function activeYouTubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id && tab.url?.startsWith("https://www.youtube.com/watch")
    ? tab
    : null;
}

document.querySelector("#openReader").addEventListener("click", async () => {
  const tab = await activeYouTubeTab();
  if (!tab) {
    document.querySelector("#popupStatus").textContent =
      "请先打开一个普通 YouTube 视频。";
    return;
  }

  chrome.runtime.sendMessage({
    type: "reader-on-chrome:open-reader-tab",
    tabId: tab.id
  });
  window.close();
});

document.querySelector("#openReaderWindow").addEventListener("click", async () => {
  const tab = await activeYouTubeTab();
  if (!tab) {
    document.querySelector("#popupStatus").textContent =
      "请先打开一个普通 YouTube 视频。";
    return;
  }

  chrome.runtime.sendMessage({
    type: "reader-on-chrome:open-reader-window",
    tabId: tab.id
  });
  window.close();
});

document.querySelector("#reload").addEventListener("click", async () => {
  const tab = await activeYouTubeTab();
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "reader-on-chrome:reload" });
  } else {
    document.querySelector("#popupStatus").textContent =
      "请先打开一个普通 YouTube 视频。";
    return;
  }
  window.close();
});
