import type { WordCount } from "@lemmaria/harness";

/** Han chars count 1 each (CN 字); Latin-ish tokens count 1 each (EN words). */
const TOKEN = /(\p{Script=Han})|([A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*)/gu;

/** CN by char, EN by word, contiguous per-language segments for mixed (invariant 6). */
export function countWords(text: string): WordCount {
  const segments: Array<{ language: "en" | "zh"; count: number }> = [];
  for (const match of text.matchAll(TOKEN)) {
    const language = match[1] ? "zh" : "en";
    const last = segments.at(-1);
    if (last && last.language === language) last.count += 1;
    else segments.push({ language, count: 1 });
  }
  const zh = segments
    .filter((s) => s.language === "zh")
    .reduce((n, s) => n + s.count, 0);
  const en = segments
    .filter((s) => s.language === "en")
    .reduce((n, s) => n + s.count, 0);
  if (zh > 0 && en > 0) {
    return { language: "mixed", unit: "words", count: zh + en, segments };
  }
  if (zh > 0) return { language: "zh", unit: "字", count: zh };
  return { language: "en", unit: "words", count: en };
}
