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
  if (!playerResponse?.captions) {
    throw new Error(
      playerResponse?.playabilityStatus?.reason || "YouTube captions unavailable"
    );
  }
  return {
    captions: playerResponse.captions,
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
