/**
 * @fileoverview Main lyrics handling module for
 * Manages lyrics fetching, caching, processing, and rendering.
 */

import * as Constants from "@constants";
import * as Storage from "@core/storage";
import { injectLyrics } from "@modules/lyrics/injectLyrics";
import { stringSimilarity } from "@modules/lyrics/lyricParseUtils";
import * as DOM from "@modules/ui/dom";
import * as Utils from "@utils";
import type { PlayerDetails } from "@/index";
import { AppState } from "@/index";
import type { CubeyLyricSourceResult } from "./providers/cubey";
import type { LyricSourceResult, ProviderParameters } from "./providers/shared";
import * as LyricProviders from "./providers/shared";
import type { YTLyricSourceResult } from "./providers/yt";
import type { SegmentMap } from "./requestSniffer";
import * as RequestSniffer from "./requestSniffer";
import * as RequestSniffing from "./requestSniffer";
import * as Translation from "./translation";

/** Current version of the lyrics cache format */
const LYRIC_CACHE_VERSION = "1.3.0";

export type LyricSourceResultWithMeta = LyricSourceResult & {
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
    Utils.log("Applying segment map", segmentMap);
    // We're in a music video and need to sync lyrics to the music video
    const allZero = lyrics.lyrics.every(item => item.startTimeMs === 0);

    if (!allZero) {
      for (let lyric of lyrics.lyrics) {
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
        if (lyric.timedRomanization) {
          lyric.timedRomanization.forEach(part => {
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
