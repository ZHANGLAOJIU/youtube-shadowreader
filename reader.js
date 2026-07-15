"use strict";

const sourceTabId = Number(new URL(location.href).searchParams.get("tabId"));
const captionCore = globalThis.ReaderCaptionCore;
const DEFAULT_SETTINGS = { displayMode: "bilingual" };
const POLL_INTERVAL_MS = 250;
let rateToastTimer = null;

chrome.runtime.sendMessage({
  type: "reader-on-chrome:register-reader",
  tabId: sourceTabId
});

const state = {
  sentences: [],
  activeIndex: -1,
  activeWordIndex: -1,
  videoId: "",
  generation: -1,
  durationMs: 0,
  paused: true,
  playbackRate: 1,
  playbackRateReady: false,
  connected: false,
  transcriptOpen: false,
  seeking: false,
  loadingFullState: false
};

const elements = {
  body: document.body,
  videoTitle: document.querySelector("#videoTitle"),
  connection: document.querySelector("#connection"),
  displayMode: document.querySelector("#displayMode"),
  themeToggle: document.querySelector("#themeToggle"),
  openVideo: document.querySelector("#openVideo"),
  transcriptToggle: document.querySelector("#transcriptToggle"),
  transcriptPanel: document.querySelector("#transcriptPanel"),
  transcriptClose: document.querySelector("#transcriptClose"),
  transcriptCount: document.querySelector("#transcriptCount"),
  transcriptList: document.querySelector("#transcriptList"),
  previousHint: document.querySelector("#previousHint"),
  nextHint: document.querySelector("#nextHint"),
  emptyMessage: document.querySelector("#emptyMessage"),
  englishText: document.querySelector("#englishText"),
  chineseText: document.querySelector("#chineseText"),
  previousButton: document.querySelector("#previousButton"),
  playButton: document.querySelector("#playButton"),
  nextButton: document.querySelector("#nextButton"),
  timeline: document.querySelector("#timeline"),
  currentTime: document.querySelector("#currentTime"),
  duration: document.querySelector("#duration"),
  rateValue: document.querySelector("#rateValue"),
  rateToast: document.querySelector("#rateToast"),
  sentenceCounter: document.querySelector("#sentenceCounter")
};

function tabMessage(message) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(sourceTabId)) {
      reject(new Error("缺少 YouTube 标签页"));
      return;
    }
    chrome.tabs.sendMessage(sourceTabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function formatTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

function formatPlaybackRate(rate) {
  return `${Number(rate).toFixed(2).replace(/\.00$/, "").replace(/0$/, "")}×`;
}

function showRateToast(rate) {
  clearTimeout(rateToastTimer);
  elements.rateToast.textContent = `速度 ${formatPlaybackRate(rate)}`;
  elements.rateToast.hidden = false;
  rateToastTimer = setTimeout(() => {
    elements.rateToast.hidden = true;
  }, 2000);
}

function setConnection(connected, message = "") {
  state.connected = connected;
  elements.connection.dataset.state = connected ? "connected" : "disconnected";
  elements.connection.textContent = message || (connected ? "已连接" : "连接中断");
}

function sentencePreview(sentence) {
  if (!sentence?.text) return "";
  return sentence.text.length > 100
    ? `${sentence.text.slice(0, 100)}…`
    : sentence.text;
}

function renderFocusedSentence() {
  const sentence = state.sentences[state.activeIndex] || null;
  const previous = state.sentences[state.activeIndex - 1] || null;
  const next = state.sentences[state.activeIndex + 1] || null;

  elements.emptyMessage.hidden = Boolean(sentence);
  elements.emptyMessage.textContent = state.sentences.length
    ? "字幕将在视频开始后显示"
    : "正在读取字幕…";
  elements.body.dataset.currentTranslation = String(
    Boolean(sentence?.translation)
  );
  if (sentence?.words?.length) {
    const fragment = document.createDocumentFragment();
    sentence.words.forEach((word, wordIndex) => {
      const span = document.createElement("span");
      span.className = "reader-word";
      if (wordIndex === state.activeWordIndex) span.dataset.active = "true";
      span.textContent = word.text;
      fragment.append(span, document.createTextNode(" "));
    });
    elements.englishText.replaceChildren(fragment);
  } else {
    elements.englishText.textContent = sentence?.text || "";
  }
  elements.chineseText.textContent = sentence?.translation || "";
  elements.previousHint.textContent = sentencePreview(previous);
  elements.nextHint.textContent = sentencePreview(next);
  elements.previousHint.disabled = !previous;
  elements.nextHint.disabled = !next;
  elements.previousButton.disabled = !previous;
  elements.nextButton.disabled = !next;
  elements.sentenceCounter.textContent = sentence
    ? `${state.activeIndex + 1} / ${state.sentences.length}`
    : `0 / ${state.sentences.length}`;

  document.querySelectorAll(".transcript-item[data-active='true']").forEach((item) => {
    item.dataset.active = "false";
  });
  const activeItem = elements.transcriptList.querySelector(
    `.transcript-item[data-index="${state.activeIndex}"]`
  );
  if (activeItem) {
    activeItem.dataset.active = "true";
    if (state.transcriptOpen) {
      activeItem.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

function renderTranscript() {
  const fragment = document.createDocumentFragment();
  state.sentences.forEach((sentence, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "transcript-item";
    button.dataset.index = String(index);
    button.dataset.active = "false";
    button.dataset.hasTranslation = String(Boolean(sentence.translation));

    const number = document.createElement("span");
    number.className = "transcript-index";
    number.textContent = String(index + 1);

    const copy = document.createElement("span");
    copy.className = "transcript-copy";
    const english = document.createElement("div");
    english.className = "transcript-en";
    english.lang = "en";
    english.textContent = sentence.text;
    const chinese = document.createElement("div");
    chinese.className = "transcript-zh";
    chinese.lang = "zh-CN";
    chinese.textContent = sentence.translation || "";
    copy.append(english, chinese);
    button.append(number, copy);
    fragment.appendChild(button);
  });
  elements.transcriptList.replaceChildren(fragment);
  elements.transcriptCount.textContent = `${state.sentences.length} 句`;
}

function updatePlayback(snapshot) {
  if (!snapshot?.ok) throw new Error("YouTube 标签页不可用");
  if (
    snapshot.videoId !== state.videoId ||
    snapshot.generation !== state.generation ||
    snapshot.sentenceCount !== state.sentences.length
  ) {
    loadFullState();
    return;
  }

  setConnection(true, snapshot.status || "已连接");
  state.durationMs = snapshot.durationMs || state.durationMs;
  state.paused = snapshot.paused;
  const playbackRate = snapshot.playbackRate || 1;
  if (
    state.playbackRateReady &&
    Math.abs(playbackRate - state.playbackRate) > 0.01
  ) {
    showRateToast(playbackRate);
  }
  state.playbackRate = playbackRate;
  state.playbackRateReady = true;
  elements.playButton.textContent = snapshot.paused ? "▶" : "Ⅱ";
  elements.rateValue.textContent = formatPlaybackRate(state.playbackRate);
  elements.currentTime.textContent = formatTime(snapshot.currentTimeMs);
  elements.duration.textContent = formatTime(state.durationMs);
  elements.timeline.max = String(Math.max(1, state.durationMs / 1000));
  if (!state.seeking) elements.timeline.value = String(snapshot.currentTimeMs / 1000);

  const activeSentence = state.sentences[snapshot.activeIndex];
  const activeWordIndex = activeSentence?.words?.length
    ? captionCore.activeWordIndex(
        activeSentence.words,
        snapshot.currentTimeMs
      )
    : -1;
  if (
    snapshot.activeIndex !== state.activeIndex ||
    activeWordIndex !== state.activeWordIndex
  ) {
    state.activeIndex = snapshot.activeIndex;
    state.activeWordIndex = activeWordIndex;
    renderFocusedSentence();
  }
}

async function loadFullState() {
  if (state.loadingFullState) return;
  state.loadingFullState = true;
  try {
    const snapshot = await tabMessage({ type: "reader-on-chrome:get-state" });
    if (!snapshot?.ok) throw new Error("请在 YouTube 普通视频页面打开伴读器");
    state.videoId = snapshot.videoId;
    state.generation = snapshot.generation;
    state.sentences = Array.isArray(snapshot.sentences) ? snapshot.sentences : [];
    state.activeIndex = snapshot.activeIndex;
    state.activeWordIndex = -1;
    state.durationMs = snapshot.durationMs || 0;
    state.paused = snapshot.paused;
    elements.videoTitle.textContent = snapshot.title || "YouTube 视频";
    document.title = `${snapshot.title || "YouTube"} · 伴读器`;
    renderTranscript();
    renderFocusedSentence();
    updatePlayback(snapshot);
  } catch (error) {
    setConnection(false, "等待 YouTube 标签页");
    elements.emptyMessage.hidden = false;
    elements.emptyMessage.textContent = error.message || "无法连接 YouTube";
  } finally {
    state.loadingFullState = false;
  }
}

async function pollPlayback() {
  try {
    const snapshot = await tabMessage({ type: "reader-on-chrome:get-playback" });
    updatePlayback(snapshot);
  } catch {
    setConnection(false, "连接中断，正在重试");
  }
}

async function seekToIndex(index) {
  const sentence = state.sentences[index];
  if (!sentence) return;
  await tabMessage({ type: "reader-on-chrome:seek", timeMs: sentence.startMs });
  state.activeIndex = index;
  state.activeWordIndex = -1;
  renderFocusedSentence();
}

function moveSentence(offset) {
  if (!state.sentences.length) return;
  const current = state.activeIndex >= 0 ? state.activeIndex : 0;
  seekToIndex(Math.max(0, Math.min(state.sentences.length - 1, current + offset)));
}

function setTranscriptOpen(open) {
  state.transcriptOpen = open;
  elements.transcriptPanel.dataset.open = String(open);
  elements.transcriptPanel.setAttribute("aria-hidden", String(!open));
  elements.transcriptToggle.setAttribute("aria-expanded", String(open));
  if (open) renderFocusedSentence();
}

elements.previousHint.addEventListener("click", () => moveSentence(-1));
elements.nextHint.addEventListener("click", () => moveSentence(1));
elements.previousButton.addEventListener("click", () => moveSentence(-1));
elements.nextButton.addEventListener("click", () => moveSentence(1));
elements.playButton.addEventListener("click", () => {
  tabMessage({ type: "reader-on-chrome:toggle-playback" }).catch(() => {});
});
elements.timeline.addEventListener("pointerdown", () => {
  state.seeking = true;
});
elements.timeline.addEventListener("input", () => {
  elements.currentTime.textContent = formatTime(Number(elements.timeline.value) * 1000);
});
elements.timeline.addEventListener("change", () => {
  tabMessage({
    type: "reader-on-chrome:seek",
    timeMs: Number(elements.timeline.value) * 1000
  }).catch(() => {});
  state.seeking = false;
});

elements.transcriptList.addEventListener("click", (event) => {
  const item = event.target.closest(".transcript-item");
  if (item) seekToIndex(Number(item.dataset.index));
});

elements.transcriptToggle.addEventListener("click", () => {
  setTranscriptOpen(!state.transcriptOpen);
});
elements.transcriptClose.addEventListener("click", () => setTranscriptOpen(false));

elements.openVideo.addEventListener("click", () => {
  chrome.tabs.get(sourceTabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    chrome.tabs.update(sourceTabId, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
  });
});

elements.displayMode.addEventListener("change", () => {
  const displayMode = elements.displayMode.value;
  elements.body.dataset.displayMode = displayMode;
  chrome.storage.sync.set({ displayMode });
});

elements.themeToggle.addEventListener("click", () => {
  const theme = elements.body.dataset.theme === "dark" ? "light" : "dark";
  elements.body.dataset.theme = theme;
  chrome.storage.local.set({ readerTheme: theme });
});

document.addEventListener("keydown", (event) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.code === "Space") {
    event.preventDefault();
    tabMessage({ type: "reader-on-chrome:toggle-playback" }).catch(() => {});
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    moveSentence(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    moveSentence(1);
  } else if (event.key === "Escape" && state.transcriptOpen) {
    setTranscriptOpen(false);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === sourceTabId) setConnection(false, "YouTube 标签页已关闭");
});

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  elements.displayMode.value = settings.displayMode;
  elements.body.dataset.displayMode = settings.displayMode;
});
chrome.storage.local.get({ readerTheme: "light" }, ({ readerTheme }) => {
  elements.body.dataset.theme = readerTheme;
});

loadFullState();
setInterval(pollPlayback, POLL_INTERVAL_MS);
