(function exposeCaptionCore(globalScope) {
  "use strict";

  const SENTENCE_END_RE = /[.!?…。！？…]["'”’)]*$/u;

  function normalizeWhitespace(value) {
    return String(value || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractBalancedObject(text, objectStart) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = objectStart; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(objectStart, index + 1);
      }
    }
    return "";
  }

  function extractAssignedJson(html, variableName = "ytInitialPlayerResponse") {
    const markers = [
      `${variableName} =`,
      `${variableName}=`,
      `var ${variableName} =`,
      `var ${variableName}=`
    ];

    for (const marker of markers) {
      const markerIndex = html.indexOf(marker);
      if (markerIndex < 0) continue;
      const objectStart = html.indexOf("{", markerIndex + marker.length);
      if (objectStart < 0) continue;
      const serialized = extractBalancedObject(html, objectStart);
      if (!serialized) continue;
      try {
        return JSON.parse(serialized);
      } catch {
        // Try the next assignment form.
      }
    }
    return null;
  }

  function captionConfig(playerResponse) {
    const renderer =
      playerResponse?.captions?.playerCaptionsTracklistRenderer || null;
    if (!renderer) return null;

    const tracks = Array.isArray(renderer.captionTracks)
      ? renderer.captionTracks
      : [];
    const englishTracks = tracks.filter((track) =>
      String(track.languageCode || "").toLowerCase().startsWith("en")
    );
    const englishTrack =
      englishTracks.find((track) => track.kind !== "asr") ||
      englishTracks[0] ||
      null;

    const translationLanguages = Array.isArray(renderer.translationLanguages)
      ? renderer.translationLanguages
      : [];
    const supportsSimplifiedChinese =
      englishTrack?.isTranslatable === true ||
      translationLanguages.some(
        (language) => language.languageCode === "zh-Hans"
      );

    return {
      englishTrack,
      tracks,
      supportsSimplifiedChinese
    };
  }

  function captionUrl(track, translationLanguage = "") {
    if (!track?.baseUrl) return "";
    const url = new URL(track.baseUrl);
    url.searchParams.set("fmt", "json3");
    if (translationLanguage) {
      url.searchParams.set("tlang", translationLanguage);
    }
    return url.href;
  }

  function wordTimingTrack(config) {
    const tracks = Array.isArray(config?.tracks) ? config.tracks : [];
    return (
      tracks.find(
        (track) =>
          String(track.languageCode || "").toLowerCase().startsWith("en") &&
          track.kind === "asr"
      ) ||
      config?.englishTrack ||
      null
    );
  }

  function captionRetryDelay(status, attempt = 0) {
    const numericStatus = Number(status || 0);
    if (
      numericStatus !== 0 &&
      numericStatus !== 429 &&
      numericStatus < 500
    ) {
      return null;
    }
    return Math.min(5 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, attempt));
  }

  function parseJson3(payload) {
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const cues = [];

    for (const event of events) {
      if (!Array.isArray(event.segs)) continue;
      const text = normalizeWhitespace(
        event.segs.map((segment) => segment.utf8 || "").join("")
      );
      if (!text) continue;

      const startMs = Number(event.tStartMs || 0);
      const durationMs = Math.max(1, Number(event.dDurationMs || 0));
      cues.push({
        startMs,
        endMs: startMs + durationMs,
        text
      });
    }

    return cues.sort((left, right) => left.startMs - right.startMs);
  }

  function lexicalToken(value) {
    const match = String(value || "").match(
      /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/u
    );
    return (match?.[0] || "").toLowerCase().replaceAll("’", "'");
  }

  function parseJson3WordTimings(payload) {
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const words = [];

    for (const event of events) {
      if (
        !Array.isArray(event.segs) ||
        !event.segs.some((segment) => Number.isFinite(segment.tOffsetMs))
      ) {
        continue;
      }
      const eventStartMs = Number(event.tStartMs || 0);
      for (const segment of event.segs) {
        const text = normalizeWhitespace(segment.utf8).replace(/^>>\s*/u, "");
        if (!text || !lexicalToken(text)) continue;
        words.push({
          text,
          startMs: eventStartMs + Number(segment.tOffsetMs || 0)
        });
      }
    }

    words.sort((left, right) => left.startMs - right.startMs);
    const uniqueWords = words.filter((word, index) => {
      const previous = words[index - 1];
      return !(
        previous &&
        previous.startMs === word.startMs &&
        previous.text === word.text
      );
    });
    return uniqueWords.map((word, index) => ({
      ...word,
      endMs: Math.max(
        word.startMs + 1,
        Math.min(
          word.startMs + 1200,
          uniqueWords[index + 1]?.startMs ?? word.startMs + 800
        )
      )
    }));
  }

  function attachWordTimings(sentences, timedWords, options = {}) {
    const lookAhead = options.lookAhead ?? 8;
    const minimumCoverage = options.minimumCoverage ?? 0.6;
    const sourceWords = sentences.map((sentence) =>
      (sentence.text.match(/\S+/gu) || []).map((text) => ({
        text,
        normalized: lexicalToken(text),
        timing: null
      }))
    );
    const flattened = sourceWords.flatMap((words, sentenceIndex) =>
      words
        .map((word, wordIndex) => ({
          sentenceIndex,
          wordIndex,
          normalized: word.normalized
        }))
        .filter((word) => word.normalized)
    );
    const usableTimings = timedWords
      .map((word) => ({ ...word, normalized: lexicalToken(word.text) }))
      .filter((word) => word.normalized);

    let sourceIndex = 0;
    let timingIndex = 0;
    while (sourceIndex < flattened.length && timingIndex < usableTimings.length) {
      const sourceWord = flattened[sourceIndex];
      const timedWord = usableTimings[timingIndex];
      if (sourceWord.normalized === timedWord.normalized) {
        sourceWords[sourceWord.sentenceIndex][sourceWord.wordIndex].timing = timedWord;
        sourceIndex += 1;
        timingIndex += 1;
        continue;
      }

      let sourceAhead = -1;
      let timingAhead = -1;
      for (
        let distance = 1;
        distance <= lookAhead && sourceIndex + distance < flattened.length;
        distance += 1
      ) {
        if (flattened[sourceIndex + distance].normalized === timedWord.normalized) {
          sourceAhead = distance;
          break;
        }
      }
      for (
        let distance = 1;
        distance <= lookAhead && timingIndex + distance < usableTimings.length;
        distance += 1
      ) {
        if (sourceWord.normalized === usableTimings[timingIndex + distance].normalized) {
          timingAhead = distance;
          break;
        }
      }

      if (sourceAhead >= 0 && (timingAhead < 0 || sourceAhead <= timingAhead)) {
        sourceIndex += sourceAhead;
      } else if (timingAhead >= 0) {
        timingIndex += timingAhead;
      } else {
        sourceIndex += 1;
        timingIndex += 1;
      }
    }

    return sentences.map((sentence, sentenceIndex) => {
      const words = sourceWords[sentenceIndex];
      const timed = words.filter((word) => word.timing);
      if (!words.length || timed.length / words.length < minimumCoverage) {
        return { ...sentence, words: [] };
      }
      return {
        ...sentence,
        startMs: timed[0].timing.startMs,
        endMs: timed[timed.length - 1].timing.endMs,
        words: words.map((word) => ({
          text: word.text,
          startMs: word.timing?.startMs ?? null,
          endMs: word.timing?.endMs ?? null
        }))
      };
    });
  }

  function sentenceTextParts(text) {
    const matches = text.match(/[^.!?…。！？…]+[.!?…。！？…]+["'”’)]*|[^.!?…。！？…]+$/gu);
    return (matches || [text]).map(normalizeWhitespace).filter(Boolean);
  }

  function splitCueAtSentenceBoundaries(cue) {
    const pieces = sentenceTextParts(cue.text);
    if (pieces.length === 1) return [cue];
    const weightTotal = pieces.reduce((sum, piece) => sum + piece.length, 0);
    let cursor = cue.startMs;
    return pieces.map((piece, index) => {
      const isLast = index === pieces.length - 1;
      const share = isLast
        ? cue.endMs - cursor
        : Math.max(1, Math.round(((cue.endMs - cue.startMs) * piece.length) / weightTotal));
      const result = { startMs: cursor, endMs: cursor + share, text: piece };
      cursor += share;
      return result;
    });
  }

  function appendWithoutRollingDuplicate(existing, incoming) {
    const left = normalizeWhitespace(existing);
    const right = normalizeWhitespace(incoming);
    if (!left) return right;
    if (!right) return left;
    if (left === right || left.endsWith(` ${right}`)) return left;
    if (right.startsWith(`${left} `)) return right;

    const leftWords = left.split(" ");
    const rightWords = right.split(" ");
    const maxOverlap = Math.min(leftWords.length, rightWords.length, 12);
    for (let size = maxOverlap; size > 0; size -= 1) {
      const leftTail = leftWords.slice(-size).join(" ").toLowerCase();
      const rightHead = rightWords.slice(0, size).join(" ").toLowerCase();
      if (leftTail === rightHead) {
        return normalizeWhitespace(
          `${left} ${rightWords.slice(size).join(" ")}`
        );
      }
    }
    return `${left} ${right}`;
  }

  function mergeIntoSentences(cues, options = {}) {
    const maxGapMs = options.maxGapMs ?? 1200;
    const maxCharacters = options.maxCharacters ?? 240;
    const fragments = cues.flatMap(splitCueAtSentenceBoundaries);
    const sentences = [];
    let current = null;

    function finish() {
      if (!current?.text) return;
      sentences.push({ ...current, text: normalizeWhitespace(current.text) });
      current = null;
    }

    for (const fragment of fragments) {
      if (!current) {
        current = { ...fragment };
        continue;
      }

      const gapMs = fragment.startMs - current.endMs;
      if (
        SENTENCE_END_RE.test(current.text) ||
        gapMs > maxGapMs ||
        current.text.length >= maxCharacters
      ) {
        finish();
        current = { ...fragment };
        continue;
      }

      current.text = appendWithoutRollingDuplicate(current.text, fragment.text);
      current.endMs = Math.max(current.endMs, fragment.endMs);
    }
    finish();
    return sentences;
  }

  function overlapMs(left, right) {
    return Math.max(
      0,
      Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs)
    );
  }

  function normalizeChinese(value) {
    return normalizeWhitespace(value)
      .replace(/([\u3400-\u9FFF])\s+(?=[\u3400-\u9FFF])/gu, "$1")
      .replace(/\s+([，。！？；：、])/gu, "$1");
  }

  function alignTranslation(englishSentences, translatedCues) {
    const buckets = englishSentences.map(() => []);

    for (const cue of translatedCues) {
      let bestIndex = -1;
      let bestOverlap = 0;
      for (let index = 0; index < englishSentences.length; index += 1) {
        const overlap = overlapMs(englishSentences[index], cue);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestIndex = index;
        }
        if (englishSentences[index].startMs > cue.endMs && bestIndex >= 0) break;
      }
      if (bestIndex >= 0 && bestOverlap > 0) buckets[bestIndex].push(cue.text);
    }

    return englishSentences.map((sentence, index) => {
      const translation = buckets[index].reduce(
        (text, cueText) => appendWithoutRollingDuplicate(text, cueText),
        ""
      );
      return { ...sentence, translation: normalizeChinese(translation) };
    });
  }

  function assignTranslatedCues(englishCues, translatedCues) {
    const buckets = englishCues.map(() => []);
    for (const cue of translatedCues) {
      let bestIndex = -1;
      let bestOverlap = 0;
      for (let index = 0; index < englishCues.length; index += 1) {
        const overlap = overlapMs(englishCues[index], cue);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestIndex = index;
        }
        if (englishCues[index].startMs > cue.endMs && bestIndex >= 0) break;
      }
      if (bestIndex >= 0 && bestOverlap > 0) buckets[bestIndex].push(cue.text);
    }
    return buckets.map((parts) =>
      parts.reduce(
        (text, part) => appendWithoutRollingDuplicate(text, part),
        ""
      )
    );
  }

  function buildBilingualSentences(englishCues, translatedCues, options = {}) {
    const maxGapMs = options.maxGapMs ?? 1200;
    const maxCharacters = options.maxCharacters ?? 240;
    const translations = assignTranslatedCues(englishCues, translatedCues);
    const fragments = [];

    englishCues.forEach((cue, cueIndex) => {
      const englishParts = sentenceTextParts(cue.text);
      const translation = translations[cueIndex] || "";
      const translatedParts = sentenceTextParts(translation);

      if (
        translation &&
        englishParts.length > 1 &&
        englishParts.length !== translatedParts.length
      ) {
        fragments.push({ ...cue, translation });
        return;
      }

      const timedParts = splitCueAtSentenceBoundaries(cue);
      timedParts.forEach((part, partIndex) => {
        fragments.push({
          ...part,
          translation:
            translatedParts.length === timedParts.length
              ? translatedParts[partIndex]
              : translation
        });
      });
    });

    const sentences = [];
    let current = null;

    function finish() {
      if (!current?.text) return;
      sentences.push({
        ...current,
        text: normalizeWhitespace(current.text),
        translation: normalizeChinese(current.translation)
      });
      current = null;
    }

    for (const fragment of fragments) {
      if (!current) {
        current = { ...fragment };
        continue;
      }
      const gapMs = fragment.startMs - current.endMs;
      if (
        SENTENCE_END_RE.test(current.text) ||
        gapMs > maxGapMs ||
        current.text.length >= maxCharacters
      ) {
        finish();
        current = { ...fragment };
        continue;
      }
      current.text = appendWithoutRollingDuplicate(current.text, fragment.text);
      current.translation = appendWithoutRollingDuplicate(
        current.translation,
        fragment.translation
      );
      current.endMs = Math.max(current.endMs, fragment.endMs);
    }
    finish();
    return sentences;
  }

  function activeSentenceIndex(sentences, currentTimeMs) {
    let low = 0;
    let high = sentences.length - 1;
    let latestStarted = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const sentence = sentences[middle];
      if (currentTimeMs < sentence.startMs) {
        high = middle - 1;
      } else {
        latestStarted = middle;
        low = middle + 1;
      }
    }
    return latestStarted >= 0 && currentTimeMs < sentences[latestStarted].endMs
      ? latestStarted
      : -1;
  }

  function activeWordIndex(words, currentTimeMs) {
    let latestStarted = -1;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (!Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)) {
        continue;
      }
      if (word.startMs > currentTimeMs) break;
      latestStarted = index;
    }
    return latestStarted >= 0 && currentTimeMs < words[latestStarted].endMs
      ? latestStarted
      : -1;
  }

  const api = {
    activeSentenceIndex,
    activeWordIndex,
    alignTranslation,
    appendWithoutRollingDuplicate,
    attachWordTimings,
    buildBilingualSentences,
    captionConfig,
    captionRetryDelay,
    captionUrl,
    extractAssignedJson,
    mergeIntoSentences,
    normalizeWhitespace,
    parseJson3,
    parseJson3WordTimings,
    wordTimingTrack
  };

  globalScope.ReaderCaptionCore = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
