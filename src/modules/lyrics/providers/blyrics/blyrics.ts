import type { Lyric, LyricPart, LyricSourceResult, ProviderParameters } from "../shared";
import * as Constants from "@constants";
import { type X2jOptions, XMLParser } from "fast-xml-parser";
import type {
  SpanElement,
  ParagraphElementOrBackground,
  TtmlRoot,
} from "@modules/lyrics/providers/blyrics/blyrics-types";
import { parseTime } from "@modules/lyrics/providers/lrcUtils";

function parseLyricPart(p: ParagraphElementOrBackground[], beginTime: number, ignoreSpanSpace = false) {
  let text = "";
  let parts: LyricPart[] = [];
  let isWordSynced = false;

  p.forEach(p => {
    let isBackground = false;
    let localP: SpanElement[] = [p];

    if (p[":@"] && p[":@"]["@_role"] === "x-bg") {
      // traverse one span in. This is a bg lyric
      isBackground = true;
      localP = p.span!;
    }

    for (let subPart of localP) {
      if (subPart["#text"] && (!ignoreSpanSpace || localP.length <= 1)) {
        text += subPart["#text"];
        let lastPart = parts[parts.length - 1];
        parts.push({
          startTimeMs: lastPart ? lastPart.startTimeMs + lastPart.durationMs : beginTime,
          durationMs: 0,
          words: subPart["#text"],
          isBackground,
        });
      } else if (subPart.span) {
        let spanText = subPart.span[0]["#text"]!;
        let startTimeMs = parseTime(subPart[":@"]["@_begin"]);
        let endTimeMs = parseTime(subPart[":@"]["@_end"]);

        parts.push({
          startTimeMs,
          durationMs: endTimeMs - startTimeMs,
          isBackground,
          words: spanText,
        });
        text += spanText;

        isWordSynced = true;
      }
    }
  });

  if (!isWordSynced) {
    parts = [];
  }

  return {
    parts,
    text,
    isWordSynced,
  };
}
export default async function bLyrics(providerParameters: ProviderParameters): Promise<void> {
  // Fetch from the primary API if cache is empty or invalid
  const url = new URL(Constants.LYRICS_API_URL);
  url.searchParams.append("s", providerParameters.song);
  url.searchParams.append("a", providerParameters.artist);
  url.searchParams.append("d", String(providerParameters.duration));
  if (providerParameters.album != null) {
    url.searchParams.append("al", providerParameters.album);
  }

  const response = await fetch(url.toString(), {
    signal: AbortSignal.any([providerParameters.signal, AbortSignal.timeout(10000)]),
  });

  if (!response.ok) {
    providerParameters.sourceMap["bLyrics-richsynced"].filled = true;
    providerParameters.sourceMap["bLyrics-richsynced"].lyricSourceResult = null;

    providerParameters.sourceMap["bLyrics-synced"].filled = true;
    providerParameters.sourceMap["bLyrics-synced"].lyricSourceResult = null;
  }

  const options: X2jOptions = {
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    attributesGroupName: false,
    textNodeName: "#text",
    trimValues: false,
    removeNSPrefix: true,
    preserveOrder: true,
    allowBooleanAttributes: true,
    parseAttributeValue: false,
    parseTagValue: false,
  };

  const parser = new XMLParser(options);

  let responseString: string = await response.json().then(json => json.ttml);
  const rawObj = (await parser.parse(responseString)) as TtmlRoot;

  let lyrics = [] as Lyric[];

  const tt = rawObj[0].tt;
  const ttHead = tt.find(e => e.head)!.head!;
  const ttBodyContainer = tt.find(e => e.body)!;
  const ttBody = ttBodyContainer.body!;
  const ttMeta = ttBodyContainer[":@"];

  const lines = ttBody.flatMap(e => e.div);

  let isWordSynced = false;

  lines.forEach(line => {
    let meta = line[":@"];
    let beginTimeMs = parseTime(meta["@_begin"]);
    let endTimeMs = parseTime(meta["@_end"]);

    let partParse = parseLyricPart(line.p, beginTimeMs);
    if (partParse.isWordSynced) {
      isWordSynced = true;
    }

    lyrics.push({
      agent: meta["@_agent"],
      durationMs: endTimeMs - beginTimeMs,
      parts: partParse.parts,
      startTimeMs: beginTimeMs,
      words: partParse.text,
      romanization: undefined,
      timedRomanization: undefined,
      translation: undefined,
    });
  });

  let metadata = ttHead[0].metadata.find(e => e.iTunesMetadata);
  if (metadata) {
    let translations = metadata.iTunesMetadata!.find(e => e.translations);
    let transliterations = metadata.iTunesMetadata!.find(e => e.transliterations);

    if (translations && translations.translations && translations.translations.length > 0) {
      let lang = translations.translations[0][":@"]["@_lang"];
      translations.translations[0].translation.forEach(translation => {
        let text = translation.text[0]["#text"];
        let line = translation[":@"]["@_for"];

        if (lang && text && line && line.startsWith("L")) {
          let lineIndex = Number(line.substring(1)) - 1;
          if (lineIndex < lyrics.length) {
            lyrics[lineIndex].translation = {
              text,
              lang,
            };
          }
        }
      });
    }

    if (transliterations && transliterations.transliterations && transliterations.transliterations.length > 0) {
      transliterations.transliterations[0].transliteration.forEach((transliteration, i) => {
        let line = transliteration[":@"]["@_for"];
        if (line && line.startsWith("L")) {
          let lineIndex = Number(line.substring(1)) - 1;
          if (lineIndex < lyrics.length) {
            let beginTime = lyrics[lineIndex].startTimeMs;
            let parseResult = parseLyricPart(transliteration.text, beginTime, false);

            lyrics[lineIndex].romanization = parseResult.text;
            lyrics[lineIndex].timedRomanization = parseResult.parts;
          }
        }
      });
    }
  }

  let result: LyricSourceResult = {
    cacheAllowed: true,
    language: ttMeta["@_lang"],
    lyrics: lyrics,
    musicVideoSynced: false,
    source: "boidu.dev",
    sourceHref: "https://boidu.dev/",
  };

  if (isWordSynced) {
    providerParameters.sourceMap["bLyrics-richsynced"].lyricSourceResult = result;
    providerParameters.sourceMap["bLyrics-synced"].lyricSourceResult = null;
  } else {
    providerParameters.sourceMap["bLyrics-richsynced"].lyricSourceResult = null;
    providerParameters.sourceMap["bLyrics-synced"].lyricSourceResult = result;
  }

  providerParameters.sourceMap["bLyrics-synced"].filled = true;
  providerParameters.sourceMap["bLyrics-richsynced"].filled = true;
}
