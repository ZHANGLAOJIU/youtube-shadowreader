"use strict";

const ANDROID_VR_CLIENT = {
  clientName: "ANDROID_VR",
  clientVersion: "1.65.10",
  deviceMake: "Oculus",
  deviceModel: "Quest 3",
  androidSdkVersion: 32,
  userAgent:
    "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
  osName: "Android",
  osVersion: "12L",
  hl: "en",
  timeZone: "UTC",
  utcOffsetMinutes: 0
};

const capturedCaptionResponses = [];
const CAPTION_RESPONSE_LIMIT = 12;

// YouTube's initial caption URLs omit the dynamic PoToken used by the player.
// Capture only the player's own successful caption responses instead of
// replaying those incomplete URLs as the primary transport.
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function captionRequestDetails(value) {
  try {
    const url = new URL(String(value || ""), location.href);
    if (url.origin !== location.origin || url.pathname !== "/api/timedtext") {
      return null;
    }
    return {
      url: url.href,
      videoId: url.searchParams.get("v") || "",
      languageCode: url.searchParams.get("lang") || "",
      translationLanguage: url.searchParams.get("tlang") || ""
    };
  } catch {
    return null;
  }
}

function rememberCaptionResponse(value, status, text) {
  const details = captionRequestDetails(value);
  const payload = String(text || "").trim();
  if (
    !details?.videoId ||
    Number(status) !== 200 ||
    !payload.startsWith("{")
  ) {
    return;
  }

  const record = { ...details, text: payload, capturedAt: Date.now() };
  const matchingIndex = capturedCaptionResponses.findIndex(
    (item) =>
      item.videoId === record.videoId &&
      item.languageCode === record.languageCode &&
      item.translationLanguage === record.translationLanguage
  );
  if (matchingIndex >= 0) capturedCaptionResponses.splice(matchingIndex, 1);
  capturedCaptionResponses.push(record);
  if (capturedCaptionResponses.length > CAPTION_RESPONSE_LIMIT) {
    capturedCaptionResponses.splice(
      0,
      capturedCaptionResponses.length - CAPTION_RESPONSE_LIMIT
    );
  }
}

function capturedCaption(videoId, translationLanguage = "") {
  for (let index = capturedCaptionResponses.length - 1; index >= 0; index -= 1) {
    const item = capturedCaptionResponses[index];
    if (
      item.videoId === videoId &&
      item.languageCode.toLowerCase().startsWith("en") &&
      item.translationLanguage === translationLanguage
    ) {
      return item;
    }
  }
  return null;
}

async function waitForCapturedCaption(
  videoId,
  translationLanguage,
  timeoutMs
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = capturedCaption(videoId, translationLanguage);
    if (record) return record;
    await delay(100);
  }
  return null;
}

function installCaptionCapture() {
  const captionUrlKey = Symbol("reader-on-chrome-caption-url");
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(_method, value) {
    const details = captionRequestDetails(value);
    if (details) {
      this[captionUrlKey] = details.url;
      this.addEventListener(
        "loadend",
        () => {
          let text = "";
          try {
            if (!this.responseType || this.responseType === "text") {
              text = this.responseText;
            } else if (this.responseType === "json" && this.response) {
              text = JSON.stringify(this.response);
            }
          } catch {
            text = "";
          }
          rememberCaptionResponse(
            this.responseURL || this[captionUrlKey],
            this.status,
            text
          );
        },
        { once: true }
      );
    }
    return Reflect.apply(originalOpen, this, arguments);
  };

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(...args) {
    const response = await Reflect.apply(originalFetch, this, args);
    const requestValue =
      args[0] instanceof Request ? args[0].url : String(args[0] || "");
    if (captionRequestDetails(requestValue)) {
      response
        .clone()
        .text()
        .then((text) => {
          rememberCaptionResponse(
            response.url || requestValue,
            response.status,
            text
          );
        })
        .catch(() => {});
    }
    return response;
  };
}

installCaptionCapture();

function currentPlayerResponse() {
  const direct = window.ytInitialPlayerResponse;
  if (direct && typeof direct === "object") {
    return direct;
  }

  const serialized = window.ytplayer?.config?.args?.player_response;
  if (typeof serialized === "string") {
    try {
      return JSON.parse(serialized);
    } catch {
      return null;
    }
  }

  return null;
}

async function currentMoviePlayer(videoId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const player = document.querySelector("#movie_player");
    let currentVideoId = "";
    try {
      currentVideoId = player?.getVideoData?.().video_id || "";
    } catch {
      currentVideoId = "";
    }
    if (player && (!currentVideoId || currentVideoId === videoId)) {
      return player;
    }
    await delay(100);
  }
  return null;
}

function playerCaptionOption(player, option) {
  try {
    return player?.getOption?.("captions", option) || null;
  } catch {
    return null;
  }
}

async function enableNativeCaptions(player, timeoutMs = 3000) {
  try {
    player?.loadModule?.("captions");
  } catch {
    // The module may already be loaded.
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = document.querySelector(
      "#movie_player .ytp-subtitles-button"
    );
    if (
      button &&
      !button.disabled &&
      button.getAttribute("aria-disabled") !== "true"
    ) {
      if (button.getAttribute("aria-pressed") !== "true") button.click();
      if (button.getAttribute("aria-pressed") === "true") return true;
    }
    await delay(100);
  }
  return false;
}

async function loadOfficialCaption(
  videoId,
  translationLanguage = ""
) {
  const existing = capturedCaption(videoId, translationLanguage);
  if (existing) return existing;

  const player = await currentMoviePlayer(videoId);
  if (!player) throw new Error("YouTube player unavailable");
  await enableNativeCaptions(player);

  const capturedAfterEnable = await waitForCapturedCaption(
    videoId,
    translationLanguage,
    1500
  );
  if (capturedAfterEnable) return capturedAfterEnable;

  const tracklist = playerCaptionOption(player, "tracklist");
  const currentTrack = playerCaptionOption(player, "track");
  const tracks = Array.isArray(tracklist) ? tracklist : [];
  const englishTrack =
    tracks.find((track) =>
      String(track.languageCode || "").toLowerCase().startsWith("en")
    ) ||
    (String(currentTrack?.languageCode || "").toLowerCase().startsWith("en")
      ? currentTrack
      : null);
  if (!englishTrack) throw new Error("YouTube English caption track unavailable");

  try {
    if (translationLanguage) {
      const translationLanguages =
        playerCaptionOption(player, "translationLanguages") || [];
      const translation =
        translationLanguages.find(
          (language) => language.languageCode === translationLanguage
        ) || { languageCode: translationLanguage };
      player.setOption("captions", "translationLanguage", translation);
      player.setOption("captions", "track", {
        ...englishTrack,
        translationLanguage: translation
      });
    } else {
      player.setOption("captions", "track", englishTrack);
      player.setOption("captions", "reload", true);
    }
  } catch (error) {
    throw new Error(`YouTube caption selection failed: ${error}`);
  }

  let captured = await waitForCapturedCaption(
    videoId,
    translationLanguage,
    7000
  );
  if (captured || translationLanguage) return captured;

  const button = document.querySelector(
    "#movie_player .ytp-subtitles-button"
  );
  if (button?.getAttribute("aria-pressed") === "true") {
    button.click();
    await delay(150);
    button.click();
    captured = await waitForCapturedCaption(videoId, "", 5000);
  }
  return captured;
}

window.addEventListener("reader-on-chrome:request-player-response", (event) => {
  const requestId = event.detail?.requestId;
  if (!requestId) return;

  let payload = "";
  try {
    const response = currentPlayerResponse();
    if (response) payload = JSON.stringify(response);
  } catch {
    payload = "";
  }

  window.dispatchEvent(
    new CustomEvent("reader-on-chrome:player-response", {
      detail: { requestId, payload }
    })
  );
});

window.addEventListener(
  "reader-on-chrome:request-official-caption-texts",
  async (event) => {
    const requestId = event.detail?.requestId;
    const videoId = String(event.detail?.videoId || "");
    if (!requestId || !/^[\w-]{11}$/.test(videoId)) return;

    let responseDetail;
    try {
      const english = await loadOfficialCaption(videoId);
      const chinese = await loadOfficialCaption(videoId, "zh-Hans");
      responseDetail = {
        requestId,
        ok: Boolean(english?.text && chinese?.text),
        englishText: english?.text || "",
        chineseText: chinese?.text || "",
        error:
          english?.text && chinese?.text
            ? ""
            : "YouTube official caption response unavailable"
      };
    } catch (error) {
      responseDetail = {
        requestId,
        ok: false,
        englishText: "",
        chineseText: "",
        error: String(error)
      };
    }

    window.dispatchEvent(
      new CustomEvent("reader-on-chrome:official-caption-texts-response", {
        detail: responseDetail
      })
    );
  }
);

window.addEventListener(
  "reader-on-chrome:request-caption-text",
  async (event) => {
    const requestId = event.detail?.requestId;
    if (!requestId) return;

    let responseDetail;
    try {
      const url = new URL(String(event.detail?.url || ""));
      if (url.origin !== location.origin || url.pathname !== "/api/timedtext") {
        throw new Error("Blocked non-YouTube caption URL");
      }
      const response = await fetch(url.href, {
        credentials: event.detail?.credentials === "omit" ? "omit" : "include",
        headers: {
          Accept: event.detail?.accept || "application/json",
          "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8"
        }
      });
      responseDetail = {
        requestId,
        ok: response.ok,
        status: response.status,
        text: await response.text()
      };
    } catch (error) {
      responseDetail = {
        requestId,
        ok: false,
        status: 0,
        error: String(error)
      };
    }

    window.dispatchEvent(
      new CustomEvent("reader-on-chrome:caption-text-response", {
        detail: responseDetail
      })
    );
  }
);

async function fallbackPlayerResponse(videoId) {
  const htmlResponse = await fetch(
    `/watch?v=${encodeURIComponent(videoId)}`,
    { credentials: "omit" }
  );
  const html = await htmlResponse.text();
  const visitorMatch = html.match(/"VISITOR_DATA":"([^"]+)"/);
  const visitorData = visitorMatch
    ? decodeURIComponent(visitorMatch[1])
    : "";
  if (!visitorData) throw new Error("YouTube visitor data unavailable");

  const client = { ...ANDROID_VR_CLIENT, visitorData };
  const response = await fetch("/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    credentials: "omit",
    headers: {
      "Content-Type": "application/json",
      "X-YouTube-Client-Name": "28",
      "X-YouTube-Client-Version": ANDROID_VR_CLIENT.clientVersion,
      "X-Goog-Visitor-Id": visitorData
    },
    body: JSON.stringify({
      context: { client },
      videoId,
      playbackContext: {
        contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" }
      },
      contentCheckOk: true,
      racyCheckOk: true
    })
  });
  if (!response.ok) throw new Error(`YouTube HTTP ${response.status}`);
  const playerResponse = await response.json();
  return {
    captions: playerResponse.captions || null,
    videoDetails: playerResponse.videoDetails || null,
    responseContext: playerResponse.responseContext || null
  };
}

window.addEventListener(
  "reader-on-chrome:request-fallback-player-response",
  async (event) => {
    const requestId = event.detail?.requestId;
    const videoId = String(event.detail?.videoId || "");
    if (!requestId || !/^[\w-]{11}$/.test(videoId)) return;

    let payload = "";
    let error = "";
    try {
      payload = JSON.stringify(await fallbackPlayerResponse(videoId));
    } catch (caught) {
      error = String(caught);
    }

    window.dispatchEvent(
      new CustomEvent("reader-on-chrome:fallback-player-response", {
        detail: { requestId, payload, error }
      })
    );
  }
);
