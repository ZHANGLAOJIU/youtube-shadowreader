"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../caption-core.js");

test("extracts ytInitialPlayerResponse without a fragile regex", () => {
  const html = `<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc"},"value":"} inside string"};</script>`;
  assert.equal(core.extractAssignedJson(html).videoDetails.videoId, "abc");
});

test("selects English captions and detects simplified Chinese translation", () => {
  const response = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { languageCode: "de", baseUrl: "https://www.youtube.com/api/timedtext?a=1" },
          { languageCode: "en", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?a=2" }
        ],
        translationLanguages: [{ languageCode: "zh-Hans" }]
      }
    }
  };
  const config = core.captionConfig(response);
  assert.equal(config.englishTrack.languageCode, "en");
  assert.equal(config.supportsSimplifiedChinese, true);
  assert.match(core.captionUrl(config.englishTrack, "zh-Hans"), /tlang=zh-Hans/);
});

test("detects translation support from a translatable caption track", () => {
  const playerResponse = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            languageCode: "en",
            kind: "asr",
            isTranslatable: true,
            baseUrl: "https://www.youtube.com/api/timedtext?v=example"
          }
        ]
      }
    }
  };

  assert.equal(core.captionConfig(playerResponse).supportsSimplifiedChinese, true);
});

test("turns rolling caption chunks into sentence-level segments", () => {
  const cues = [
    { startMs: 9320, endMs: 12040, text: "Thank you for giving me this" },
    { startMs: 10800, endMs: 13960, text: "opportunity. Actually, I'm not going to" },
    { startMs: 12040, endMs: 14560, text: "talk about AI." },
    { startMs: 16920, endMs: 21000, text: "I am going to talk about humans." }
  ];
  const sentences = core.mergeIntoSentences(cues);
  assert.deepEqual(
    sentences.map((sentence) => sentence.text),
    [
      "Thank you for giving me this opportunity.",
      "Actually, I'm not going to talk about AI.",
      "I am going to talk about humans."
    ]
  );
  assert.equal(sentences[0].startMs, 9320);
  assert.equal(sentences[2].endMs, 21000);
});

test("aligns translated caption chunks by timeline overlap", () => {
  const english = [
    { startMs: 0, endMs: 2000, text: "Hello." },
    { startMs: 2000, endMs: 5000, text: "How are you?" }
  ];
  const chinese = [
    { startMs: 0, endMs: 1900, text: "你好。" },
    { startMs: 2100, endMs: 3500, text: "你" },
    { startMs: 3500, endMs: 4900, text: "好吗？" }
  ];
  const aligned = core.alignTranslation(english, chinese);
  assert.equal(aligned[0].translation, "你好。");
  assert.equal(aligned[1].translation, "你好吗？");
});

test("pairs bilingual rolling chunks before sentence merging", () => {
  const english = [
    { startMs: 9320, endMs: 12040, text: "Thank you for giving me this" },
    { startMs: 10800, endMs: 13960, text: "opportunity. Actually, I'm not going to" },
    { startMs: 12040, endMs: 14560, text: "talk about AI." }
  ];
  const chinese = [
    { startMs: 9320, endMs: 12040, text: "感谢您给我这个" },
    { startMs: 10800, endMs: 13960, text: "机会。实际上，我并不打算" },
    { startMs: 12040, endMs: 14560, text: "谈论人工智能。" }
  ];
  const sentences = core.buildBilingualSentences(english, chinese);
  assert.deepEqual(
    sentences.map(({ text, translation }) => ({ text, translation })),
    [
      {
        text: "Thank you for giving me this opportunity.",
        translation: "感谢您给我这个机会。"
      },
      {
        text: "Actually, I'm not going to talk about AI.",
        translation: "实际上，我并不打算谈论人工智能。"
      }
    ]
  );
});

test("extracts YouTube word offsets and attaches them despite missing filler words", () => {
  const payload = {
    events: [
      {
        tStartMs: 1000,
        dDurationMs: 1000,
        segs: [
          { utf8: "I'm" },
          { utf8: " here.", tOffsetMs: 400 }
        ]
      },
      {
        tStartMs: 2500,
        dDurationMs: 1000,
        segs: [
          { utf8: "Next" },
          { utf8: " sentence.", tOffsetMs: 500 }
        ]
      }
    ]
  };
  const sentences = [
    { startMs: 900, endMs: 2200, text: "Uh I'm here." },
    { startMs: 2400, endMs: 3600, text: "Next sentence." }
  ];
  const timed = core.parseJson3WordTimings(payload);
  const attached = core.attachWordTimings(sentences, timed);

  assert.equal(timed.length, 4);
  assert.deepEqual(
    attached[0].words.map((word) => [word.text, word.startMs]),
    [
      ["Uh", null],
      ["I'm", 1000],
      ["here.", 1400]
    ]
  );
  assert.equal(attached[1].words[0].startMs, 2500);
});

test("finds the active sentence with a binary search", () => {
  const sentences = [
    { startMs: 1000, endMs: 2000 },
    { startMs: 2500, endMs: 4000 }
  ];
  assert.equal(core.activeSentenceIndex(sentences, 1500), 0);
  assert.equal(core.activeSentenceIndex(sentences, 2200), -1);
  assert.equal(core.activeSentenceIndex(sentences, 3000), 1);
});

test("prefers the latest sentence when automatic-caption times overlap", () => {
  const sentences = [
    { startMs: 1000, endMs: 5000, text: "First." },
    { startMs: 3000, endMs: 6000, text: "Second." }
  ];

  assert.equal(core.activeSentenceIndex(sentences, 2500), 0);
  assert.equal(core.activeSentenceIndex(sentences, 3500), 1);
  assert.equal(core.activeSentenceIndex(sentences, 6500), -1);
});

test("finds the active word from YouTube word timing", () => {
  const words = [
    { text: "Uh", startMs: null, endMs: null },
    { text: "I'm", startMs: 1000, endMs: 1400 },
    { text: "here.", startMs: 1400, endMs: 2200 }
  ];

  assert.equal(core.activeWordIndex(words, 1200), 1);
  assert.equal(core.activeWordIndex(words, 1800), 2);
  assert.equal(core.activeWordIndex(words, 2400), -1);
});
