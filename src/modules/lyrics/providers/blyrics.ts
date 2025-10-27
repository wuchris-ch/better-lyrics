import type { Lyric, LyricPart, LyricsArray, LyricSourceResult, ProviderParameters } from "./shared";
import * as Constants from "../../../core/constants";
interface BLyricsApiResponse {
  error: any;
  isRtlLanguage: boolean;
  language: string;
  lyrics: ApiLyric[];
  source: string;
  type: "line" | "word" | "none";
}

export interface ApiLyric {
  agent?: string;
  durationMs: string;
  endTimeMs: string;
  startTimeMs: string;
  syllables: ApiSyllable[];
  words: string;
}

export interface ApiSyllable {
  endTimeMs: string;
  isBackground: boolean;
  startTimeMs: string;
  text: string;
}

export default async function bLyrics(providerParameters: ProviderParameters): Promise<void> {
  // Fetch from the primary API if cache is empty or invalid
  const url = new URL(Constants.LYRICS_API_URL);
  url.searchParams.append("s", providerParameters.song);
  url.searchParams.append("a", providerParameters.artist);
  url.searchParams.append("d", String(providerParameters.duration));

  const response = await fetch(url.toString(), {
    signal: AbortSignal.any([providerParameters.signal, AbortSignal.timeout(10000)]),
  });

  if (!response.ok) {
    providerParameters.sourceMap["bLyrics-richsynced"].filled = true;
    providerParameters.sourceMap["bLyrics-richsynced"].lyricSourceResult = null;

    providerParameters.sourceMap["bLyrics-synced"].filled = true;
    providerParameters.sourceMap["bLyrics-synced"].lyricSourceResult = null;
  }

  const data = (await response.json()) as BLyricsApiResponse;
  // Validate API response structure
  if (!data || (!Array.isArray(data.lyrics) && !data.lyrics)) {
    providerParameters.sourceMap["bLyrics-richsynced"].filled = true;
    providerParameters.sourceMap["bLyrics-richsynced"].lyricSourceResult = null;

    providerParameters.sourceMap["bLyrics-synced"].filled = true;
    providerParameters.sourceMap["bLyrics-synced"].lyricSourceResult = null;
  }

  let lyrics: LyricsArray = [];

  for (const apiLyric of data.lyrics) {
    let parts: LyricPart[] = [];
    for (const syllable of apiLyric.syllables) {
      parts.push({
        startTimeMs: Number(syllable.startTimeMs),
        durationMs: Number(syllable.endTimeMs) - Number(syllable.startTimeMs),
        words: syllable.text,
        isBackground: syllable.isBackground,
      });
    }
    let lyric: Lyric = {
      startTimeMs: Number(apiLyric.startTimeMs),
      durationMs: Number(apiLyric.durationMs),
      agent: apiLyric.agent,
      parts,
      words: apiLyric.words,
    };
    lyrics.push(lyric);
  }

  let result: LyricSourceResult = {
    lyrics,
    language: data.language,
    source: "boidu.dev",
    sourceHref: "https://better-lyrics.boidu.dev",
    musicVideoSynced: false,
    cacheAllowed: true,
  };

  if (data.type === "word") {
    providerParameters.sourceMap["bLyrics-richsynced"].lyricSourceResult = result;
    providerParameters.sourceMap["bLyrics-synced"].lyricSourceResult = null;
  } else if (data.type === "line") {
    providerParameters.sourceMap["bLyrics-richsynced"].lyricSourceResult = null;
    providerParameters.sourceMap["bLyrics-synced"].lyricSourceResult = result;
  } else {
    providerParameters.sourceMap["bLyrics-richsynced"].lyricSourceResult = null;
    providerParameters.sourceMap["bLyrics-synced"].lyricSourceResult = null;
  }

  providerParameters.sourceMap["bLyrics-synced"].filled = true;
  providerParameters.sourceMap["bLyrics-richsynced"].filled = true;
}
