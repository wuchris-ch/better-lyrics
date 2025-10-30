import * as Constants from "@constants";
import { BACKGROUND_LYRIC_CLASS } from "@constants";
import * as DOM from "@modules/ui/dom";
import * as Utils from "@utils";
import * as Translation from "@modules/lyrics/translation";
import { containsNonLatin, testRtl } from "@modules/lyrics/lyricParseUtils";
import { AppState } from "@/index";
import type { LyricSourceResultWithMeta } from "@modules/lyrics/lyrics";

export interface PartData {
  time: number;
  duration: number;
  lyricElement: Element;
  animationStartTimeMs: number;
}

export interface LineData {
  lyricElement: Element;
  time: number;
  duration: number;
  parts: PartData[];
  isScrolled: boolean;
  animationStartTimeMs: number;
  isAnimationPlayStatePlaying: boolean;
  accumulatedOffsetMs: number;
  isAnimating: boolean;
  isSelected: boolean;
}

export type SyncType = "richsync" | "synced" | "none";

export interface LyricsData {
  lines: LineData[];
  syncType: SyncType;
}

/**
 * Injects lyrics into the DOM with timing, click handlers, and animations.
 * Creates the complete lyrics interface including synchronization support.
 *
 * @param data - Complete lyrics data object
 * @param keepLoaderVisible
 * @param data.lyrics - Array of lyric lines with timing
 * @param [data.source] - Source attribution for lyrics
 * @param [data.sourceHref] - URL for source link
 */
export function injectLyrics(data: LyricSourceResultWithMeta, keepLoaderVisible = false): void {
  const lyrics = data.lyrics!;
  DOM.cleanup();
  let lyricsWrapper = DOM.createLyricsWrapper();

  lyricsWrapper.innerHTML = "";
  const lyricsContainer = document.createElement("div");

  try {
    lyricsContainer.className = Constants.LYRICS_CLASS;
    lyricsWrapper.appendChild(lyricsContainer);

    lyricsWrapper.removeAttribute("is-empty");

    // add a line at -1s so that we scroll to it at when the song starts
    let line = document.createElement("div");
    line.dataset.time = "-1";
    line.style.cssText = "--blyrics-duration: 0s; padding-top: 0 !important; padding-bottom: 0 !important;";
    lyricsContainer.appendChild(line);
  } catch (_err) {
    Utils.log(Constants.LYRICS_WRAPPER_NOT_VISIBLE_LOG);
  }

  Translation.onTranslationEnabled(items => {
    Utils.log(Constants.TRANSLATION_ENABLED_LOG, items.translationLanguage);
  });

  const allZero = lyrics.every(item => item.startTimeMs === 0);

  if (keepLoaderVisible) {
    DOM.renderLoader(true);
  } else {
    DOM.flushLoader(allZero && lyrics[0].words !== Constants.NO_LYRICS_TEXT);
  }

  const langPromise = new Promise<string>(async resolve => {
    if (!data.language) {
      let text = "";
      let lineCount = 0;
      for (let item of lyrics) {
        text += item.words.trim() + "\n";
        lineCount++;
        if (lineCount >= 10) {
          break;
        }
      }
      const translationResult = await Translation.translateText(text, "en");
      const lang = translationResult?.originalLanguage || "";
      Utils.log("[BetterLyrics] Lang was missing. Determined it is: " + lang);
      return resolve(lang);
    } else {
      resolve(data.language);
    }
  });

  let lines: LineData[] = [];
  let syncType: SyncType = "synced";

  lyrics.forEach((item, lineIndex) => {
    if (!item.parts || item.parts.length === 0) {
      item.parts = [];
      const words = item.words.split(" ");

      words.forEach((word, index) => {
        word = word.trim().length < 1 ? word : word + " ";
        item.parts!.push({
          startTimeMs: item.startTimeMs + index * 50,
          words: word,
          durationMs: 0,
        });
      });
    }

    if (!item.parts.every(part => part.durationMs === 0)) {
      syncType = "richsync";
    }

    let lyricElement = document.createElement("div");
    lyricElement.classList.add("blyrics--line");

    let line: LineData = {
      lyricElement: lyricElement,
      time: item.startTimeMs / 1000,
      duration: item.durationMs / 1000,
      parts: [],
      isScrolled: false,
      animationStartTimeMs: Infinity,
      isAnimationPlayStatePlaying: false,
      accumulatedOffsetMs: 0,
      isAnimating: false,
      isSelected: false,
    };

    // To add rtl elements in reverse to the dom
    let rtlBuffer: HTMLSpanElement[] = [];
    let isAllRtl = true;

    let lyricElementsBuffer = [] as HTMLSpanElement[];

    item.parts.forEach(part => {
      let isRtl = testRtl(part.words);
      if (!isRtl && part.words.trim().length > 0) {
        isAllRtl = false;
        rtlBuffer.reverse().forEach(part => {
          lyricElementsBuffer.push(part);
        });
        rtlBuffer = [];
      }

      let span = document.createElement("span");
      span.classList.add(Constants.WORD_CLASS);
      if (Number(part.durationMs) === 0) {
        span.classList.add(Constants.ZERO_DURATION_ANIMATION_CLASS);
      }
      if (isRtl) {
        span.classList.add(Constants.RTL_CLASS);
      }

      let partData: PartData = {
        time: part.startTimeMs / 1000,
        duration: part.durationMs / 1000,
        lyricElement: span,
        animationStartTimeMs: Infinity,
      };

      span.textContent = part.words;
      span.dataset.time = String(partData.time);
      span.dataset.duration = String(partData.duration);
      span.dataset.content = part.words;
      span.style.setProperty("--blyrics-duration", part.durationMs + "ms");
      if (part.isBackground) {
        span.classList.add(BACKGROUND_LYRIC_CLASS);
      }
      if (part.words.trim().length === 0) {
        span.style.display = "inline";
      }

      line.parts.push(partData);
      if (isRtl) {
        rtlBuffer.push(span);
      } else {
        lyricElementsBuffer.push(span);
      }
    });

    //Add remaining rtl elements

    if (isAllRtl) {
      lyricElement.classList.add(Constants.RTL_CLASS);
      rtlBuffer.forEach(part => {
        lyricElementsBuffer.push(part);
      });
    } else {
      rtlBuffer.reverse().forEach(part => {
        lyricElementsBuffer.push(part);
      });
    }

    groupByWordAndInsert(lyricElement, lyricElementsBuffer);

    //Makes bg lyrics go to the next line
    let breakElm: HTMLSpanElement = document.createElement("span");
    breakElm.style.order = "1";
    breakElm.classList.add("blyrics--break");
    lyricElement.appendChild(breakElm);

    lyricElement.dataset.time = String(line.time);
    lyricElement.dataset.duration = String(line.duration);
    lyricElement.dataset.lineNumber = String(lineIndex);
    lyricElement.style.setProperty("--blyrics-duration", item.durationMs + "ms");

    if (!allZero) {
      lyricElement.setAttribute(
        "onClick",
        `const player = document.getElementById("movie_player"); player.seekTo(${item.startTimeMs / 1000}, true);player.playVideo();`
      );
      lyricElement.addEventListener("click", _e => {
        DOM.animEngineState.scrollResumeTime = 0;
      });
    } else {
      lyricElement.style.cursor = "unset";
    }

    // Synchronously check cache and inject if found
    let romanizedResult = Translation.getRomanizationFromCache(item.words);

    if (romanizedResult) {
      let breakElm: HTMLSpanElement = document.createElement("span");
      breakElm.classList.add("blyrics--break");
      breakElm.style.order = "4";
      lyricElement.appendChild(breakElm);

      let romanizedLine = document.createElement("div");
      romanizedLine.classList.add(Constants.ROMANIZED_LYRICS_CLASS);
      romanizedLine.textContent = "\n" + romanizedResult;
      romanizedLine.style.order = "5";
      lyricElement.appendChild(romanizedLine);
      lyricElement.dataset.romanized = "true";
    }

    let translatedResult = Translation.getTranslationFromCache(item.words, Translation.getCurrentTranslationLanguage());
    if (translatedResult) {
      let breakElm: HTMLSpanElement = document.createElement("span");
      breakElm.classList.add("blyrics--break");
      breakElm.style.order = "6";
      lyricElement.appendChild(breakElm);

      let translatedLine = document.createElement("div");
      translatedLine.classList.add(Constants.TRANSLATED_LYRICS_CLASS);
      translatedLine.textContent = "\n" + translatedResult.translatedText;
      translatedLine.style.order = "7";
      lyricElement.appendChild(translatedLine);
      lyricElement.dataset.translated = "true";
    }

    langPromise.then(source_language => {
      Translation.onRomanizationEnabled(async () => {
        let romanizedLine = document.createElement("div");
        romanizedLine.classList.add(Constants.ROMANIZED_LYRICS_CLASS);

        function removePreviousRomanizationIfNeeded() {
          const existingRomanizedLine = lyricElement.querySelector("." + Constants.ROMANIZED_LYRICS_CLASS);
          if (existingRomanizedLine) {
            existingRomanizedLine.remove();
          } else {
            let breakElm: HTMLSpanElement = document.createElement("span");
            breakElm.classList.add("blyrics--break");
            breakElm.style.order = "4";
            lyricElement.appendChild(breakElm);
          }
        }

        if (lyricElement.dataset.romanized === "true" && !item.romanization) return;
        let isNonLatin = containsNonLatin(item.words);
        if (Constants.romanizationLanguages.includes(source_language) || containsNonLatin(item.words)) {
          if (item.timedRomanization && item.timedRomanization.length > 0) {
            let lyricElementsBuffer = [] as HTMLSpanElement[];

            item.timedRomanization.forEach(part => {
              let span = document.createElement("span");
              span.classList.add(Constants.WORD_CLASS);
              if (Number(part.durationMs) === 0) {
                span.classList.add(Constants.ZERO_DURATION_ANIMATION_CLASS);
              }

              let partData: PartData = {
                time: part.startTimeMs / 1000,
                duration: part.durationMs / 1000,
                lyricElement: span,
                animationStartTimeMs: Infinity,
              };

              span.textContent = part.words;
              span.dataset.time = String(partData.time);
              span.dataset.duration = String(partData.duration);
              span.dataset.content = part.words;
              span.style.setProperty("--blyrics-duration", part.durationMs + "ms");
              if (part.isBackground) {
                span.classList.add(BACKGROUND_LYRIC_CLASS);
              }
              if (part.words.trim().length === 0) {
                span.style.display = "inline";
              }
              line.parts.push(partData);

              lyricElementsBuffer.push(span);
            });

            groupByWordAndInsert(romanizedLine, lyricElementsBuffer);
            removePreviousRomanizationIfNeeded();

            romanizedLine.style.order = "5";
            lyricElement.appendChild(romanizedLine);
            DOM.lyricsElementAdded();
            return;
          }

          let usableLang = source_language;
          if (isNonLatin && !Constants.romanizationLanguages.includes(source_language)) {
            usableLang = "auto";
          }
          if (item.words.trim() !== "♪" && item.words.trim() !== "") {
            let result;
            if (item.romanization) {
              result = item.romanization;
            } else {
              result = await Translation.translateTextIntoRomaji(usableLang, item.words);
            }

            if (result) {
              removePreviousRomanizationIfNeeded();

              romanizedLine.textContent = result ? "\n" + result : "\n";
              romanizedLine.style.order = "5";
              lyricElement.appendChild(romanizedLine);
              DOM.lyricsElementAdded();
            }
          }
        }
      });
      Translation.onTranslationEnabled(async items => {
        if (
          lyricElement.dataset.translated === "true" &&
          (items.translationLanguage || "en") === Translation.getCurrentTranslationLanguage()
        )
          return;

        let translatedLine = document.createElement("div");
        translatedLine.classList.add(Constants.TRANSLATED_LYRICS_CLASS);

        let target_language = items.translationLanguage || "en";

        if (source_language !== target_language || containsNonLatin(item.words)) {
          if (item.words.trim() !== "♪" && item.words.trim() !== "") {
            let result;
            if (item.translation && target_language === item.translation.lang) {
              result = {
                originalLanguage: item.translation.lang,
                translatedText: item.translation.text,
              };
            } else {
              result = await Translation.translateText(item.words, target_language);
            }

            if (result) {
              // Remove existing translated line if language changed
              const existingTranslatedLine = lyricElement.querySelector("." + Constants.TRANSLATED_LYRICS_CLASS);
              if (existingTranslatedLine) {
                existingTranslatedLine.remove();
              } else {
                let breakElm: HTMLSpanElement = document.createElement("span");
                breakElm.classList.add("blyrics--break");
                breakElm.style.order = "6";
                lyricElement.appendChild(breakElm);
              }
              translatedLine.textContent = "\n" + result.translatedText;
              translatedLine.style.order = "7";
              lyricElement.appendChild(translatedLine);

              DOM.lyricsElementAdded();
            }
          }
        }
      });
    });

    try {
      lines.push(line);
      lyricsContainer.appendChild(lyricElement);
    } catch (_err) {
      Utils.log(Constants.LYRICS_WRAPPER_NOT_VISIBLE_LOG);
    }
  });

  DOM.animEngineState.skipScrolls = 2;
  DOM.animEngineState.skipScrollsDecayTimes = [];
  for (let i = 0; i < DOM.animEngineState.skipScrolls; i++) {
    DOM.animEngineState.skipScrollsDecayTimes.push(Date.now() + 2000);
  }
  DOM.animEngineState.scrollResumeTime = 0;

  if (lyrics[0].words !== Constants.NO_LYRICS_TEXT) {
    DOM.addFooter(data.source, data.sourceHref, data.song, data.artist, data.album, data.duration);
  } else {
    DOM.addNoLyricsButton(data.song, data.artist, data.album, data.duration);
  }

  let spacingElement = document.createElement("div");
  spacingElement.id = Constants.LYRICS_SPACING_ELEMENT_ID;
  spacingElement.style.height = "100px"; // Temp Value; actual is calculated in the tick function
  spacingElement.textContent = "";
  spacingElement.style.padding = "0";
  spacingElement.style.margin = "0";
  lyricsContainer.appendChild(spacingElement);

  if (!allZero) {
    AppState.areLyricsTicking = true;
  } else {
    Utils.log(Constants.SYNC_DISABLED_LOG);
    syncType = "none";
  }

  AppState.lyricData = {
    lines: lines,
    syncType: syncType,
  };

  AppState.areLyricsLoaded = true;
}

/**
 * Take elements from the buffer and group them together to control where wrapping happens
 * @param lyricElement element to push to
 * @param lyricElementsBuffer elements to add
 */
function groupByWordAndInsert(lyricElement: HTMLDivElement, lyricElementsBuffer: HTMLSpanElement[]) {
  const breakChar = /([\s\u200B\u00AD\p{Dash_Punctuation}])/gu;

  let wordGroupBuffer = [] as HTMLSpanElement[];
  let isCurrentBufferBg = false;

  let pushWordGroupBuffer = () => {
    if (wordGroupBuffer.length > 0) {
      let span = document.createElement("span");
      wordGroupBuffer.forEach(word => {
        span.appendChild(word);
      });

      if (wordGroupBuffer[0].classList.contains(BACKGROUND_LYRIC_CLASS)) {
        span.classList.add(BACKGROUND_LYRIC_CLASS);
      }

      lyricElement.appendChild(span);
      wordGroupBuffer = [];
    }
  };

  lyricElementsBuffer.forEach(part => {
    const isNonMatchingType = isCurrentBufferBg !== part.classList.contains(BACKGROUND_LYRIC_CLASS);
    if (!isNonMatchingType) {
      wordGroupBuffer.push(part);
    }
    if (
      (part.textContent.length > 0 && breakChar.test(part.textContent[part.textContent.length - 1])) ||
      isNonMatchingType
    ) {
      pushWordGroupBuffer();
    }

    if (isNonMatchingType) {
      wordGroupBuffer.push(part);
      isCurrentBufferBg = part.classList.contains(BACKGROUND_LYRIC_CLASS);
    }
  });

  //add remaining
  pushWordGroupBuffer();
}
