/**
 * @fileoverview Main lyrics handling module for
 * Manages lyrics fetching, caching, processing, and rendering.
 */

/** @import {SegmentMap, ProviderParameters} from './providers.js' */

import * as Utils from "@utils";
import * as Constants from "@constants";
import * as RequestSniffer from "./requestSniffer";
import * as DOM from "@modules/ui/dom";
import * as Translation from "./translation";
import * as LyricProviders from "./providers/shared";
import * as RequestSniffing from "./requestSniffer";
import * as Storage from "@core/storage";
import { AppState } from "@/index";
import type { PlayerDetails } from "@/index";
import type { SegmentMap } from "./requestSniffer";
import type { LyricSourceResult, ProviderParameters } from "./providers/shared";
import type { CubeyLyricSourceResult } from "./providers/cubey";
import type { YTLyricSourceResult } from "./providers/yt";
import { BACKGROUND_LYRIC_CLASS } from "@constants";
import { it } from "node:test";

/** Current version of the lyrics cache format */
const LYRIC_CACHE_VERSION = "1.2.0";

type LyricSourceResultWithMeta = LyricSourceResult & {
  song: string;
  artist: string;
  album: string;
  duration: number;
  videoId: string;
};

type LyricSourceResultWithMetaAndVersion = LyricSourceResultWithMeta & {
  version: string;
};

/**
 * Main function to create and inject lyrics for the current song.
 * Handles caching, API requests, and fallback mechanisms.
 *
 * @param detail - Song and player details
 * @param signal
 */
export async function createLyrics(detail: PlayerDetails, signal: AbortSignal): Promise<void> {
  let song = detail.song;
  let artist = detail.artist;
  let videoId = detail.videoId;
  let duration = Number(detail.duration);
  const audioTrackData = detail.audioTrackData;
  const isMusicVideo = detail.contentRect.width !== 0 && detail.contentRect.height !== 0;

  if (!videoId) {
    Utils.log(Constants.SERVER_ERROR_LOG, "Invalid video id");
    return;
  }

  // Try to get lyrics from cache with validation
  const cacheKey = `blyrics_${videoId}`;

  const cachedLyrics = await Storage.getTransientStorage(cacheKey);
  if (cachedLyrics) {
    try {
      const data = JSON.parse(cachedLyrics);
      // Validate cached data structure
      if (
        data &&
        (Array.isArray(data.lyrics) || data.syncedLyrics) &&
        data.version &&
        data.version === LYRIC_CACHE_VERSION
      ) {
        Utils.log(Constants.LYRICS_CACHE_FOUND_LOG);
        processLyrics(data);
        return;
      }
    } catch (cacheError) {
      Utils.log(Constants.CACHE_PARSING_ERROR, cacheError);
      // Invalid cache, continue to fetch fresh data
    }
  }

  // We should get recalled if we were executed without a valid song/artist and aren't able to get lyrics

  let segmentMap: SegmentMap | null = null;
  let matchingSong = await RequestSniffer.getMatchingSong(videoId, 1);
  let swappedVideoId = false;
  if (
    (!matchingSong ||
      !matchingSong.counterpartVideoId ||
      matchingSong.counterpartVideoId !== AppState.lastLoadedVideoId) &&
    AppState.lastLoadedVideoId !== videoId
  ) {
    DOM.renderLoader(); // Only render the loader after we've checked the cache & we're not switching between audio and video
    Translation.clearCache();
    matchingSong = await RequestSniffer.getMatchingSong(videoId);
  } else {
    Utils.log("Switching between audio/video: Skipping Loader");
  }
  if (isMusicVideo && matchingSong && matchingSong.counterpartVideoId && matchingSong.segmentMap) {
    Utils.log("Switching VideoId to Audio Id");
    swappedVideoId = true;
    videoId = matchingSong.counterpartVideoId;
    segmentMap = matchingSong.segmentMap;
  }

  const tabSelector = document.getElementsByClassName(Constants.TAB_HEADER_CLASS)[1];
  console.assert(tabSelector != null);
  if (tabSelector.getAttribute("aria-selected") !== "true") {
    Utils.log(Constants.LYRICS_TAB_HIDDEN_LOG);
    return;
  }

  song = song.trim();
  artist = artist.trim();
  artist = artist.replace(", & ", ", ");
  let album = await RequestSniffing.getSongAlbum(videoId);
  if (!album) {
    album = "";
  }

  // Check for empty strings after trimming
  if (!song || !artist) {
    Utils.log(Constants.SERVER_ERROR_LOG, "Empty song or artist name");
    return;
  }

  Utils.log(Constants.FETCH_LYRICS_LOG, song, artist);

  let lyrics: LyricSourceResult | null = null;
  let sourceMap = LyricProviders.newSourceMap();
  // We depend on the cubey lyrics to fetch certain metadata, so we always call it even if it isn't the top priority
  let providerParameters: ProviderParameters = {
    song,
    artist,
    duration,
    videoId,
    audioTrackData,
    album,
    sourceMap,
    alwaysFetchMetadata: swappedVideoId,
    signal,
  };

  let ytLyricsPromise = LyricProviders.getLyrics(providerParameters, "yt-lyrics").then(lyrics => {
    if (!AppState.areLyricsLoaded && lyrics) {
      Utils.log("[BetterLyrics] Temporarily Using YT Music Lyrics while we wait for synced lyrics to load");

      let lyricsWithMeta = {
        ...lyrics,
        song: providerParameters.song,
        artist: providerParameters.artist,
        duration: providerParameters.duration,
        videoId: providerParameters.videoId,
        album: providerParameters.album || "",
      };
      processLyrics(lyricsWithMeta, true);
    }
    return lyrics;
  });

  try {
    let cubyLyrics = (await LyricProviders.getLyrics(
      providerParameters,
      "musixmatch-richsync"
    )) as CubeyLyricSourceResult;
    if (cubyLyrics && cubyLyrics.album && cubyLyrics.album.length > 0 && album !== cubyLyrics.album) {
      providerParameters.album = cubyLyrics.album;
    }
    if (cubyLyrics && cubyLyrics.song && cubyLyrics.song.length > 0 && song !== cubyLyrics.song) {
      Utils.log("Using '" + cubyLyrics.song + "' for song instead of '" + song + "'");
      providerParameters.song = cubyLyrics.song;
    }

    if (cubyLyrics && cubyLyrics.artist && cubyLyrics.artist.length > 0 && artist !== cubyLyrics.artist) {
      Utils.log("Using '" + cubyLyrics.artist + "' for artist instead of '" + artist + "'");
      providerParameters.artist = cubyLyrics.artist;
    }

    if (cubyLyrics && cubyLyrics.duration && duration !== cubyLyrics.duration) {
      Utils.log("Using '" + cubyLyrics.duration + "' for duration instead of '" + duration + "'");
      providerParameters.duration = cubyLyrics.duration;
    }
  } catch (err) {
    Utils.log(err);
  }

  for (let provider of LyricProviders.providerPriority) {
    if (signal.aborted) {
      return;
    }

    try {
      let sourceLyrics = await LyricProviders.getLyrics(providerParameters, provider);

      if (sourceLyrics && sourceLyrics.lyrics && sourceLyrics.lyrics.length > 0) {
        let ytLyrics = (await ytLyricsPromise) as YTLyricSourceResult;

        if (ytLyrics !== null) {
          let lyricText = "";
          sourceLyrics.lyrics.forEach(lyric => {
            lyricText += lyric.words + "\n";
          });

          let matchAmount = stringSimilarity(lyricText.toLowerCase(), ytLyrics.text.toLowerCase());
          if (matchAmount < 0.5) {
            Utils.log(
              `Got lyrics from ${sourceLyrics.source}, but they don't match yt lyrics. Rejecting: Match: ${matchAmount}%`
            );
            continue;
          }
        }
        lyrics = sourceLyrics;
        break;
      }
    } catch (err) {
      Utils.log(err);
    }
  }

  if (!lyrics) {
    lyrics = {
      lyrics: [
        {
          startTimeMs: 0,
          words: Constants.NO_LYRICS_TEXT,
          durationMs: 0,
        },
      ],
      source: "Unknown",
      sourceHref: "",
      musicVideoSynced: false,
      cacheAllowed: false,
    };
  }

  if (!lyrics.lyrics) {
    throw new Error("Lyrics.lyrics is null or undefined. Report this bug");
  }

  if (isMusicVideo && !lyrics.musicVideoSynced && segmentMap) {
    Utils.log(segmentMap);
    // We're in a music video and need to sync lyrics to the music video
    const allZero = lyrics.lyrics.every(item => item.startTimeMs === 0);

    if (!allZero) {
      for (let lyricKey in lyrics.lyrics) {
        let lyric = lyrics.lyrics[lyricKey];
        let lastTimeChange = 0;
        for (let segment of segmentMap.segment) {
          if (lyric.startTimeMs >= segment.counterpartVideoStartTimeMilliseconds) {
            lastTimeChange = segment.primaryVideoStartTimeMilliseconds - segment.counterpartVideoStartTimeMilliseconds;
            if (lyric.startTimeMs <= segment.counterpartVideoStartTimeMilliseconds + segment.durationMilliseconds) {
              break;
            }
          }
        }
        lyric.startTimeMs = Number(lyric.startTimeMs) + lastTimeChange;
        if (lyric.parts) {
          lyric.parts.forEach(part => {
            part.startTimeMs = Number(part.startTimeMs) + lastTimeChange;
          });
        }
      }
    }
  }

  Utils.log("Got Lyrics from " + lyrics.source);

  // Preserve song and artist information in the lyrics data for the "Add Lyrics" button

  let lyricsWithMeta: LyricSourceResultWithMeta = {
    song: providerParameters.song,
    artist: providerParameters.artist,
    album: providerParameters.album || "",
    duration: providerParameters.duration,
    videoId: providerParameters.videoId,
    ...lyrics,
  };

  AppState.lastLoadedVideoId = detail.videoId;
  if (signal.aborted) {
    return;
  }
  cacheAndProcessLyrics(cacheKey, lyricsWithMeta);
}

/**
 * Caches lyrics data and initiates processing.
 *
 * @param cacheKey - Storage key for caching
 * @param data - Lyrics data to cache and process
 */
function cacheAndProcessLyrics(cacheKey: string, data: LyricSourceResultWithMeta): void {
  if (data.cacheAllowed) {
    let versionedData: LyricSourceResultWithMetaAndVersion = {
      version: LYRIC_CACHE_VERSION,
      ...data,
    };
    const oneWeekInMs = 7 * 24 * 60 * 60 * 1000;
    Storage.setTransientStorage(cacheKey, JSON.stringify(versionedData), oneWeekInMs);
  }
  processLyrics(data);
}

/**
 * Processes lyrics data and prepares it for rendering.
 * Sets language settings, validates data, and initiates DOM injection.
 *
 * @param data - Processed lyrics data
 * @param keepLoaderVisible
 * @param data.language - Language code for the lyrics
 * @param data.lyrics - Array of lyric lines
 */
function processLyrics(data: LyricSourceResultWithMeta, keepLoaderVisible = false): void {
  const lyrics = data.lyrics;
  if (!lyrics || lyrics.length === 0) {
    throw new Error(Constants.NO_LYRICS_FOUND_LOG);
  }

  Utils.log(Constants.LYRICS_FOUND_LOG);

  const ytMusicLyrics = document.querySelector(Constants.NO_LYRICS_TEXT_SELECTOR)?.parentElement;
  if (ytMusicLyrics) {
    ytMusicLyrics.classList.add("blyrics-hidden");
  }

  try {
    const lyricsElement = document.getElementsByClassName(Constants.LYRICS_CLASS)[0] as HTMLElement;
    lyricsElement.innerHTML = "";
  } catch (_err) {
    Utils.log(Constants.LYRICS_TAB_NOT_DISABLED_LOG);
  }

  injectLyrics(data, keepLoaderVisible);
}

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
function injectLyrics(data: LyricSourceResultWithMeta, keepLoaderVisible = false): void {
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
        if (lyricElement.dataset.romanized === "true") return;
        let romanizedLine = document.createElement("div");
        romanizedLine.classList.add(Constants.ROMANIZED_LYRICS_CLASS);

        if (item.timedRomanization) {
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

          let breakElm: HTMLSpanElement = document.createElement("span");
          breakElm.classList.add("blyrics--break");
          breakElm.style.order = "4";
          lyricElement.appendChild(breakElm);

          romanizedLine.style.order = "5";
          lyricElement.appendChild(romanizedLine);
          DOM.lyricsElementAdded();
          return;
        }

        let isNonLatin = containsNonLatin(item.words);
        if (Constants.romanizationLanguages.includes(source_language) || containsNonLatin(item.words)) {
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
              let breakElm: HTMLSpanElement = document.createElement("span");
              breakElm.classList.add("blyrics--break");
              breakElm.style.order = "4";
              lyricElement.appendChild(breakElm);

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

/**
 * @author Stephen Brown
 * Source: https://github.com/stephenjjbrown/string-similarity-js/
 * @licence MIT License - https://github.com/stephenjjbrown/string-similarity-js/blob/master/LICENSE.md
 * @param str1 First string to match
 * @param str2 Second string to match
 * @param [substringLength=2] Optional. Length of substring to be used in calculating similarity. Default 2.
 * @param [caseSensitive=false] Optional. Whether you want to consider case in string matching. Default false;
 * @returns Number between 0 and 1, with 0 being a low match score.
 */
const stringSimilarity = (str1: string, str2: string, substringLength = 2, caseSensitive = false): number => {
  if (!caseSensitive) {
    str1 = str1.toLowerCase();
    str2 = str2.toLowerCase();
  }
  if (str1.length < substringLength || str2.length < substringLength) return 0;
  const map = new Map<string, number>();
  for (let i = 0; i < str1.length - (substringLength - 1); i++) {
    const substr1 = str1.substring(i, i + substringLength);
    map.set(substr1, map.has(substr1) ? map.get(substr1)! + 1 : 1);
  }
  let match = 0;
  for (let j = 0; j < str2.length - (substringLength - 1); j++) {
    let substr2 = str2.substring(j, j + substringLength);
    let count = map.has(substr2) ? map.get(substr2)! : 0;
    if (count > 0) {
      map.set(substr2, count - 1);
      match++;
    }
  }
  return (match * 2) / (str1.length + str2.length - (substringLength - 1) * 2);
};

const testRtl = (text: string): boolean =>
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u.test(text);

/**
 * This regex is designed to detect any characters that are outside of the
 * standard "Basic Latin" and "Latin-1 Supplement" Unicode blocks, as well
 * as common "smart" punctuation like curved quotes.
 *
 * How it works:
 * [^...]     - This is a negated set, which matches any character NOT inside the brackets.
 * \x00-\xFF  - This range covers both the "Basic Latin" (ASCII) and "Latin-1 Supplement"
 * blocks. This includes English letters, numbers, common punctuation, and
 * most accented characters used in Western European languages (e.g., á, ö, ñ).
 * \u2018-\u201D - This range covers common "smart" or curly punctuation, including single
 * and double quotation marks/apostrophes (‘, ’, “, ”).
 */
const nonLatinRegex = /[^\p{Script_Extensions=Latin}\p{Script_Extensions=Common}]/u;

/**
 * Checks if a given string contains any non-Latin characters.
 * @param text The string to check.
 * @returns True if a non-Latin character is found, otherwise false.
 */
function containsNonLatin(text: string): boolean {
  return nonLatinRegex.test(text);
}
