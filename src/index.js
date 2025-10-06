/**
 * Player state details object passed from YouTube Music player
 * @typedef {Object} PlayerDetails
 * @property {number} currentTime - Current playback time in seconds
 * @property {string} videoId - YouTube video ID
 * @property {string} song - Song title
 * @property {string} artist - Artist name
 * @property {string} duration - Total duration of the track
 * @property {AudioTrackData} audioTrackData - Audio track and caption data
 * @property {number} browserTime - Browser timestamp in milliseconds
 * @property {boolean} playing - Whether the song/video is currently playing
 * @property {Object} contentRect - Dimensions of the player
 * @property {number} contentRect.width - Player width
 * @property {number} contentRect.height - Player height
 */

import * as Utils from "./core/utils";
import * as DOM from "./modules/ui/dom";
import * as Observer from "./modules/ui/observer";
import * as Settings from "./modules/settings/settings";
import * as Constants from "./core/constants";
import * as RequestSniffing from "./modules/lyrics/requestSniffer";
import * as Providers from "./modules/lyrics/providers";
import * as Lyrics from "./modules/lyrics/lyrics";
import * as Storage from "./core/storage";


export let AppState = {
  /** @type {boolean} Whether lyrics are currently syncing with playback */
  areLyricsTicking: false,
  /** @type {LyricsData|null} Current lyric data object */
  lyricData: null,
  /** @type {boolean} Whether lyrics have been successfully loaded */
  areLyricsLoaded: false,
  /** @type {boolean} Whether lyric injection has failed */
  lyricInjectionFailed: false,
  /** @type {string | null} ID of the last processed video */
  lastVideoId: null,
  /** @type {string|null} Details of the last processed video */
  lastVideoDetails: null,
  /** @type {Promise|null} Promise for the ongoing lyric injection process */
  lyricInjectionPromise: null,
  /** @type {boolean} Whether lyric injection is queued */
  queueLyricInjection: false,
  /** @type {boolean} Whether album art injection is queued */
  queueAlbumArtInjection: false,
  /** @type {string|boolean} Album art injection status */
  shouldInjectAlbumArt: "Unknown",
  /** @type {boolean} Whether song details injection is queued */
  queueSongDetailsInjection: false,
  /** @type {number|null} Timeout ID for loader animation end */
  loaderAnimationEndTimeout: null,
  /** @type {string|null} ID of the last loaded video */
  lastLoadedVideoId: null,
  /** @type {AbortController|null} Abort controller for lyric fetching */
  lyricAbortController: null,
}


/**
 * Initializes the BetterLyrics extension by setting up all required components.
 * This method orchestrates the setup of logging, DOM injection, observers, settings,
 * storage, and lyric providers.
 */
export async function modify() {
  Utils.setUpLog();
  await DOM.injectHeadTags();
  Observer.enableLyricsTab();
  Settings.hideCursorOnIdle();
  Settings.handleSettings();
  Storage.subscribeToCustomCSS();
  await Storage.purgeExpiredKeys();
  await Storage.saveCacheInfo();
  Settings.listenForPopupMessages();
  Observer.lyricReloader();
  Observer.initializeLyrics();
  Observer.disableInertWhenFullscreen();
  Providers.initProviders()
  Utils.log(
    Constants.INITIALIZE_LOG,
    "background: rgba(10,11,12,1) ; color: rgba(214, 250, 214,1) ; padding: 0.5rem 0.75rem; border-radius: 0.5rem; font-size: 1rem; "
  );

  Settings.onAlbumArtEnabled(
    () => (AppState.shouldInjectAlbumArt = true),
    () => (AppState.shouldInjectAlbumArt = false)
  );
}

/**
 * Handles modifications to player state and manages lyric injection.
 * Ensures only one lyric injection process runs at a time by queueing subsequent calls.
 *
 * @param {PlayerDetails} detail - Player state details
 */
export function handleModifications(detail) {
  if (AppState.lyricInjectionPromise) {
    AppState.lyricAbortController.abort("New song is being loaded");
    AppState.lyricInjectionPromise.then(() => {
      AppState.lyricInjectionPromise = null;
      this.handleModifications(detail);
    });
  } else {
    AppState.lyricAbortController = new AbortController();
    AppState.lyricInjectionPromise = Lyrics.createLyrics(detail, AppState.lyricAbortController.signal)
      .then(() => {
        return DOM.tickLyrics(detail.currentTime, Date.now(), detail.playing);
      })
      .catch(err => {
        Utils.log(Constants.GENERAL_ERROR_LOG, err);
        AppState.areLyricsLoaded = false;
        AppState.lyricInjectionFailed = true;
      });
  }
}

/**
 * Reloads lyrics by resetting the last video ID.
 * Forces the extension to re-fetch lyrics for the current video.
 */
export function reloadLyrics() {
  AppState.lastVideoId = null;
}

/**
 * Initializes the application by setting up the DOM content loaded event listener.
 * Entry point for the BetterLyrics extension.
 */
export function init() {
  document.addEventListener("DOMContentLoaded", modify);
}


// Initialize the application
init();

RequestSniffing.setupRequestSniffer();
DOM.injectGetSongInfo();
