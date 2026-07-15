(function startReaderOnChrome() {
  "use strict";

  const core = globalThis.ReaderCaptionCore;
  const DEFAULT_SETTINGS = {
    enabled: true,
    displayMode: "bilingual",
    fontSize: 28,
    bottomPercent: 13,
    backgroundOpacity: 0.72
  };
  const CACHE_DB = "reader-on-chrome";
  const CACHE_STORE = "caption-timelines";
  const CACHE_VERSION = 1;
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  const state = {
    videoId: "",
    generation: 0,
    settings: { ...DEFAULT_SETTINGS },
    sentences: [],
    activeIndex: -1,
    activeWordIndex: -1,
    video: null,
    root: null,
    englishLine: null,
    chineseLine: null,
    status: null,
    frame: 0,
    lastUrl: location.href
  };

  function videoIdFromUrl() {
    const url = new URL(location.href);
    return url.pathname === "/watch" ? url.searchParams.get("v") || "" : "";
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  async function fetchText(
    url,
    accept,
    attempts = 4,
    credentials = "include"
  ) {
    let lastError = new Error("Caption request failed");
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await runtimeMessage({
        type: "reader-on-chrome:fetch-text",
        url,
        accept,
        credentials
      });
      if (response?.ok && response.text?.trim()) return response.text;
      lastError = new Error(
        response?.status === 429
          ? "YouTube 字幕请求过于频繁"
          : response?.ok
            ? "YouTube 暂时返回了空字幕"
          : response?.error || `YouTube HTTP ${response?.status || 0}`
      );
      if (!response?.ok && response?.status !== 429 && response?.status < 500) {
        break;
      }
      await sleep(1000 * 2 ** attempt);
    }
    throw lastError;
  }

  function requestPlayerResponseFromPage(timeoutMs = 800) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let timer = 0;

      function onResponse(event) {
        if (event.detail?.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener(
          "reader-on-chrome:player-response",
          onResponse
        );
        try {
          resolve(event.detail.payload ? JSON.parse(event.detail.payload) : null);
        } catch {
          resolve(null);
        }
      }

      window.addEventListener("reader-on-chrome:player-response", onResponse);
      window.dispatchEvent(
        new CustomEvent("reader-on-chrome:request-player-response", {
          detail: { requestId }
        })
      );
      timer = setTimeout(() => {
        window.removeEventListener(
          "reader-on-chrome:player-response",
          onResponse
        );
        resolve(null);
      }, timeoutMs);
    });
  }

  async function loadPlayerResponse(videoId) {
    const fromPage = await requestPlayerResponseFromPage();
    const pageVideoId = fromPage?.videoDetails?.videoId;
    if (fromPage && (!pageVideoId || pageVideoId === videoId)) return fromPage;

    const html = await fetchText(
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      "text/html"
    );
    return core.extractAssignedJson(html);
  }

  function loadFallbackPlayerResponse(videoId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let timer = 0;

      function onResponse(event) {
        if (event.detail?.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener(
          "reader-on-chrome:fallback-player-response",
          onResponse
        );
        if (event.detail.error) {
          reject(new Error(event.detail.error));
          return;
        }
        try {
          resolve(JSON.parse(event.detail.payload));
        } catch {
          reject(new Error("YouTube 备用字幕响应无效"));
        }
      }

      window.addEventListener(
        "reader-on-chrome:fallback-player-response",
        onResponse
      );
      window.dispatchEvent(
        new CustomEvent(
          "reader-on-chrome:request-fallback-player-response",
          { detail: { requestId, videoId } }
        )
      );
      timer = setTimeout(() => {
        window.removeEventListener(
          "reader-on-chrome:fallback-player-response",
          onResponse
        );
        reject(new Error("YouTube 备用字幕请求超时"));
      }, timeoutMs);
    });
  }

  function openCache() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB, CACHE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CACHE_STORE)) {
          database.createObjectStore(CACHE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function cacheGet(key) {
    try {
      const database = await openCache();
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(CACHE_STORE, "readonly");
        const request = transaction.objectStore(CACHE_STORE).get(key);
        request.onsuccess = () => {
          const value = request.result;
          if (!value || Date.now() - value.savedAt > CACHE_TTL_MS) resolve(null);
          else resolve(value);
        };
        request.onerror = () => reject(request.error);
      });
    } catch {
      return null;
    }
  }

  async function cachePut(key, sentences, source) {
    try {
      const database = await openCache();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(CACHE_STORE, "readwrite");
        transaction.objectStore(CACHE_STORE).put({
          key,
          savedAt: Date.now(),
          source,
          sentences
        });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
    } catch {
      // Subtitle caching is an optimization; playback must still work without it.
    }
  }

  function ensureOverlay() {
    const player = document.querySelector("#movie_player");
    if (!player) return false;

    if (state.root && state.root.parentElement !== player) {
      state.root.remove();
      state.root = null;
    }
    if (state.root) return true;

    const root = document.createElement("div");
    root.id = "reader-on-chrome-root";
    root.innerHTML = `
      <div class="roc-status" role="status"></div>
      <div class="roc-caption-card" aria-live="off">
        <div class="roc-caption roc-caption-en" lang="en"></div>
        <div class="roc-caption roc-caption-zh" lang="zh-CN"></div>
      </div>
    `;
    player.appendChild(root);
    state.root = root;
    state.status = root.querySelector(".roc-status");
    state.englishLine = root.querySelector(".roc-caption-en");
    state.chineseLine = root.querySelector(".roc-caption-zh");
    applySettings();
    return true;
  }

  function applySettings() {
    if (!state.root) return;
    state.root.style.setProperty("--roc-font-size", `${state.settings.fontSize}px`);
    state.root.style.setProperty(
      "--roc-bottom",
      `${state.settings.bottomPercent}%`
    );
    state.root.style.setProperty(
      "--roc-background-opacity",
      String(state.settings.backgroundOpacity)
    );
    state.root.dataset.mode = state.settings.displayMode;
    state.root.hidden = !state.settings.enabled;
  }

  function setStatus(message, kind = "info") {
    if (!ensureOverlay()) return;
    state.status.textContent = message;
    state.status.dataset.kind = kind;
    state.status.hidden = !message;
  }

  function clearCaption() {
    if (state.englishLine) state.englishLine.textContent = "";
    if (state.chineseLine) state.chineseLine.textContent = "";
    if (state.root) {
      state.root.dataset.active = "false";
      state.root.dataset.translationAvailable = "false";
    }
    state.activeIndex = -1;
    state.activeWordIndex = -1;
  }

  async function loadTimeline(videoId, generation) {
    setStatus("正在读取 YouTube 字幕…");
    clearCaption();

    try {
      const playerResponse = await loadPlayerResponse(videoId);
      if (generation !== state.generation) return;
      let config = core.captionConfig(playerResponse);
      let usingFallbackTrack = false;
      if (!config?.englishTrack) {
        const fallbackPlayerResponse = await loadFallbackPlayerResponse(videoId);
        config = core.captionConfig(fallbackPlayerResponse);
        usingFallbackTrack = true;
      }
      if (!config?.englishTrack) {
        state.sentences = [];
        setStatus("这个视频没有可用的英文字幕", "warning");
        return;
      }

      const cacheKey = [
        "v4",
        videoId,
        config.englishTrack.vssId || config.englishTrack.languageCode || "en",
        config.supportsSimplifiedChinese ? "zh-Hans" : "en-only"
      ].join(":");
      const cached = await cacheGet(cacheKey);
      if (generation !== state.generation) return;
      if (cached?.sentences?.length) {
        state.sentences = cached.sentences;
        setStatus(
          `${cached.sentences.length} 句 · ${cached.source} · 已缓存`,
          "success"
        );
        return;
      }

      let englishText;
      try {
        englishText = await fetchText(
          core.captionUrl(config.englishTrack),
          "application/json",
          usingFallbackTrack ? 4 : 1,
          usingFallbackTrack ? "omit" : "include"
        );
      } catch (webCaptionError) {
        if (usingFallbackTrack) throw webCaptionError;
        const fallbackPlayerResponse = await loadFallbackPlayerResponse(videoId);
        const fallbackConfig = core.captionConfig(fallbackPlayerResponse);
        if (!fallbackConfig?.englishTrack) throw webCaptionError;
        config = fallbackConfig;
        usingFallbackTrack = true;
        englishText = await fetchText(
          core.captionUrl(config.englishTrack),
          "application/json",
          4,
          "omit"
        );
      }
      if (generation !== state.generation) return;
      let englishPayload = JSON.parse(englishText);
      let englishCues = core.parseJson3(englishPayload);
      let sentences = core.mergeIntoSentences(englishCues);
      let source = "YouTube 英文";

      if (config.supportsSimplifiedChinese) {
        try {
          const chineseText = await fetchText(
            core.captionUrl(config.englishTrack, "zh-Hans"),
            "application/json",
            4,
            usingFallbackTrack ? "omit" : "include"
          );
          const chineseCues = core.parseJson3(JSON.parse(chineseText));
          sentences = core.buildBilingualSentences(englishCues, chineseCues);
          source = "YouTube 中英双语";
        } catch (error) {
          let fallbackSucceeded = false;
          if (!usingFallbackTrack) {
            try {
              const fallbackPlayerResponse =
                await loadFallbackPlayerResponse(videoId);
              const fallbackConfig = core.captionConfig(fallbackPlayerResponse);
              if (!fallbackConfig?.englishTrack) throw error;
              const fallbackEnglishText = await fetchText(
                core.captionUrl(fallbackConfig.englishTrack),
                "application/json",
                4,
                "omit"
              );
              const fallbackChineseText = await fetchText(
                core.captionUrl(fallbackConfig.englishTrack, "zh-Hans"),
                "application/json",
                4,
                "omit"
              );
              englishPayload = JSON.parse(fallbackEnglishText);
              englishCues = core.parseJson3(englishPayload);
              const chineseCues = core.parseJson3(
                JSON.parse(fallbackChineseText)
              );
              sentences = core.buildBilingualSentences(
                englishCues,
                chineseCues
              );
              config = fallbackConfig;
              usingFallbackTrack = true;
              source = "YouTube 中英双语";
              fallbackSucceeded = true;
            } catch (fallbackError) {
              console.warn(
                "Reader on Chrome: Chinese fallback unavailable",
                fallbackError
              );
            }
          }
          if (!fallbackSucceeded) {
            source = "YouTube 英文（中文轨道暂时不可用）";
            console.warn("Reader on Chrome: Chinese captions unavailable", error);
          }
        }
      }

      let timedWords = core.parseJson3WordTimings(englishPayload);
      if (!timedWords.length) {
        const timingTrack = core.wordTimingTrack(config);
        if (timingTrack && timingTrack !== config.englishTrack) {
          try {
            const timingText = await fetchText(
              core.captionUrl(timingTrack),
              "application/json",
              usingFallbackTrack ? 4 : 1,
              usingFallbackTrack ? "omit" : "include"
            );
            timedWords = core.parseJson3WordTimings(JSON.parse(timingText));
          } catch (error) {
            console.warn(
              "Reader on Chrome: automatic word timing unavailable",
              error
            );
          }
        }
      }
      sentences = core.attachWordTimings(sentences, timedWords);
      if (sentences.some((sentence) => sentence.words?.length)) {
        source += " · 逐词同步";
      }

      if (generation !== state.generation) return;
      state.sentences = sentences;
      if (!source.includes("中文轨道暂时不可用")) {
        await cachePut(cacheKey, sentences, source);
      }
      setStatus(`${sentences.length} 句 · ${source}`, "success");
    } catch (error) {
      if (generation !== state.generation) return;
      state.sentences = [];
      setStatus(error.message || "字幕读取失败", "error");
      console.error("Reader on Chrome: timeline load failed", error);
    }
  }

  function renderActiveSentence() {
    if (!state.settings.enabled || !state.video || !state.sentences.length) {
      clearCaption();
      return;
    }

    const player = document.querySelector("#movie_player");
    if (player?.classList.contains("ad-showing")) {
      clearCaption();
      return;
    }

    const currentTimeMs = state.video.currentTime * 1000;
    const index = core.activeSentenceIndex(
      state.sentences,
      currentTimeMs
    );
    const sentence = index >= 0 ? state.sentences[index] : null;
    const activeWordIndex = sentence?.words?.length
      ? core.activeWordIndex(sentence.words, currentTimeMs)
      : -1;
    if (
      index === state.activeIndex &&
      activeWordIndex === state.activeWordIndex
    ) {
      return;
    }
    state.activeIndex = index;
    state.activeWordIndex = activeWordIndex;
    if (sentence?.words?.length) {
      const fragment = document.createDocumentFragment();
      sentence.words.forEach((word, wordIndex) => {
        const span = document.createElement("span");
        span.className = "roc-word";
        if (wordIndex === activeWordIndex) span.dataset.active = "true";
        span.textContent = word.text;
        fragment.append(span, document.createTextNode(" "));
      });
      state.englishLine.replaceChildren(fragment);
    } else {
      state.englishLine.textContent = sentence?.text || "";
    }
    state.chineseLine.textContent = sentence?.translation || "";
    state.root.dataset.translationAvailable = String(
      Boolean(sentence?.translation)
    );
    state.root.dataset.active = sentence ? "true" : "false";
  }

  function animationLoop() {
    if (!ensureOverlay()) {
      state.frame = requestAnimationFrame(animationLoop);
      return;
    }
    const video = document.querySelector("video.html5-main-video");
    if (video !== state.video) state.video = video;
    renderActiveSentence();
    state.frame = requestAnimationFrame(animationLoop);
  }

  function companionSnapshot(includeSentences = false) {
    const video = state.video || document.querySelector("video.html5-main-video");
    const currentTimeMs = Math.max(0, Number(video?.currentTime || 0) * 1000);
    const activeIndex = state.sentences.length
      ? core.activeSentenceIndex(state.sentences, currentTimeMs)
      : -1;
    const pageTitle =
      document.querySelector("h1 yt-formatted-string")?.textContent?.trim() ||
      document.title.replace(/\s*-\s*YouTube\s*$/i, "");
    const snapshot = {
      ok: Boolean(state.videoId),
      videoId: state.videoId,
      generation: state.generation,
      title: pageTitle,
      url: location.href,
      currentTimeMs,
      durationMs: Number.isFinite(video?.duration)
        ? Math.max(0, video.duration * 1000)
        : 0,
      paused: video?.paused ?? true,
      playbackRate: Number(video?.playbackRate || 1),
      activeIndex,
      sentenceCount: state.sentences.length,
      status: state.status?.textContent || ""
    };
    if (includeSentences) snapshot.sentences = state.sentences;
    return snapshot;
  }

  function seekVideo(timeMs) {
    const video = state.video || document.querySelector("video.html5-main-video");
    const targetMs = Number(timeMs);
    if (!video || !Number.isFinite(targetMs)) return false;
    const durationMs = Number.isFinite(video.duration)
      ? video.duration * 1000
      : targetMs;
    video.currentTime = Math.max(0, Math.min(targetMs, durationMs)) / 1000;
    return true;
  }

  function scheduleNavigationCheck() {
    setTimeout(() => {
      const videoId = videoIdFromUrl();
      if (videoId === state.videoId) return;
      state.videoId = videoId;
      state.generation += 1;
      state.sentences = [];
      clearCaption();
      if (!videoId) {
        if (state.root) state.root.hidden = true;
        return;
      }
      ensureOverlay();
      applySettings();
      loadTimeline(videoId, state.generation);
    }, 50);
  }

  function loadSettings() {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
      state.settings = { ...DEFAULT_SETTINGS, ...settings };
      applySettings();
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    for (const [key, change] of Object.entries(changes)) {
      if (key in DEFAULT_SETTINGS) state.settings[key] = change.newValue;
    }
    applySettings();
    renderActiveSentence();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "reader-on-chrome:reload") {
      state.generation += 1;
      if (state.videoId) loadTimeline(state.videoId, state.generation);
      return false;
    }

    if (message?.type === "reader-on-chrome:get-state") {
      sendResponse(companionSnapshot(true));
      return false;
    }

    if (message?.type === "reader-on-chrome:get-playback") {
      sendResponse(companionSnapshot(false));
      return false;
    }

    if (message?.type === "reader-on-chrome:seek") {
      sendResponse({ ok: seekVideo(message.timeMs) });
      return false;
    }

    if (message?.type === "reader-on-chrome:toggle-playback") {
      const video = state.video || document.querySelector("video.html5-main-video");
      if (!video) {
        sendResponse({ ok: false });
      } else if (video.paused) {
        video.play().catch(() => {});
        sendResponse({ ok: true, paused: false });
      } else {
        video.pause();
        sendResponse({ ok: true, paused: true });
      }
      return false;
    }

    return false;
  });

  document.addEventListener("yt-navigate-finish", scheduleNavigationCheck);
  window.addEventListener("popstate", scheduleNavigationCheck);
  setInterval(() => {
    if (location.href !== state.lastUrl) {
      state.lastUrl = location.href;
      scheduleNavigationCheck();
    }
  }, 1000);

  loadSettings();
  scheduleNavigationCheck();
  state.frame = requestAnimationFrame(animationLoop);
})();
