import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STR, tr } from "../src/webview/parts/strings.js";

/**
 * The table's own guarantees. `nls.test.ts` does this for the contributed
 * `package.nls*.json` strings; nothing did it for the webview's table until
 * D2 made the table importable (ADR 0037).
 */
describe("the webview string table", () => {
  it("defines every English key in Chinese too", () => {
    const missing = Object.keys(STR.en).filter(
      (k) => !(k in (STR.zh as Record<string, unknown>)),
    );
    expect(missing).toEqual([]);
  });

  it("defines no Chinese key the English table does not have", () => {
    const extra = Object.keys(STR.zh).filter(
      (k) => !(k in (STR.en as Record<string, unknown>)),
    );
    expect(extra).toEqual([]);
  });

  it("resolves one language per reader, chosen by the locale", () => {
    expect(tr("en", "changedFiles")).toBe("file(s) changed");
    expect(tr("zh", "changedFiles")).toBe("个文件已更改");
  });

  it("carries no string in two languages (invariant 6 rule 2)", () => {
    // The repo-wide guard (`scripts/check-mixed-language-strings.mjs`) scans
    // source text and now covers this file deny-by-default, since D2 removed
    // `webview/main.ts` from its D4_PENDING list. This asserts the same rule
    // over the resolved VALUES, which is what a reader actually sees — the two
    // literals D2 fixed on the way in are the reason it is worth pinning twice.
    const enClause = /[A-Za-z]{2,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}/;
    const enFunctionWord =
      /\b(?:the|an?|is|are|to|of|in|on|for|and|or|not|it|this|that|with|from|by|at|as|has|have|can|will|your|you|its|any|all|so|but|if|when|while|then|there|into|out|up|down|only|every|each|because|before|after|again)\b/i;
    const zhClause = /[一-鿿]{4,}/;
    // Rule (B)'s three shapes, as the guard applies them since the X6 review
    // round: spaced, unspaced (`today/今日`), and acronym-first (`… / AI 审稿`).
    const mixedJoins = [
      /[A-Za-z]{2,}[^`"']*\s\/\s*["'“”‘’(（[【\s]*[一-鿿]/,
      /(?<![\w./\\])[A-Za-z]{2,}\/["'“”‘’(（[【]*[一-鿿]/,
      /[A-Za-z]{2,}[^`"']*\s\/\s*["'“”‘’(（[【\s]*[A-Z]{2,}\s*[一-鿿]/,
    ];
    const isJoin = (s: string): boolean => mixedJoins.some((re) => re.test(s));
    // An empty sweep proves nothing unless this copy finds the two joins that
    // shipped past its older self — the second one from this very table.
    expect(isJoin("12 tok today/今日")).toBe(true);
    expect(isJoin("运行“Lemmaria: Review Selection / AI 审稿”")).toBe(true);

    const offenders: string[] = [];
    for (const [key, value] of Object.entries(STR.zh)) {
      const text = Array.isArray(value) ? value.join(" ") : String(value);
      const bare = text.replace(/\$\{[^}]*\}/g, " ");
      const mixedProse =
        enClause.test(bare) && enFunctionWord.test(bare) && zhClause.test(bare);
      if (mixedProse || isJoin(bare)) offenders.push(`${key}: ${text}`);
    }
    expect(offenders).toEqual([]);
  });

  it("names the review command by the reader's own palette title (X6 review round)", () => {
    // The Chinese empty state read “Lemmaria: Review Selection / AI 审稿”:
    // both locales' titles joined for one reader, which the guard missed
    // because its right-hand side starts with `AI`. Each locale names the
    // title ITS palette shows, read from the manifest's own nls files so a
    // renamed command fails here rather than sending the reader to look for
    // an entry the palette does not have.
    const reviewTitle = (file: string): string =>
      (
        JSON.parse(
          readFileSync(
            join(dirname(fileURLToPath(import.meta.url)), "..", file),
            "utf8",
          ),
        ) as Record<string, string>
      )["cmd.review"] ?? "";
    const en = reviewTitle("package.nls.json");
    const zh = reviewTitle("package.nls.zh-cn.json");
    expect(en).not.toBe("");
    expect(zh).not.toBe("");
    expect(tr("en", "rEmpty")).toContain(`“${en}”`);
    expect(tr("zh", "rEmpty")).toContain(`“${zh}”`);
    expect(tr("zh", "rEmpty")).not.toContain(en.replace("Lemmaria: ", ""));
  });

  it("names the key command in the reader's own locale (R4)", () => {
    // The pointer is only useful if the reader can find the entry in their own
    // command palette, so each locale carries that locale's contributed label
    // verbatim from `package.nls*.json` — a translated command name would send
    // the reader looking for something the palette does not have.
    // The English value carries its own leading space; the Chinese one does
    // not, because its full-width parenthesis already supplies the gap.
    expect(tr("en", "toolDegradedAnonymous")).toBe(
      " (no API key — Lemmaria: Set Semantic Scholar API Key)",
    );
    expect(tr("zh", "toolDegradedAnonymous")).toBe(
      "（未设置 API Key — Lemmaria: 设置 Semantic Scholar API Key）",
    );
    expect(tr("en", "rReasonAnonymous")).toBe(
      " (no API key — Lemmaria: Set Semantic Scholar API Key)",
    );
    expect(tr("zh", "rReasonAnonymous")).toBe(
      "（未设置 API Key — Lemmaria: 设置 Semantic Scholar API Key）",
    );
  });

  it("says what the rewind will cost, in one language per reader (E7, ADR 0055)", () => {
    // E4's D1 rule, one milestone on: a key whose string does not say what the
    // control now says is renamed, not re-worded in place. `rewindTitle` said
    // "Go back to before this message" and nothing about files; the control
    // beside it may now be displaying a 3, so the tooltip that ignores the
    // number would be E4's own defect one layer down. Two keys, each true
    // exactly when it is used — and the retired one gone from BOTH tables,
    // which the parity pair above catches if only one half is done.
    //
    // E6 (D8, ADR 0058 §4) re-words both under that same rule, because the
    // control changed again: it opens a three-arm MENU, and the fork-only arm
    // writes no file at all. "Go back … will change" promised the reader a
    // file change two of the three arms do not make; the count is the
    // RESTORING arms' plan, and each string now says which.
    expect("rewindTitle" in STR.en).toBe(false);
    expect("rewindTitle" in STR.zh).toBe(false);
    expect(tr("en", "rewindTitleNoFiles")).toBe(
      "Fork or rewind from this message — rewinding code would change no files",
    );
    expect(tr("en", "rewindTitleFiles")).toBe(
      "Fork or rewind from this message — rewinding code would change {n} file(s)",
    );
    expect(tr("zh", "rewindTitleNoFiles")).toBe(
      "从该消息分叉或回退——回退代码不会改动任何文件",
    );
    expect(tr("zh", "rewindTitleFiles")).toBe(
      "从该消息分叉或回退——回退代码将改动 {n} 个文件",
    );
    // Wholly Chinese apart from the interpolation slot: `{n}` is the table's
    // own placeholder convention (`editWaitingForOthers`), not English prose.
    for (const key of ["rewindTitleNoFiles", "rewindTitleFiles"] as const) {
      expect(STR.zh[key].replace("{n}", "")).not.toMatch(/[A-Za-z]/);
    }
  });

  it("carries the rewind menu and its consent card whole, per reader (E6, D8)", () => {
    // The three arms and the card the restoring pair goes through. Their
    // RENDERING is asserted in `rewind-menu.test.ts`; what is pinned here is
    // that every one of them exists in both tables and that the Chinese half
    // is wholly Chinese apart from the `{n}` slot — the property the E5
    // coverage-debt entry filed against the inline `isZh()` strings this
    // milestone replaced.
    const keys = [
      "rewindArmFork",
      "rewindArmRestore",
      "rewindArmBoth",
      "rewindAskRestore",
      "rewindAskBoth",
      "rewindDoRestore",
      "rewindDoBoth",
      "rewindCardRestored",
      "rewindCardDeleted",
      "rewindMore",
      "rewindNoFiles",
    ] as const;
    for (const key of keys) {
      expect(tr("en", key)).not.toBe("");
      expect(tr("zh", key)).not.toBe("");
      expect(STR.zh[key].replace("{n}", "")).not.toMatch(/[A-Za-z]/);
    }
    // The two headings deliberately keep `describeRestore`'s own wording, so
    // the card and the palette command's QuickPick cannot describe one plan
    // two ways (D8's "the same cap, the same words").
    expect(tr("en", "rewindCardRestored")).toBe(
      "{n} file(s) will be restored:",
    );
    expect(tr("en", "rewindCardDeleted")).toBe(
      "{n} file(s) will be DELETED from disk (this session created them):",
    );
    // Carried over from `snapshot-restore.test.ts`, which asserted these of
    // the modal detail E6 deleted. They are claims about the WORDS a writer
    // reads immediately before agreeing to lose a file, so they follow the
    // words rather than dying with the surface that used to carry them.
    const del = {
      en: tr("en", "rewindCardDeleted"),
      zh: tr("zh", "rewindCardDeleted"),
    };
    expect(del.en).toMatch(/DELETED from disk/);
    expect(del.zh).toMatch(/删除/);
    // ADR 0057: the parenthetical said "this branch created them" in both
    // locales, and there is no branch left to name — the SESSION created it.
    expect(del.en).not.toMatch(/branch/i);
    expect(del.zh).not.toMatch(/分支/);
    expect(del.en).toMatch(/this session created them/);
    expect(del.zh).toMatch(/本会话创建的/);
    // A deletion is never offered as a restore: the two headings are distinct
    // sentences, and the deletion one is in the imperative.
    expect(tr("en", "rewindCardRestored")).not.toMatch(/DELETED/);
  });

  it("names the copy affordance in one language per reader (ADR 0040)", () => {
    // D3 round 2 reverses ADR 0039 §6's "adds no user-visible string of its
    // own": a Copy button needs an accessible label, and a label is a string.
    expect(STR.en.mdCopy).toBe("Copy code");
    expect(STR.en.mdCopied).toBe("Copied");
    expect(STR.zh.mdCopy).toBe("复制代码");
    expect(STR.zh.mdCopied).toBe("已复制");
    // Wholly Chinese, with no Latin script in it at all.
    for (const s of [STR.zh.mdCopy, STR.zh.mdCopied]) {
      expect(s).not.toMatch(/[A-Za-z]/);
    }
  });
});

describe("V1's sentences are one language per reader (O23, ADR 0076 §9)", () => {
  const V1 = [
    "mVerifier",
    "mVerifierDesc",
    "mSameAsCrossReview",
    "mVerifierOff",
    "rWithdrawn",
    "rCounterAt",
    "rConcernUnchecked",
    "rConcernOpinion",
    "rConcernUnsettled",
    "rCardVerification",
  ] as const;
  const cjk = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

  it("says each in English with no Chinese, and in Chinese with no English word", () => {
    for (const key of V1) {
      const en = tr("en", key);
      const zh = tr("zh", key).replace("{where}", "");
      expect(en, key).not.toMatch(cjk);
      expect(zh, key).toMatch(cjk);
      expect(zh, key).not.toMatch(/[A-Za-z]{2,}/);
    }
  });

  it("gives the counter line exactly one slot, in both languages", () => {
    for (const locale of ["en", "zh"] as const)
      expect(tr(locale, "rCounterAt").split("{where}"), locale).toHaveLength(2);
  });

  it("never lets a tool word reach a reader", () => {
    // ADR 0076 §9: *refuted*, *unverifiable* and *central* are the wire's.
    for (const key of V1)
      expect(tr("en", key), key).not.toMatch(/refut|unverifiable|central/i);
  });
});

describe("V4's strings are one language per reader (O21, ADR 0081)", () => {
  const V4 = [
    "rPdfFacts",
    "rPdfPages",
    "rPdfPagesOne",
    "rPdfSizeA4",
    "rPdfSizeLetter",
    "rPdfSizeOther",
    "rPdfReferences",
    "rPdfReferencesOne",
    "rPdfReferencesNone",
    "rPdfLimit",
    "rPdfLimitBare",
    "rPdfAuthor",
    "rPdfAuthorBlind",
    "rPdfOverfull",
    "rPdfSmallestText",
    "rPdfSourceCompiled",
    "rPdfSourceFound",
    "rPdfSourceNamed",
    "rPdfSourceStale",
    "rPdfViewed",
    "rPdfTitle",
    "rSeatPdfReviewer",
    "rSeatPdfUnchecked",
    "rEvidencePage",
    "rDimPresentation",
    "rRunPdf",
    "rLimitPdfNone",
    "rLimitPdfStale",
    "rLimitPdfCompileFailed",
    "rLimitPdfRenderFailed",
    "rLimitVisualNoImageInput",
    "rLimitVisualNoRenderer",
    "rLimitPagesUnviewed",
    "rFixEvidencePage",
    "menuReviewPdfDesc",
    "mPdfReview",
    "mPdfReviewDesc",
    "mPdfReviewer",
    "mPdfReviewerOff",
    "mPdfReviewerDesc",
    "mPdfReviewerBlind",
  ] as const;
  const cjk = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
  /** The slots, and the Latin the zh table deliberately keeps: the format's
   *  name, the unit, and the two paper-size names (plan D13's table). */
  const bare = (s: string): string =>
    s.replace(/\{\w+\}/g, "").replace(/\b(PDF|pt|A4|Letter)\b/g, "");

  it("defines every key in both tables, non-empty", () => {
    for (const key of V4) {
      expect(tr("en", key), key).not.toBe("");
      expect(tr("zh", key), key).not.toBe("");
    }
  });

  it("says each in English with no Chinese, and in Chinese with no English word", () => {
    for (const key of V4) {
      expect(tr("en", key), key).not.toMatch(cjk);
      expect(tr("zh", key), key).toMatch(cjk);
      expect(bare(tr("zh", key)), key).not.toMatch(/[A-Za-z]{2,}/);
    }
  });

  it("gives the page line and the unviewed sentence exactly their slots, in both languages", () => {
    const slots = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const locale of ["en", "zh"] as const) {
      expect(slots(tr(locale, "rEvidencePage")), locale).toEqual(["{n}"]);
      expect(slots(tr(locale, "rLimitPagesUnviewed")), locale).toEqual([
        "{total}",
        "{viewed}",
      ]);
      expect(slots(tr(locale, "rFixEvidencePage")), locale).toEqual(["{n}"]);
    }
  });

  it("carries the same slots in both tables for every V4 key", () => {
    const slots = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of V4)
      expect(slots(tr("zh", key)), key).toEqual(slots(tr("en", key)));
  });

  it("names the panel's route, the PDF's and the quick action's in the empty hint", () => {
    expect(tr("en", "rEmpty")).toContain("review the compiled PDF alone");
    expect(tr("zh", "rEmpty")).toContain("单独评审已编译的 PDF");
  });
});

describe("the / menu reads as one list (J1's round)", () => {
  it("sets every English description in sentence case", () => {
    // J1's round found `/review-pdf — review the compiled PDF alone` the one
    // lowercase row beside `Review the whole manuscript with a blind panel`.
    const menu = Object.entries(STR.en).filter(([key]) =>
      /^menu\w*Desc$/.test(key),
    );
    expect(menu.map(([key]) => key)).toContain("menuReviewPdfDesc");
    const lower = menu
      .filter(([, value]) => typeof value !== "string" || !/^[A-Z]/.test(value))
      .map(([key]) => key);
    expect(lower).toEqual([]);
  });
});

describe("V4 rounds 4 and 5's strings are one language per reader (O41–O44, ADR 0085, ADR 0086)", () => {
  const ROUND4 = [
    "rEvidencePageMoved",
    "rLimitFurnitureSetAside",
    "rLimitFurnitureSetAsideOne",
    "rLimitPagesUnchecked",
    "rLimitPagesUncheckedOne",
    "rReasonAuxOlder",
    "rReasonAuxOtherBuild",
    "rSeatAllFurniture",
    "rSeatOneFurniture",
    "rSeatAllSetAsideMixed",
    // Round 5 (ADR 0086): the set-aside fold's heading.
    "rSetAsideFold",
  ] as const;
  const cjk = /[　-〿一-鿿＀-￯]/;
  /** The slots, and the Latin the zh table keeps as names: the format, the
   *  file the compile writes, and the two identifiers a template prints. */
  const bare = (s: string): string =>
    s.replace(/\{\w+\}/g, "").replace(/\.aux\b|\b(PDF|DOI|ISBN)\b/g, "");

  it("says each in English with no Chinese, and in Chinese with no other English word", () => {
    for (const key of ROUND4) {
      expect(tr("en", key), key).not.toBe("");
      expect(tr("en", key), key).not.toMatch(cjk);
      expect(tr("zh", key), key).toMatch(cjk);
      expect(bare(tr("zh", key)), key).not.toMatch(/[A-Za-z]{2,}/);
    }
  });

  it("carries the same slots in both tables", () => {
    const slots = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of ROUND4)
      expect(slots(tr("zh", key)), key).toEqual(slots(tr("en", key)));
    expect(slots(tr("en", "rEvidencePageMoved"))).toEqual(["{cited}", "{n}"]);
  });
});

describe("V5's one string is one language per reader, with exactly its two slots (D14, O15)", () => {
  const cjk = /[　-〿一-鿿＀-￯]/;

  it("says it in English with no Chinese, and in Chinese with no English word", () => {
    expect(tr("en", "rLimitStrengthsLost")).not.toMatch(cjk);
    expect(tr("zh", "rLimitStrengthsLost")).toMatch(cjk);
    expect(tr("zh", "rLimitStrengthsLost").replace(/\{\w+\}/g, "")).not.toMatch(
      /[A-Za-z]/,
    );
  });

  it("carries exactly {n} and {reviewer}, in both tables", () => {
    // The sentence owns its separator as well as its count — the two
    // locales punctuate it differently — so the reviewer is a slot too.
    const slots = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const locale of ["en", "zh"] as const)
      expect(slots(tr(locale, "rLimitStrengthsLost")), locale).toEqual([
        "{n}",
        "{reviewer}",
      ]);
  });
});

describe("V6's scorecard words are one language per reader, and never a score (O21, ADR 0088 §6)", () => {
  const SC = [
    "scTitle",
    "scReadinessBlocking",
    "scReadinessMajor",
    "scReadinessMinor",
    "scReadinessNone",
    "scReadinessNotAssessed",
    "scNotAssessedCount",
    "scLevelWord",
    "scLevel1",
    "scLevel2",
    "scLevel3",
    "scLevel4",
    "scNothingRaised",
    "scNotAssessed",
    "scReasonDeclared",
    "scReasonNoLiterature",
    "scReasonLiteratureBudget",
    "scReasonNoPdf",
    "scReasonNoReviewer",
    "scCountIssues",
    "scCountBlocking",
    "scCountMajor",
    "scCountMinor",
    "scCountStrengths",
    "scImpression",
    "scNoImpression",
    "scUncalibrated",
    "scFirstReading",
    "scComparedWith",
    "scNotComparable",
    "scNotComparableVerification",
    "scNotComparableUnmeasured",
    "scDeltaImproved",
    "scDeltaWorsened",
    "scDeltaUnchanged",
    "scDeltaNew",
    "scUnmeasured",
    "scNoReviewerRan",
    "scCaveat",
    "scNarrowed",
    "scShowAll",
    "scSeatConcernsOf",
  ] as const;
  const cjk = /[　-〿一-鿿＀-￯]/;
  const slots = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
  /** The slots, and the one Latin name the zh table keeps: the format's. */
  const bare = (s: string): string =>
    s.replace(/\{\w+\}/g, "").replace(/\bPDF\b/g, "");
  /** The stage guard's own words (`packages/harness/test/no-score.test.ts`),
   *  which scans the harness only — this is its reading of the tab. */
  const BANNED_EN =
    /\b(score|scores|scored|scoring|rating|ratings|verdict|verdicts)\b/i;
  const BANNED_ZH = ["评分", "打分", "得分", "分数", "评级"];

  it("lists every sc* key the table defines, and no other", () => {
    const defined = Object.keys(STR.en)
      .filter((k) => /^sc[A-Z]/.test(k))
      .sort();
    expect(defined).toEqual([...SC].sort());
  });

  it("says each in English with no Chinese, and in Chinese with no English word", () => {
    for (const key of SC) {
      expect(tr("en", key), key).not.toBe("");
      expect(tr("en", key), key).not.toMatch(cjk);
      expect(tr("zh", key), key).toMatch(cjk);
      expect(bare(tr("zh", key)), key).not.toMatch(/[A-Za-z]{2,}/);
    }
  });

  it("carries the same slots in both tables", () => {
    for (const key of SC)
      expect(slots(tr("zh", key)), key).toEqual(slots(tr("en", key)));
    expect(slots(tr("en", "scLevelWord"))).toEqual(["{level}", "{word}"]);
    expect(slots(tr("en", "scNarrowed"))).toEqual([
      "{dimension}",
      "{shown}",
      "{total}",
    ]);
  });

  it("never names a score, a rating or a verdict, in either language", () => {
    for (const key of SC) {
      expect(tr("en", key), key).not.toMatch(BANNED_EN);
      for (const word of BANNED_ZH)
        expect(tr("zh", key), key).not.toContain(word);
    }
  });

  it("never prints a percentage", () => {
    for (const key of SC) {
      expect(tr("en", key), key).not.toContain("%");
      expect(tr("zh", key), key).not.toContain("%");
      expect(tr("zh", key), key).not.toContain("％");
    }
  });

  it("names no venue's decision in the readiness words (J2's round: D4's `Major revisions` was not ratified)", () => {
    for (const key of [
      "scReadinessBlocking",
      "scReadinessMajor",
      "scReadinessMinor",
      "scReadinessNone",
    ] as const) {
      expect(tr("en", key), key).not.toMatch(
        /\b(revisions?|accept|accepted|reject|rejected)\b/i,
      );
      for (const word of ["修改", "修订", "录用", "接收", "拒稿"])
        expect(tr("zh", key), key).not.toContain(word);
    }
  });

  it("uses ONE Chinese word for blocking — the level, the count, the readiness and the id line (J2's round)", () => {
    const word = tr("zh", "rBlocking");
    expect(tr("zh", "scLevel1")).toBe(word);
    expect(tr("zh", "scCountBlocking")).toContain(word);
    expect(tr("zh", "scReadinessBlocking")).toContain(word);
    // English already did: one word, three casings of it.
    expect(tr("en", "rBlocking")).toBe("blocking");
    expect(tr("en", "scLevel1").toLowerCase()).toBe("blocking");
  });

  it("gives the level-4 word and the strengths count different words, so one row does not read like a typo (J2's round)", () => {
    const counted = tr("zh", "scCountStrengths").replace("{n}", "").trim();
    expect(tr("zh", "scLevel4")).not.toContain(counted);
    expect(counted).not.toContain(tr("zh", "scLevel4"));
  });

  it("spaces the banner's separator, so the dimension does not run into the number (J2's round)", () => {
    expect(tr("zh", "scNarrowed")).not.toMatch(/\}·|·\{/);
  });

  it("carries design §8's caveat verbatim", () => {
    expect(tr("en", "scCaveat")).toBe(
      "levels are computed from this panel's located concerns; impressions are reviewers' uncalibrated opinions; neither predicts acceptance.",
    );
  });
});
