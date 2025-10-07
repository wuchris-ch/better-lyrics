/**
 * Handles the Turnstile challenge by creating an iframe and returning a Promise.
 * The visibility of the iframe can be controlled for testing purposes.
 * @returns A promise that resolves with the Turnstile token.
 */
function handleTurnstile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.src = CUBEY_LYRICS_API_URL + "challenge";

    iframe.style.position = "fixed";
    iframe.style.bottom = "calc(20px + var(--ytmusic-player-bar-height))";
    iframe.style.right = "20px";
    iframe.style.width = "0px";
    iframe.style.height = "0px";
    iframe.style.border = "none";
    iframe.style.zIndex = "999999";
    document.body.appendChild(iframe);

    const messageListener = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) {
        return;
      }

      switch (event.data.type) {
        case "turnstile-token":
          Utils.log("[BetterLyrics] ✅ Received Success Token:", event.data.token);
          cleanup();
          resolve(event.data.token);
          break;

        case "turnstile-error":
          console.error("[BetterLyrics] ❌ Received Challenge Error:", event.data.error);
          cleanup();
          reject(new Error(`[BetterLyrics] Turnstile challenge error: ${event.data.error}`));
          break;

        case "turnstile-expired":
          console.warn("⚠️ Token expired. Resetting challenge.");
          iframe.contentWindow!.postMessage({ type: "reset-turnstile" }, "*");
          break;

        case "turnstile-timeout":
          console.warn("[BetterLyrics] ⏳ Challenge timed out.");
          cleanup();
          reject(new Error("[BetterLyrics] Turnstile challenge timed out."));
          break;
        default:
          break;
      }
    };

    const cleanup = () => {
      window.removeEventListener("message", messageListener);
      if (document.body.contains(iframe)) {
        document.body.removeChild(iframe);
      }
    };

    window.addEventListener("message", messageListener);
  });
}

const CUBEY_LYRICS_API_URL = "https://lyrics.api.dacubeking.com/";

/**
 * Lyrics provider management for the BetterLyrics extension.
 * Handles multiple lyrics sources and provider orchestration.
 *
 */

interface AudioTrackData {
  id: string;
  kc: {
    name: string;
    id: string;
    isDefault: boolean;
  };
  captionTracks: {
    languageCode: string;
    languageName: string;
    kind: string;
    name: string;
    displayName: string;
    id: string | null;
    j: boolean;
    isTranslateable: boolean;
    url: string;
    vssId: string;
    isDefault: boolean;
    translationLanguage: string | null;
    xtags: string;
    captionId: string;
  }[];
  C: any;
  xtags: string;
  G: boolean;
  j: any | null;
  B: string;
  captionsInitialState: string;
}

interface LyricSource {
  filled: boolean;
  lyricSourceResult: LyricSourceResult | CubeyLyricSourceResult | YTLyricSourceResult | null;
  lyricSourceFiller: (providerParameters: ProviderParameters) => Promise<void>;
}

export interface LyricSourceResult {
  lyrics: Lyric[] | null;
  language?: string | null;
  source: string;
  sourceHref: string;
  musicVideoSynced?: boolean | null;
  cacheAllowed?: boolean;
}

export type CubeyLyricSourceResult = LyricSourceResult & {
  album: string;
  artist: string;
  duration: number;
  song: string;
};

export type YTLyricSourceResult = LyricSourceResult & {
  text: string;
};

type LyricsArray = Lyric[];

interface Lyric {
  startTimeMs: number;
  words: string;
  durationMs: number;
  parts?: LyricPart[];
}

interface LyricPart {
  startTimeMs: number;
  words: string;
  durationMs: number;
}

export interface ProviderParameters {
  song: string;
  artist: string;
  duration: number;
  videoId: string;
  audioTrackData: AudioTrackData;
  album: string | null;
  sourceMap: SourceMapType;
  alwaysFetchMetadata: boolean;
  signal: AbortSignal;
}

export type SourceMapType = {
  [key in LyricSourceKey]: LyricSource;
};

import * as Utils from "../../core/utils";
import * as Constants from "../../core/constants";
import * as RequestSniffing from "./requestSniffer";

/**
 *
 * @param providerParameters
 */
async function cubey(providerParameters: ProviderParameters): Promise<void> {
  /**
   * Gets a valid JWT, either from storage or by forcing a new Turnstile challenge.
   * @param [forceNew=false] - If true, ignores and overwrites any stored token.
   * @returns A promise that resolves with the JWT.
   */
  async function getAuthenticationToken(forceNew = false): Promise<string | null> {
    function isJwtExpired(token: string): boolean {
      try {
        const payloadBase64Url = token.split(".")[1];
        if (!payloadBase64Url) return true;
        const payloadBase64 = payloadBase64Url.replace(/-/g, "+").replace(/_/g, "/");
        const decodedPayload = atob(payloadBase64);
        const payload = JSON.parse(decodedPayload);
        const expirationTimeInSeconds = payload.exp;
        if (!expirationTimeInSeconds) return true;
        const nowInSeconds = Date.now() / 1000;
        return nowInSeconds > expirationTimeInSeconds;
      } catch (e) {
        console.error("[BetterLyrics] Error decoding JWT on client-side:", e);
        return true;
      }
    }

    if (forceNew) {
      Utils.log("[BetterLyrics] Forcing new token, removing any existing one.");
      await chrome.storage.local.remove("jwtToken");
    } else {
      const storedData = await chrome.storage.local.get("jwtToken");
      if (storedData.jwtToken) {
        if (isJwtExpired(storedData.jwtToken)) {
          Utils.log("[BetterLyrics]Local JWT has expired. Removing and requesting a new one.");
          await chrome.storage.local.remove("jwtToken");
        } else {
          Utils.log("[BetterLyrics] 🔑 Using valid, non-expired JWT for bypass.");
          return storedData.jwtToken;
        }
      }
    }

    try {
      Utils.log("[BetterLyrics] No valid JWT found, initiating Turnstile challenge...");
      const turnstileToken = await handleTurnstile();

      const response = await fetch(CUBEY_LYRICS_API_URL + "verify-turnstile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: turnstileToken }),
        credentials: "include",
      });

      if (!response.ok) throw new Error(`API verification failed: ${response.statusText}`);

      const data = await response.json();
      const newJwt = data.jwt;

      if (!newJwt) throw new Error("No JWT returned from API after verification.");

      await chrome.storage.local.set({ jwtToken: newJwt });
      Utils.log("[BetterLyrics] ✅ New JWT received and stored.");
      return newJwt;
    } catch (error) {
      console.error("[BetterLyrics] Authentication process failed:", error);
      return null;
    }
  }

  /**
   * Helper to construct and send the API request.
   * @param jwt - The JSON Web Token for authorization.
   * @returns The fetch Response object.
   */
  async function makeApiCall(jwt: string): Promise<Response> {
    const url = new URL(CUBEY_LYRICS_API_URL + "lyrics");
    url.searchParams.append("song", providerParameters.song);
    url.searchParams.append("artist", providerParameters.artist);
    url.searchParams.append("duration", String(providerParameters.duration));
    url.searchParams.append("videoId", providerParameters.videoId);
    if (providerParameters.album) {
      url.searchParams.append("album", providerParameters.album);
    }
    url.searchParams.append("alwaysFetchMetadata", String(providerParameters.alwaysFetchMetadata));

    return await fetch(url.toString(), {
      signal: AbortSignal.any([providerParameters.signal, AbortSignal.timeout(10000)]),
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
      credentials: "include",
    });
  }

  let jwt = await getAuthenticationToken();
  if (!jwt) {
    console.error("[BetterLyrics] Could not obtain an initial authentication token. Aborting lyrics fetch.");
    // Mark sources as filled to prevent retries
    (["musixmatch-synced", "musixmatch-richsync", "lrclib-synced", "lrclib-plain"] as LyricSourceKey[]).forEach(
      source => {
        providerParameters.sourceMap[source].filled = true;
      }
    );
    return;
  }

  let response = await makeApiCall(jwt);

  // If the request is forbidden (403), it's likely a WAF block.
  // Invalidate the current JWT and try one more time with a fresh one.
  if (response.status === 403) {
    console.warn(
      "[BetterLyrics] Request was blocked (403 Forbidden), possibly by WAF. Forcing new Turnstile challenge."
    );
    jwt = await getAuthenticationToken(true); // `true` forces a new token

    if (!jwt) {
      console.error("[BetterLyrics] Could not obtain a new token after WAF block. Aborting.");
      (["musixmatch-synced", "musixmatch-richsync", "lrclib-synced", "lrclib-plain"] as const).forEach(source => {
        providerParameters.sourceMap[source].filled = true;
      });
      return;
    }

    Utils.log("[BetterLyrics] Retrying API call with new token...");
    response = await makeApiCall(jwt);
  }

  if (!response.ok) {
    console.error(`[BetterLyrics] API request failed with status: ${response.status}`);
    (["musixmatch-synced", "musixmatch-richsync", "lrclib-synced", "lrclib-plain"] as const).forEach(source => {
      providerParameters.sourceMap[source].filled = true;
    });
    return;
  }

  const responseData = await response.json();

  if (responseData.album) {
    Utils.log("[BetterLyrics] Found Album: " + responseData.album);
  }

  if (responseData.musixmatchWordByWordLyrics) {
    let musixmatchWordByWordLyrics = parseLRC(
      responseData.musixmatchWordByWordLyrics,
      Number(providerParameters.duration)
    );
    lrcFixers(musixmatchWordByWordLyrics);

    providerParameters.sourceMap["musixmatch-richsync"].lyricSourceResult = {
      lyrics: musixmatchWordByWordLyrics,
      source: "Musixmatch",
      sourceHref: "https://www.musixmatch.com",
      musicVideoSynced: false,
      album: responseData.album,
      artist: responseData.artist,
      song: responseData.song,
      duration: responseData.duration,
      cacheAllowed: true,
    };
  } else {
    providerParameters.sourceMap["musixmatch-richsync"].lyricSourceResult = {
      lyrics: null,
      source: "Musixmatch",
      sourceHref: "https://www.musixmatch.com",
      musicVideoSynced: false,
      album: responseData.album,
      artist: responseData.artist,
      song: responseData.song,
      duration: responseData.duration,
      cacheAllowed: true,
    };
  }

  if (responseData.musixmatchSyncedLyrics) {
    let musixmatchSyncedLyrics = parseLRC(responseData.musixmatchSyncedLyrics, Number(providerParameters.duration));
    providerParameters.sourceMap["musixmatch-synced"].lyricSourceResult = {
      lyrics: musixmatchSyncedLyrics,
      source: "Musixmatch",
      sourceHref: "https://www.musixmatch.com",
      musicVideoSynced: false,
    };
  }

  if (responseData.lrclibSyncedLyrics) {
    let lrclibSyncedLyrics = parseLRC(responseData.lrclibSyncedLyrics, Number(providerParameters.duration));
    providerParameters.sourceMap["lrclib-synced"].lyricSourceResult = {
      lyrics: lrclibSyncedLyrics,
      source: "LRCLib",
      sourceHref: "https://lrclib.net",
      musicVideoSynced: false,
    };
  }

  if (responseData.lrclibPlainLyrics) {
    let lrclibPlainLyrics = parsePlainLyrics(responseData.lrclibPlainLyrics);

    providerParameters.sourceMap["lrclib-plain"].lyricSourceResult = {
      lyrics: lrclibPlainLyrics,
      source: "LRCLib",
      sourceHref: "https://lrclib.net",
      musicVideoSynced: false,
      cacheAllowed: false,
    };
  }

  (["musixmatch-synced", "musixmatch-richsync", "lrclib-synced", "lrclib-plain"] as const).forEach(source => {
    providerParameters.sourceMap[source].filled = true;
  });
}

/**
 *
 * @param providerParameters
 */
async function bLyrics(providerParameters: ProviderParameters): Promise<void> {
  // Fetch from the primary API if cache is empty or invalid
  const url = new URL(Constants.LYRICS_API_URL);
  url.searchParams.append("s", providerParameters.song);
  url.searchParams.append("a", providerParameters.artist);
  url.searchParams.append("d", String(providerParameters.duration));

  const response = await fetch(url.toString(), {
    signal: AbortSignal.any([providerParameters.signal, AbortSignal.timeout(10000)]),
  });

  if (!response.ok) {
    providerParameters.sourceMap["bLyrics"].filled = true;
    providerParameters.sourceMap["bLyrics"].lyricSourceResult = null;
  }

  const data = await response.json();
  // Validate API response structure
  if (!data || (!Array.isArray(data.lyrics) && !data.syncedLyrics)) {
    providerParameters.sourceMap["bLyrics"].filled = true;
    providerParameters.sourceMap["bLyrics"].lyricSourceResult = null;
  }

  data.source = "boidu.dev";
  data.sourceHref = "https://better-lyrics.boidu.dev";

  providerParameters.sourceMap["bLyrics"].filled = true;
  providerParameters.sourceMap["bLyrics"].lyricSourceResult = data;
}

/**
 * @param providerParameters
 */
async function lyricLib(providerParameters: ProviderParameters): Promise<void> {
  const url = new URL(Constants.LRCLIB_API_URL);
  url.searchParams.append("track_name", providerParameters.song);
  url.searchParams.append("artist_name", providerParameters.artist);
  if (providerParameters.album) {
    url.searchParams.append("album_name", providerParameters.album);
  }
  url.searchParams.append("duration", String(providerParameters.duration));

  const response = await fetch(url.toString(), {
    headers: {
      "Lrclib-Client": Constants.LRCLIB_CLIENT_HEADER,
    },
    signal: AbortSignal.any([providerParameters.signal, AbortSignal.timeout(10000)]),
  });

  if (!response.ok) {
    providerParameters.sourceMap["lrclib-synced"].filled = true;
    providerParameters.sourceMap["lrclib-plain"].filled = true;
    providerParameters.sourceMap["lrclib-synced"].lyricSourceResult = null;
    providerParameters.sourceMap["lrclib-plain"].lyricSourceResult = null;
  }

  const data = await response.json();

  if (data) {
    Utils.log(Constants.LRCLIB_LYRICS_FOUND_LOG);

    if (data.syncedLyrics) {
      providerParameters.sourceMap["lrclib-synced"].lyricSourceResult = {
        lyrics: parseLRC(data.syncedLyrics, data.duration),
        source: "LRCLib",
        sourceHref: "https://lrclib.net",
        musicVideoSynced: false,
      };
    }
    if (data.plainLyrics) {
      providerParameters.sourceMap["lrclib-plain"].lyricSourceResult = {
        lyrics: parsePlainLyrics(data.plainLyrics),
        source: "LRCLib",
        sourceHref: "https://lrclib.net",
        musicVideoSynced: false,
        cacheAllowed: false,
      };
    }
  }

  providerParameters.sourceMap["lrclib-synced"].filled = true;
  providerParameters.sourceMap["lrclib-plain"].filled = true;
}

/**
 * @param providerParameters
 */
async function ytLyrics(providerParameters: ProviderParameters): Promise<void> {
  let lyricsObj = await RequestSniffing.getLyrics(providerParameters.videoId);
  if (lyricsObj.hasLyrics) {
    let lyricsText = lyricsObj.lyrics!;
    let sourceText = lyricsObj.sourceText!.substring(8) + " (via YT)";

    let lyricsArray = parsePlainLyrics(lyricsText);
    providerParameters.sourceMap["yt-lyrics"].lyricSourceResult = {
      lyrics: lyricsArray,
      text: lyricsText,
      source: sourceText,
      sourceHref: "",
      musicVideoSynced: false,
      cacheAllowed: false,
    };
  }

  providerParameters.sourceMap["yt-lyrics"].filled = true;
}

/**
 *
 * @param providerParameters
 * @return
 */
async function ytCaptions(providerParameters: ProviderParameters): Promise<void> {
  let audioTrackData = providerParameters.audioTrackData;
  if (audioTrackData.captionTracks.length === 0) {
    return;
  }

  let langCode: string | null = null;
  if (audioTrackData.captionTracks.length === 1) {
    langCode = audioTrackData.captionTracks[0].languageCode;
  } else {
    // Try and determine the language by finding an auto generated track
    // TODO: This sucks as a method
    for (let captionTracksKey in audioTrackData.captionTracks) {
      let data = audioTrackData.captionTracks[captionTracksKey];
      if (data.displayName.includes("auto-generated")) {
        langCode = data.languageCode;
        break;
      }
    }
  }

  if (!langCode) {
    Utils.log("Found Caption Tracks, but couldn't determine the default", audioTrackData);
    providerParameters.sourceMap["yt-captions"].filled = true;
    providerParameters.sourceMap["yt-captions"].lyricSourceResult = null;
  }

  let captionsUrl: URL | null = null;
  for (let captionTracksKey in audioTrackData.captionTracks) {
    let data = audioTrackData.captionTracks[captionTracksKey];
    if (!data.displayName.includes("auto-generated") && data.languageCode === langCode) {
      captionsUrl = new URL(data.url);
      break;
    }
  }

  if (!captionsUrl) {
    Utils.log("Only found auto generated lyrics for youtube captions, not using", audioTrackData);
    providerParameters.sourceMap["yt-captions"].filled = true;
    providerParameters.sourceMap["yt-captions"].lyricSourceResult = null;
    return;
  }

  captionsUrl = new URL(captionsUrl);
  captionsUrl.searchParams.set("fmt", "json3");

  let captionData = await fetch(captionsUrl.toString(), {
    method: "GET",
    signal: AbortSignal.any([providerParameters.signal, AbortSignal.timeout(10000)]),
  }).then(response => response.json());

  /**
   * @type {LyricsArray}
   */
  let lyricsArray: LyricsArray = [];

  captionData.events.forEach((event: { segs: { [x: string]: { utf8: string } }; tStartMs: any; dDurationMs: any }) => {
    let words = "";
    for (let segsKey in event.segs) {
      words += event.segs[segsKey].utf8;
    }
    words = words.replace(/\n/g, " ");
    for (let c of Constants.MUSIC_NOTES) {
      words = words.trim();
      if (words.startsWith(c)) {
        words = words.substring(1);
      }
      if (words.endsWith(c)) {
        words = words.substring(0, words.length - 1);
      }
    }
    words = words.trim();
    lyricsArray.push({
      startTimeMs: event.tStartMs,
      words: words,
      durationMs: event.dDurationMs,
    });
  });

  let allCaps = lyricsArray.every(lyric => {
    return lyric.words.toUpperCase() === lyric.words;
  });

  if (allCaps) {
    lyricsArray.every(lyric => {
      lyric.words = lyric.words.substring(0, 1).toUpperCase() + lyric.words.substring(1).toLowerCase();
      return true;
    });
  }

  providerParameters.sourceMap["yt-captions"].filled = true;
  providerParameters.sourceMap["yt-captions"].lyricSourceResult = {
    lyrics: lyricsArray,
    language: langCode,
    source: "Youtube Captions",
    sourceHref: "",
    musicVideoSynced: true,
  };
}

let defaultPreferredProviderList = [
  "musixmatch-richsync",
  "yt-captions",
  "lrclib-synced",
  "musixmatch-synced",
  "bLyrics",
  "yt-lyrics",
  "lrclib-plain",
] as const;

function isLyricSourceKey(provider: string): provider is LyricSourceKey {
  return defaultPreferredProviderList.includes(provider as LyricSourceKey);
}

export let providerPriority: LyricSourceKey[] = [];

export function initProviders(): void {
  const updateProvidersList = (preferredProviderList: string[] | null) => {
    let activeProviderList: string[] = preferredProviderList ?? [...defaultPreferredProviderList];

    const isValid = defaultPreferredProviderList.every(provider => {
      return activeProviderList.includes(provider) || activeProviderList.includes(`d_${provider}`);
    });

    if (!isValid) {
      activeProviderList = [...defaultPreferredProviderList];
      Utils.log("Invalid preferred provider list, resetting to default");
    }

    // Use the type guard. The resulting array is known to be LyricSourceKey[]
    const finalProviderList = activeProviderList.filter(isLyricSourceKey);

    Utils.log(Constants.PROVIDER_SWITCHED_LOG, finalProviderList);
    providerPriority = finalProviderList;
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.preferredProviderList) {
      updateProvidersList(changes.preferredProviderList.newValue);
    }
  });

  chrome.storage.sync.get({ preferredProviderList: null }, function (items) {
    updateProvidersList(items.preferredProviderList);
  });
}

const sourceKeyToFillFn = {
  "musixmatch-richsync": cubey,
  "musixmatch-synced": cubey,
  "lrclib-synced": lyricLib,
  "lrclib-plain": lyricLib,
  bLyrics: bLyrics,
  "yt-captions": ytCaptions,
  "yt-lyrics": ytLyrics,
} as const;

export type LyricSourceKey = Readonly<keyof typeof sourceKeyToFillFn>;

export function newSourceMap() {
  function mapValues<T extends object, U>(obj: T, fn: (value: T[keyof T], key: keyof T) => U): { [K in keyof T]: U } {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [key, fn(value as T[keyof T], key as keyof T)])
    ) as { [K in keyof T]: U };
  }

  return mapValues(sourceKeyToFillFn, filler => ({
    filled: false,
    lyricSourceResult: null,
    lyricSourceFiller: filler,
  }));
}

/**
 * @param providerParameters
 * @param source
 */
export async function getLyrics(
  providerParameters: ProviderParameters,
  source: LyricSourceKey
): Promise<LyricSourceResult | null> {
  let lyricSource = providerParameters.sourceMap[source];
  if (!lyricSource.filled) {
    await lyricSource.lyricSourceFiller(providerParameters);
  }
  return lyricSource.lyricSourceResult;
}

const possibleIdTags = ["ti", "ar", "al", "au", "lr", "length", "by", "offset", "re", "tool", "ve", "#"];
/**
 *
 * @param lrcText
 * @param songDuration
 * @return
 */
function parseLRC(lrcText: string, songDuration: number): LyricsArray {
  const lines = lrcText.split("\n");
  const result: LyricsArray = [];
  const idTags = {} as any;

  // Parse time in [mm:ss.xx] or <mm:ss.xx> format to milliseconds
  function parseTime(timeStr: string): number | null {
    const match = timeStr.match(/(\d+):(\d+\.\d+)/);
    if (!match) return null;
    const minutes = parseInt(match[1], 10);
    const seconds = parseFloat(match[2]);
    return Math.round((minutes * 60 + seconds) * 1000);
  }

  // Process each line
  lines.forEach(line => {
    line = line.trim();

    // Match ID tags [type:value]
    const idTagMatch = line.match(/^[\[](\w+):(.*)[\]]$/);
    if (idTagMatch && possibleIdTags.includes(idTagMatch[1])) {
      idTags[idTagMatch[1]] = idTagMatch[2];
      return;
    }

    // Match time tags with lyrics
    const timeTagRegex = /[\[](\d+:\d+\.\d+)[\]]/g;
    const enhancedWordRegex = /<(\d+:\d+\.\d+)>/g;

    const timeTags: number[] = [];
    let match;
    while ((match = timeTagRegex.exec(line)) !== null) {
      timeTags.push(<number>parseTime(match[1]));
    }

    if (timeTags.length === 0) return; // Skip lines without time tags

    const lyricPart = line.replace(timeTagRegex, "").trim();

    // Extract enhanced lyrics (if available)
    const parts: LyricPart[] = [];
    let lastTime: number | null = null;
    let plainText = "";

    lyricPart.split(enhancedWordRegex).forEach((fragment, index) => {
      if (index % 2 === 0) {
        // This is a word or plain text segment
        if (fragment.length > 0 && fragment[0] === " ") {
          fragment = fragment.substring(1);
        }
        if (fragment.length > 0 && fragment[fragment.length - 1] === " ") {
          fragment = fragment.substring(0, fragment.length - 1);
        }
        plainText += fragment;
        if (parts.length > 0 && parts[parts.length - 1].startTimeMs) {
          parts[parts.length - 1].words += fragment;
        }
      } else {
        // This is a timestamp
        const startTime = <number>parseTime(fragment);
        if (lastTime !== null && parts.length > 0) {
          parts[parts.length - 1].durationMs = startTime - lastTime;
        }
        parts.push({
          startTimeMs: startTime,
          words: "",
          durationMs: 0,
        });
        lastTime = startTime;
      }
    });

    // Calculate fallback duration and add entry
    const startTime = Math.min(...timeTags);
    const endTime = Math.max(...timeTags);
    const duration = endTime - startTime;

    result.push({
      startTimeMs: startTime,
      words: plainText.trim(),
      durationMs: duration,
      parts: parts.length > 0 ? parts : undefined,
    });
  });
  result.forEach((lyric, index) => {
    if (index + 1 < result.length) {
      const nextLyric = result[index + 1];
      if (lyric.parts && lyric.parts.length > 0) {
        const lastPartInLyric = lyric.parts[lyric.parts.length - 1];
        lastPartInLyric.durationMs = nextLyric.startTimeMs - lastPartInLyric.startTimeMs;
      }
      if (lyric.durationMs === 0) {
        lyric.durationMs = nextLyric.startTimeMs - lyric.startTimeMs;
      }
    } else {
      if (lyric.parts && lyric.parts.length > 0) {
        const lastPartInLyric = lyric.parts[lyric.parts.length - 1];
        lastPartInLyric.durationMs = songDuration - lastPartInLyric.startTimeMs;
      }
      if (lyric.durationMs === 0) {
        lyric.durationMs = songDuration - lyric.startTimeMs;
      }
    }
  });

  if (idTags["offset"]) {
    let offset = Number(idTags["offset"]);
    if (isNaN(offset)) {
      offset = 0;
      Utils.log("[BetterLyrics] Invalid offset in lyrics: " + idTags["offset"]);
    }
    offset = offset * 1000;
    result.forEach(lyric => {
      lyric.startTimeMs -= offset;
      lyric.parts?.forEach(part => {
        part.startTimeMs -= offset;
      });
    });
  }

  return result;
}

/**
 * @param lyrics
 */
function lrcFixers(lyrics: LyricsArray): void {
  // if the duration of the space after a word is a similar duration to the word,
  // move the duration of the space into the word.
  // or if it's short, remove the break to improve smoothness
  for (let lyric of lyrics) {
    if (lyric.parts) {
      for (let i = 1; i < lyric.parts.length; i++) {
        let thisPart = lyric.parts[i];
        let prevPart = lyric.parts[i - 1];
        if (thisPart.words === " " && prevPart.words !== " ") {
          let deltaTime = thisPart.durationMs - prevPart.durationMs;
          if (Math.abs(deltaTime) <= 15 || thisPart.durationMs <= 100) {
            let durationChange = thisPart.durationMs;
            prevPart.durationMs += durationChange;
            thisPart.durationMs -= durationChange;
            thisPart.startTimeMs += durationChange;
          }
        }
      }
    }
  }

  // check if we have very short duration for most lyrics,
  // if we do, calculate the duration of the next lyric
  let shortDurationCount = 0;
  let durationCount = 0;
  for (let lyric of lyrics) {
    // skipping the last two parts is on purpose
    // (weather they have a valid duration seems uncorrelated with the rest of them being correct)
    if (!lyric.parts || lyric.parts.length === 0) {
      continue;
    }

    for (let i = 0; i < lyric.parts.length - 2; i++) {
      let part = lyric.parts[i];
      if (part.words !== " ") {
        if (part.durationMs <= 100) {
          shortDurationCount++;
        }
        durationCount++;
      }
    }
  }
  if (durationCount > 0 && shortDurationCount / durationCount > 0.5) {
    Utils.log("Found a lot of short duration lyrics, fudging durations");
    for (let i = 0; i < lyrics.length; i++) {
      let lyric = lyrics[i];
      if (!lyric.parts || lyric.parts.length === 0) {
        continue;
      }

      for (let j = 0; j < lyric.parts.length; j++) {
        let part = lyric.parts[j];
        if (part.words === " ") {
          continue;
        }
        if (part.durationMs <= 400) {
          let nextPart;
          if (j + 1 < lyric.parts.length) {
            nextPart = lyric.parts[j + 1];
          } else if (i + 1 < lyric.parts.length && lyrics[i + 1].parts && lyrics[i + 1].parts!.length > 0) {
            // We know lyrics[i].parts is truthy
            nextPart = lyrics[i + 1].parts![0];
          } else {
            nextPart = null;
          }

          if (nextPart === null) {
            part.durationMs = 300;
          } else {
            if (nextPart.words === " ") {
              part.durationMs += nextPart.durationMs;
              nextPart.startTimeMs += nextPart.durationMs;
              nextPart.durationMs = 0;
            } else {
              part.durationMs = nextPart.startTimeMs - part.startTimeMs;
            }
          }
        }
      }
    }
  }
}

/**
 *
 * @param lyricsText
 * @return
 */
function parsePlainLyrics(lyricsText: string): LyricsArray {
  /**
   * @type {LyricsArray}
   */
  const lyricsArray: LyricsArray = [];
  lyricsText.split("\n").forEach(words => {
    lyricsArray.push({
      startTimeMs: 0,
      words: words,
      durationMs: 0,
    });
  });
  return lyricsArray;
}
