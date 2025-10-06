// @ts-nocheck

import * as Utils from "../../core/utils";

interface Segment {
  primaryVideoStartTimeMilliseconds: number;
  counterpartVideoStartTimeMilliseconds: number;
  durationMilliseconds: number;
}

export interface SegmentMap {
  segment: Segment[];
  reversed?: boolean;
}

export interface LyricsInfo {
  hasLyrics: boolean;
  lyrics: string;
  sourceText: string;
}

interface CounterpartInfo {
  counterpartVideoId: string | null;
  segmentMap: SegmentMap | null;
}

const browseIdToVideoIdMap = new Map<string, string>();
const videoIdToLyricsMap = new Map<string, LyricsInfo>();
const counterpartVideoIdMap = new Map<string, CounterpartInfo>();
const videoIdToAlbumMap = new Map<string, string | null>();

let firstRequestMissedVideoId: string | null = null;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 *
 * @param videoId {string}
 * @param maxRetries {number}
 * @return {Promise<{hasLyrics: boolean, lyrics: string, sourceText: string}>}
 */
export async function getLyrics(videoId: string, maxRetries = 250): Promise<LyricsInfo> {
  if (videoIdToLyricsMap.has(videoId)) {
    return videoIdToLyricsMap.get(videoId);
  } else {
    let checkCount = 0;
    return await new Promise(resolve => {
      const checkInterval = setInterval(() => {
        if (videoIdToLyricsMap.has(videoId)) {
          clearInterval(checkInterval);
          resolve(videoIdToLyricsMap.get(videoId));
        }
        if (counterpartVideoIdMap.get(videoId)) {
          let counterpart = counterpartVideoIdMap.get(videoId).counterpartVideoId;
          if (videoIdToLyricsMap.has(counterpart)) {
            clearInterval(checkInterval);
            resolve(videoIdToLyricsMap.get(counterpart));
          }
        }
        if (checkCount > maxRetries) {
          clearInterval(checkInterval);
          Utils.log("Failed to sniff lyrics");
          resolve({hasLyrics: false, lyrics: "", sourceText: ""});
        }
        checkCount += 1;
      }, 20);
    });
  }
}

/**
 *
 * @param videoId {String}
 * @param maxCheckCount {number}
 * @return {Promise<{counterpartVideoId: (string | null), segmentMap: (SegmentMap | null)}>}
 */
export async function getMatchingSong(videoId: string, maxCheckCount = 250): Promise<CounterpartInfo | null> {
  if (counterpartVideoIdMap.has(videoId)) {
    return counterpartVideoIdMap.get(videoId);
  } else {
    let checkCount = 0;
    return await new Promise(resolve => {
      const checkInterval = setInterval(() => {
        if (counterpartVideoIdMap.has(videoId)) {
          let counterpart = counterpartVideoIdMap.get(videoId);
          clearInterval(checkInterval);
          resolve(counterpart);
        }
        if (checkCount > maxCheckCount) {
          clearInterval(checkInterval);
          Utils.log("Failed to find Segment Map for video");
          resolve(null);
        }
        checkCount += 1;
      }, 20);
    });
  }
}

/**
 * @param videoId {string}
 * @return {Promise<string | null | undefined>}
 */
export async function getSongAlbum(videoId: string): Promise<string | null | undefined> {
  for (let i = 0; i < 250; i++) {
    if (videoIdToAlbumMap.has(videoId)) {
      return videoIdToAlbumMap.get(videoId);
    }
    await delay(20);
  }
  Utils.log("Song album information didn't come in time for: ", videoId);
}

export function setupRequestSniffer(): void {
  let url = new URL(window.location.href);
  if (url.searchParams.has("v")) {
    firstRequestMissedVideoId = url.searchParams.get("v");
  }

  document.addEventListener("blyrics-send-response", (event: CustomEvent) => {
    let { /** @type string */ url, requestJson, responseJson} = event.detail;
    if (url.includes("https://music.youtube.com/youtubei/v1/next")) {
      let playlistPanelRendererContents =
        responseJson.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
          ?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content
          ?.playlistPanelRenderer?.contents;
      if (!playlistPanelRendererContents) {
        playlistPanelRendererContents =
          responseJson.onResponseReceivedEndpoints?.[0]?.queueUpdateCommand?.inlineContents?.playlistPanelRenderer
            ?.contents;
      }

      if (playlistPanelRendererContents) {
        for (let playlistPanelRendererContent of playlistPanelRendererContents) {
          let counterpartId =
            playlistPanelRendererContent?.playlistPanelVideoWrapperRenderer?.counterpart?.[0]?.counterpartRenderer
              ?.playlistPanelVideoRenderer?.videoId;
          let primaryId =
            playlistPanelRendererContent?.playlistPanelVideoWrapperRenderer?.primaryRenderer
              ?.playlistPanelVideoRenderer?.videoId;

          /**
           * @type {SegmentMap}
           */
          let segmentMap =
            playlistPanelRendererContent?.playlistPanelVideoWrapperRenderer?.counterpart?.[0]?.segmentMap;

          if (counterpartId && primaryId) {
            /**
             * @type {SegmentMap | null}
             */
            let reversedSegmentMap: SegmentMap | null = null;

            if (segmentMap && segmentMap.segment) {
              for (let segment of segmentMap.segment) {
                segment.counterpartVideoStartTimeMilliseconds = Number(segment.counterpartVideoStartTimeMilliseconds);
                segment.primaryVideoStartTimeMilliseconds = Number(segment.primaryVideoStartTimeMilliseconds);
                segment.durationMilliseconds = Number(segment.durationMilliseconds);
              }
              reversedSegmentMap = {segment: [], reversed: true};
              for (let segment of segmentMap.segment) {
                reversedSegmentMap.segment.push({
                  primaryVideoStartTimeMilliseconds: segment.counterpartVideoStartTimeMilliseconds,
                  counterpartVideoStartTimeMilliseconds: segment.primaryVideoStartTimeMilliseconds,
                  durationMilliseconds: segment.durationMilliseconds,
                });
              }
            }

            counterpartVideoIdMap.set(primaryId, {counterpartVideoId: counterpartId, segmentMap});
            counterpartVideoIdMap.set(counterpartId, {
              counterpartVideoId: primaryId,
              segmentMap: reversedSegmentMap,
            });
          } else {
            let primaryId = playlistPanelRendererContent?.playlistPanelVideoRenderer?.videoId;
            if (primaryId) {
              counterpartVideoIdMap.set(primaryId, {counterpartVideoId: null, segmentMap: null});
            }
          }
        }
      }

      let videoId = requestJson.videoId;
      let playlistId = requestJson.playlistId;

      if (!videoId) {
        videoId = responseJson.currentVideoEndpoint?.watchEndpoint?.videoId;
      }
      if (!playlistId) {
        playlistId = responseJson.currentVideoEndpoint?.watchEndpoint?.playlistId;
      }

      let album =
        responseJson?.playerOverlays?.playerOverlayRenderer?.browserMediaSession?.browserMediaSessionRenderer?.album
          ?.runs[0]?.text;

      videoIdToAlbumMap.set(videoId, album);
      if (counterpartVideoIdMap.has(videoId)) {
        let counterpart = counterpartVideoIdMap.get(videoId).counterpartVideoId;
        if (counterpart) {
          videoIdToAlbumMap.set(counterpart, album);
        }
      }

      if (!videoId) {
        return;
      }

      let lyricsTab =
        responseJson.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
          ?.watchNextTabbedResultsRenderer?.tabs[1]?.tabRenderer;
      if (lyricsTab && lyricsTab.unselectable) {
        videoIdToLyricsMap.set(videoId, {hasLyrics: false, lyrics: "", sourceText: ""});
      } else {
        let browseId = lyricsTab.endpoint?.browseEndpoint?.browseId;
        if (browseId) {
          browseIdToVideoIdMap.set(browseId, videoId);
        }
      }
    } else if (url.includes("https://music.youtube.com/youtubei/v1/browse")) {
      let browseId = requestJson.browseId;
      let videoId = browseIdToVideoIdMap.get(browseId);

      if (browseId !== undefined && videoId === undefined && firstRequestMissedVideoId !== null) {
        // it is possible that we missed the first request, so let's just try it with this id
        videoId = firstRequestMissedVideoId;
      }

      if (videoId !== undefined) {
        let lyrics =
          responseJson.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer?.description
            ?.runs?.[0]?.text;
        let sourceText =
          responseJson.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer?.footer?.runs?.[0]
            ?.text;
        if (lyrics && sourceText) {
          videoIdToLyricsMap.set(videoId, {hasLyrics: true, lyrics, sourceText});
          if (videoId === firstRequestMissedVideoId) {
            browseIdToVideoIdMap.set(browseId, videoId);
            firstRequestMissedVideoId = null;
          }
        } else {
          videoIdToLyricsMap.set(videoId, {hasLyrics: false, lyrics: null, sourceText: null});
        }
      }
    }
  });
}
