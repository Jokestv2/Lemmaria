import {
  parsePdfReviewCommand,
  parseReviewCommand,
  parseSkillInvocations,
} from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import {
  type Candidate,
  MAX_ROWS,
  SIGIL_AT,
  SIGIL_SLASH,
  activeToken,
  applyCompletion,
  commandCandidates,
  forkCandidates,
  label,
  parseForkCommand,
  rank,
  removeToken,
  reviewCandidates,
  reviewPdfCandidates,
  skillCandidates,
} from "../src/webview/parts/completion.js";

const verb = (name: string): Candidate => ({
  name,
  description: "",
  kind: "command",
  group: "commands",
  command: "newSession",
});

const path = (name: string): Candidate => ({
  name,
  description: "",
  kind: "insert",
  group: "paths",
  insertion: name,
});

const skill = (name: string, description = ""): Candidate => ({
  name: `skill:${name}`,
  description,
  kind: "insert",
  group: "skills",
  insertion: `/skill:${name}`,
});

/** The token, or a loud failure — a silent `undefined` would pass vacuously. */
const mustToken = (text: string, caret = text.length) => {
  const t = activeToken(text, caret, SIGIL_SLASH);
  if (!t) throw new Error(`no token in ${JSON.stringify(text)} at ${caret}`);
  return t;
};

describe("activeToken — `/` fires at any whitespace boundary (ADR 0050)", () => {
  it("finds the token when `/` opens the message", () => {
    expect(activeToken("/new", 4, SIGIL_SLASH)).toEqual({
      start: 0,
      end: 4,
      query: "new",
    });
  });

  it("finds the token MID-MESSAGE too, which is the ADR 0050 change", () => {
    // Through E2 these three were `undefined`, because the engine's regex was
    // anchored and the menu narrowed to it. Both moved to the same rule in one
    // commit: the operator drove Codex's VS Code extension and found it invokes
    // skills mid-input, several to a message.
    expect(activeToken("please /new", 11, SIGIL_SLASH)).toEqual({
      start: 7,
      end: 11,
      query: "new",
    });
    expect(activeToken(" /new", 5, SIGIL_SLASH)).toEqual({
      start: 1,
      end: 5,
      query: "new",
    });
    expect(activeToken("\n/new", 5, SIGIL_SLASH)).toEqual({
      start: 1,
      end: 5,
      query: "new",
    });
  });

  it("still finds NOTHING for a slash INSIDE a word", () => {
    // The half that must not move: `http://x/skill:tone` is a URL, not an
    // invocation. This is the same whitespace-delimited rule the harness regex
    // now applies, which is what keeps the two grammars agreeing.
    expect(activeToken("and/or", 6, SIGIL_SLASH)).toBeUndefined();
    expect(activeToken("http://x/new", 12, SIGIL_SLASH)).toBeUndefined();
  });

  it("opens on a bare `/` with an EMPTY query", () => {
    // Both sigils open on an empty query (design §2): a bare `/` lists every
    // verb. Codex's file search declines to open on an empty token; Lemmaria
    // opens, because E3's `＋` button IS an empty-query `@`.
    expect(activeToken("/", 1, SIGIL_SLASH)).toEqual({
      start: 0,
      end: 1,
      query: "",
    });
  });

  it("finds nothing when the caret sits BEFORE the sigil", () => {
    expect(activeToken("/new", 0, SIGIL_SLASH)).toBeUndefined();
  });

  it("ends the token at the first whitespace", () => {
    expect(activeToken("/skill:tone fix this", 11, SIGIL_SLASH)).toEqual({
      start: 0,
      end: 11,
      query: "skill:tone",
    });
  });

  it("finds nothing once the caret has LEFT the token (D2)", () => {
    // The divergence from Codex, which keeps its popup open over
    // `/clear something` so the popup doubles as help. Lemmaria's
    // `/skill:<name> <request>` is free text after the slug, so a menu that
    // stayed open over the request would be one the user cannot dismiss by
    // typing the thing they came to type. §3's trailing space is what closes
    // it.
    expect(activeToken("/skill:tone ", 12, SIGIL_SLASH)).toBeUndefined();
    expect(
      activeToken("/skill:tone fix this", 20, SIGIL_SLASH),
    ).toBeUndefined();
  });

  it("clamps a caret past the end of the text rather than throwing", () => {
    expect(activeToken("/new", 99, SIGIL_SLASH)).toEqual({
      start: 0,
      end: 4,
      query: "new",
    });
  });
});

describe("activeToken — `@` fires at any whitespace boundary (design §2)", () => {
  // E3's candidate source is a milestone away; its ANCHORING is proven here, so
  // E3 inherits it proven rather than re-deriving it.
  it("finds a token after a space", () => {
    expect(activeToken("see @sec", 8, SIGIL_AT)).toEqual({
      start: 4,
      end: 8,
      query: "sec",
    });
  });

  it("finds a token at position 0 too", () => {
    expect(activeToken("@sec", 4, SIGIL_AT)).toEqual({
      start: 0,
      end: 4,
      query: "sec",
    });
  });

  it("finds a token after a newline", () => {
    expect(activeToken("see\n@sec", 8, SIGIL_AT)).toEqual({
      start: 4,
      end: 8,
      query: "sec",
    });
  });

  it("finds NOTHING for a sigil glued to a preceding word", () => {
    // `a@b` is an email address, not a reference.
    expect(activeToken("a@b", 3, SIGIL_AT)).toBeUndefined();
  });

  it("treats a second sigil as part of the SAME token, not a new one", () => {
    // The word begins with the sigil, so the whole word is the token and the
    // inner `@` is just a character in the query. A file really can be called
    // `a@b`, and re-anchoring mid-word would make it unreachable.
    expect(activeToken("@a@b", 4, SIGIL_AT)).toEqual({
      start: 0,
      end: 4,
      query: "a@b",
    });
  });

  it("opens on a bare `@`", () => {
    expect(activeToken("see @", 5, SIGIL_AT)).toEqual({
      start: 4,
      end: 5,
      query: "",
    });
  });
});

describe("rank — a case-insensitive subsequence, scored (design §1, D5)", () => {
  const candidates = [verb("new"), verb("compact"), verb("history")];

  it("keeps every candidate, in SOURCE order, on an empty query", () => {
    // Not alphabetical: a bare `/` should list the verbs in the order the
    // product names them, and it should list them the same way every time.
    expect(rank(candidates, "").map((r) => r.candidate.name)).toEqual([
      "new",
      "compact",
      "history",
    ]);
  });

  it("drops a candidate the query is not a subsequence of", () => {
    expect(rank(candidates, "zzz")).toHaveLength(0);
  });

  it("matches a non-contiguous subsequence", () => {
    expect(rank(candidates, "hy").map((r) => r.candidate.name)).toEqual([
      "history",
    ]);
  });

  it("is case-insensitive in both directions", () => {
    expect(rank([verb("New")], "ne")).toHaveLength(1);
    expect(rank([verb("new")], "NE")).toHaveLength(1);
  });

  it("prefers a prefix match over a later one", () => {
    // Codex's -100 prefix bonus. `co` prefixes `compact` and appears late in
    // `discography`, so the prefix must win regardless of contiguity.
    const ranked = rank([skill("discography"), verb("compact")], "co");
    expect(ranked[0]?.candidate.name).toBe("compact");
  });

  it("prefers a contiguous match over a scattered one", () => {
    // Both candidates must actually MATCH, or this passes on the subsequence
    // filter rather than on the score and would hold with the comparison
    // inverted. The first fixture written here (`cabbage-orchard` vs `cows`
    // on `cos`) had exactly that defect: `cabbage-orchard` has no `s` after
    // its `o`, so only one row ever came back. Caught at E2's code review.
    const ranked = rank([skill("ax-bx-cx"), skill("abc")], "abc");
    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.candidate.name)).toEqual([
      "skill:abc",
      "skill:ax-bx-cx",
    ]);
    // And the scores are what orders them, not the input order: 0 for the
    // contiguous run, 4 for the span the scattered one occupies beyond `abc`.
    expect(ranked.map((r) => r.score)).toEqual([0, 4]);
  });

  it("breaks a tie alphabetically, and stably", () => {
    const ranked = rank([verb("beta"), verb("alpha")], "a");
    expect(ranked.map((r) => r.candidate.name)).toEqual(["alpha", "beta"]);
    // Run it again over the reversed input: the answer must not depend on the
    // order the catalogue happened to load in.
    const again = rank([verb("alpha"), verb("beta")], "a");
    expect(again.map((r) => r.candidate.name)).toEqual(["alpha", "beta"]);
  });

  it("reports match indices as offsets into the DISPLAYED label", () => {
    // Codex shifts its indices by one for exactly this reason
    // (`command_popup.rs:212`): the row shows `/new`, so index 1 is the `n`.
    // A renderer that had to re-derive the shift would be a second home for
    // the rule.
    const [only] = rank([verb("new")], "nw");
    expect(only?.matchIndices).toEqual([1, 3]);
  });

  it("reports no indices for an empty query", () => {
    expect(rank([verb("new")], "")[0]?.matchIndices).toEqual([]);
  });

  it("indexes the ORIGINAL characters under a case-EXPANDING lowercase", () => {
    // `İ`.toLowerCase() is TWO code points (i + combining dot above), so an
    // index into the lowered string is not an index into the original: a naive
    // matcher answers [1, 3] here, bolding the `t`. A renderer using the
    // lowered offsets would highlight the wrong characters — and a
    // third-party skill description is exactly the text invariant 6's boundary
    // says passes through as its author wrote it.
    const [only] = rank([verb("İstanbul")], "is");
    // label = "/İstanbul": `İ` at 1, `s` at 2.
    expect(only?.matchIndices).toEqual([1, 2]);
  });

  it("matches greedily and leftmost, so `skill:` participates", () => {
    // Recorded rather than filed as a surprise: the match text is the whole
    // name, prefix included, which is what lets `/sk` list every skill. Codex's
    // popup behaves the same way, and narrowing the match to the slug would
    // cost the `/skill:` listing that makes the group discoverable at all.
    //
    // Greedy-leftmost is also why `/is` does NOT find `skill:tone`: the `i` is
    // taken at index 3, inside the prefix, and there is no `s` after it. A
    // matcher that backtracked would find none either — this candidate has no
    // `is` subsequence at all — but one that scored optimally would rank other
    // candidates differently. The behaviour is inherited deliberately; see
    // `fuzzy`'s own doc comment.
    expect(rank([skill("tone")], "is")).toHaveLength(0);
    // The prefix alone matches, and lists every skill:
    expect(rank([skill("tone"), skill("cite")], "sk")).toHaveLength(2);
    // And leftmost is visible directly: the `s` of `skill:` is taken, not the
    // `s` of the slug, so the indices land in the prefix.
    const [seen] = rank([skill("stance")], "s");
    expect(seen?.matchIndices).toEqual([1]);
  });

  it("counts in CODE POINTS, so an astral character is one column", () => {
    // The renderer splits the label with `[...label]`; the ranker must agree,
    // or a name containing an emoji would bold a lone surrogate.
    const [only] = rank([skill("a\u{1F600}b")], "ab");
    // label = "/skill:a😀b": `a` at 7, `b` at 9 in CODE POINTS.
    expect(only?.matchIndices).toEqual([7, 9]);
  });
});

describe("rank — the LAST PATH SEGMENT is scored too (E3, ADR 0052)", () => {
  // The regression this rule was written for, verbatim from the real-webview
  // run that found it. Before the second pass, `@final` put the FOLDER first.
  // The grant label matters: its `F` is where the leftmost scan takes the `f`
  // of `final`, which is what made the two paths score alike.
  const ROOT = "lemmaria-e3-ZFttYO/";
  const DIR = `${ROOT}a-very-long-directory-name/another-quite-long-segment/`;
  const FILE = `${DIR}final-results-table.csv`;

  it("ranks a file above its own containing folder on the file's name", () => {
    const ranked = rank([path(DIR), path(FILE)], "final");
    expect(ranked.map((r) => r.candidate.name)).toEqual([FILE, DIR]);
    // And it is the SCORE that orders them, not the tie-break: `final` is
    // contiguous at the start of the basename, so it takes the prefix bonus.
    expect(ranked[0]?.score).toBe(-100);
  });

  it("was the leftmost pass, not the tie-break, that had it backwards", () => {
    // Proof the fix addresses the stated cause. Over the WHOLE name the two
    // score identically — the folder's path is a prefix of the file's, so a
    // leftmost scan takes literally the same characters — and no tie-break
    // over equal scores could have put the longer name first.
    const wholeNameOnly = rank(
      [path(DIR.replaceAll("/", "-")), path(FILE.replaceAll("/", "-"))],
      "final",
    );
    expect(wholeNameOnly[0]?.score).toBe(wholeNameOnly[1]?.score);
  });

  it("matches a FOLDER on its own last segment, stepping over the slash", () => {
    // `a/b/` must be matched on `b`, not on the empty string after its
    // trailing separator — otherwise a folder is reachable only by a query
    // that also spans its parents.
    const ranked = rank([path("papers/results-2026/")], "results");
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.score).toBe(-100);
  });

  it("keeps a match the whole name has and the last segment does not", () => {
    // The second pass ADDS a way to match; it never removes one. `papers` is
    // not in the basename at all.
    expect(rank([path("papers/intro.tex")], "papers")).toHaveLength(1);
  });

  it("reports indices into the ORIGINAL name when the tail pass wins", () => {
    // The highlight renders against the full path, so a tail-relative index
    // would bold characters in the parent directory.
    const [only] = rank([path("aa/bcd.tex")], "bc");
    // label = "@aa/bcd.tex", so `b` is at 4 — `rank` shifts by the sigil.
    expect(only?.matchIndices).toEqual([4, 5]);
  });

  it("changes NOTHING for a name with no `/`", () => {
    // Which is every `/` row, since a skill's name is `skill:<slug>` — the
    // reason E2's ranking assertions above pass unmodified. Asserted rather
    // than argued: a slug ranks identically to the same text under a parent.
    const bare = rank([skill("tone")], "to");
    expect(bare[0]?.score).toBe(0);
    expect(bare[0]?.matchIndices).toEqual([7, 8]);
  });
});

describe("applyCompletion — splice, one trailing space, new caret (design §3)", () => {
  it("replaces the token and appends exactly one space", () => {
    expect(applyCompletion("/sk", mustToken("/sk", 3), "/skill:tone")).toEqual({
      text: "/skill:tone ",
      caret: 12,
      written: "/skill:tone ",
    });
  });

  it("does NOT double a space that is already there", () => {
    const token = mustToken("/sk fix this", 3);
    expect(applyCompletion("/sk fix this", token, "/skill:tone")).toEqual({
      text: "/skill:tone fix this",
      caret: 12,
      // `written` carries NO gap here: the space at the caret is the one the
      // user already typed, and it is not part of what replaces the token.
      // The caret is therefore one PAST the written run, which is why the
      // caller writes it explicitly rather than trusting where the insertion
      // left it.
      written: "/skill:tone",
    });
  });

  it("puts the caret after the space in both cases", () => {
    // The caret lands past the separator either way, so the user's next
    // keystroke is the start of their request and the menu is closed by D2's
    // caret rule without any extra state.
    const ra = applyCompletion("/sk", mustToken("/sk", 3), "/new");
    const rb = applyCompletion("/sk x", mustToken("/sk x", 3), "/new");
    expect(ra.text[ra.caret - 1]).toBe(" ");
    expect(rb.text[rb.caret - 1]).toBe(" ");
  });

  it("adds a space before a newline rather than swallowing it", () => {
    const token = mustToken("/sk\nmore", 3);
    expect(applyCompletion("/sk\nmore", token, "/new")).toEqual({
      text: "/new \nmore",
      caret: 5,
      written: "/new ",
    });
  });

  it("closes the menu, because the caret is now past the token", () => {
    const { text, caret } = applyCompletion(
      "/sk",
      mustToken("/sk", 3),
      "/skill:tone",
    );
    expect(activeToken(text, caret, SIGIL_SLASH)).toBeUndefined();
  });
});

describe("the menu cannot produce a string the engine ignores (design §2)", () => {
  // The acceptance criterion, checked against the harness's OWN parser rather
  // than against a copy of its grammar. If `INVOCATION_RE` ever tightens, this
  // fails here instead of shipping a menu row that inserts prose.
  //
  // ADR 0050 is exactly the event this test exists for: both grammars moved
  // from anchored to whitespace-delimited, and the third case below is the one
  // that would have caught a menu loosened without the parser.
  const loaded = [
    {
      name: "tone",
      description: "d",
      body: "b",
      source: "project" as const,
      path: "/p/SKILL.md",
      references: [],
    },
  ];

  it("accepting a skill row yields text `parseSkillInvocations` recognises", () => {
    const candidate = skillCandidates(loaded)[0];
    if (!candidate) throw new Error("skillCandidates produced no row");
    const { text } = applyCompletion(
      "/to",
      mustToken("/to", 3),
      `${SIGIL_SLASH.sigil}${candidate.name}`,
    );
    const parsed = parseSkillInvocations(text, loaded);
    expect(parsed.skills.map((s) => s.name)).toEqual(["tone"]);
    expect(parsed.request).toBe("");
  });

  it("still recognises it once the user has typed their request", () => {
    const parsed = parseSkillInvocations(
      "/skill:tone fix the abstract",
      loaded,
    );
    expect(parsed.request).toBe("fix the abstract");
  });

  it("and recognises a row accepted MID-MESSAGE, which is ADR 0050", () => {
    // The composer's `boundary` anchor is only correct if the parser agrees at
    // the same boundary. Accept a row after some prose and hand the RESULT to
    // the harness — a menu that opened here while the regex stayed anchored
    // would fail on this line rather than in front of a user.
    const draft = "rewrite the intro /to";
    const { text } = applyCompletion(
      draft,
      mustToken(draft, draft.length),
      "/skill:tone",
    );
    const parsed = parseSkillInvocations(text, loaded);
    expect(parsed.skills.map((s) => s.name)).toEqual(["tone"]);
    expect(parsed.request).toBe("rewrite the intro");
  });
});

describe("the candidate sources", () => {
  it("names the three verbs, in the product's order, each with its message", () => {
    // §3: a `command` row posts exactly the message its command-palette twin
    // already posts. The message name lives ON the candidate so that the row
    // and the button it duplicates cannot drift.
    const rows = commandCandidates("en");
    expect(rows.map((r) => r.name)).toEqual(["new", "compact", "history"]);
    expect(rows.map((r) => r.command)).toEqual([
      "newSession",
      "compactSession",
      "resumeSession",
    ]);
    for (const r of rows) expect(r.kind).toBe("command");
  });

  it("localizes the verb descriptions and leaves no English under zh", () => {
    for (const r of commandCandidates("zh")) {
      expect(r.description).toMatch(/[一-鿿]/);
      expect(r.description).not.toMatch(/[A-Za-z]{2,}\s+[A-Za-z]{2,}/);
    }
  });

  it("turns each loaded skill into one `/skill:<name>` insert row", () => {
    const rows = skillCandidates([
      { ...loadedSkill("tone"), description: "Tone" },
      loadedSkill("cite-check"),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["skill:tone", "skill:cite-check"]);
    for (const r of rows) {
      expect(r.kind).toBe("insert");
      expect(r.group).toBe("skills");
    }
  });

  it("passes a mixed-script description through AS AUTHORED", () => {
    // Invariant 6's stated boundary (E1, ADR 0045): Lemmaria localizes what it
    // writes as its own, never text a third party authored and Lemmaria merely
    // displays as theirs. 14 of 19 nature-skills descriptions mix scripts.
    const mixed = "Reference verifier · 检查参考文献 · DOI first";
    const [row] = skillCandidates([
      { ...loadedSkill("ref-verifier"), description: mixed },
    ]);
    expect(row?.description).toBe(mixed);
  });
});

describe("Candidate is a union on `kind` (E3, D4)", () => {
  // E2 carried `command?: CommandVerb` as an OPTIONAL field on every candidate,
  // and `acceptCompletion` guarded it with a branch its own comment called
  // "unreachable while `commandCandidates` is the only source". The union is
  // what makes that branch impossible rather than merely unreached — and it is
  // what lets an `insert` row say what it writes, which is the whole of E3's
  // need: an `@` row displays a path and inserts one WITHOUT the sigil, so the
  // insertion can no longer be derived from the label.

  it("gives every command row its message and no insertion", () => {
    for (const row of commandCandidates("en")) {
      expect(row.kind).toBe("command");
      if (row.kind !== "command") throw new Error("not a command row");
      expect(row.command).toBeTruthy();
      expect(row).not.toHaveProperty("insertion");
    }
  });

  it("gives every skill row its insertion and no message", () => {
    const rows = skillCandidates([loadedSkill("tone")]);
    for (const row of rows) {
      expect(row.kind).toBe("insert");
      if (row.kind !== "insert") throw new Error("not an insert row");
      expect(row.insertion).toBe("/skill:tone");
      expect(row).not.toHaveProperty("command");
    }
  });

  it("keeps a skill row's insertion equal to its DISPLAYED label", () => {
    // The sigil IS the engine's grammar for `/skill:`, so here — and only here
    // — what the row shows and what it writes are the same string. E3's path
    // rows deliberately break that (D4), which is why it is pinned for skills
    // rather than assumed for both.
    const [row] = skillCandidates([loadedSkill("tone")]);
    if (!row || row.kind !== "insert") throw new Error("no skill row");
    expect(row.insertion).toBe(label(SIGIL_SLASH, row));
  });
});

describe("MAX_ROWS", () => {
  it("is 8 — Codex's number, and Codex's reason", () => {
    // One height across every popup. Pi's settable version was rejected on
    // YAGNI: a setting costs a locale-keyed label, a persistence question and
    // a test, and nobody has asked for it.
    expect(MAX_ROWS).toBe(8);
  });
});

function loadedSkill(name: string) {
  return {
    name,
    description: "d",
    body: "b",
    source: "project" as const,
    path: `/p/${name}/SKILL.md`,
    references: [],
  };
}

describe("removeToken — the command kind's splice (E2 code review)", () => {
  // The defect this exists for: `acceptCompletion` cleared the WHOLE composer
  // for a `command` row. Design §3 says "clear the composer", written when the
  // composer was assumed to hold nothing but the verb — and it can hold a
  // draft, because a user who goes back to fix a typo in `/nw please help me`
  // re-opens the menu with their request still behind the token.

  it("removes the token and the single space after it", () => {
    const text = "/nw please help me";
    expect(removeToken(text, mustToken(text, 3))).toEqual({
      text: "please help me",
      caret: 0,
      written: "",
    });
  });

  it("leaves the composer EMPTY when the token is the whole draft", () => {
    // The ordinary case, and the one design §3 was written for.
    expect(removeToken("/new", mustToken("/new", 4))).toEqual({
      text: "",
      caret: 0,
      written: "",
    });
  });

  it("removes only ONE space, keeping deliberate whitespace", () => {
    const text = "/nw   spaced";
    expect(removeToken(text, mustToken(text, 3)).text).toBe("  spaced");
  });

  it("keeps a newline, which is not the separator it inserted", () => {
    const text = "/nw\nline two";
    expect(removeToken(text, mustToken(text, 3)).text).toBe("\nline two");
  });

  it("is the inverse of applyCompletion for the gap", () => {
    // Round-trip: complete, then remove the completed token, and the draft is
    // back exactly as it was. The two functions share one rule about the gap
    // and this is what stops them drifting apart.
    const start = "/sk fix this";
    const done = applyCompletion(start, mustToken(start, 3), "/skill:tone");
    const back = removeToken(done.text, mustToken(done.text, 5));
    expect(back.text).toBe("fix this");
  });
});

describe("E6 (D10): parsing /fork out of a whole message", () => {
  it("takes the bare verb, with no name", () => {
    expect(parseForkCommand("/fork")).toEqual({});
  });

  it("takes a trailing space as no name — the completion row's own output", () => {
    // The `/fork` row is INSERT-kind, so accepting it leaves exactly `"/fork "`
    // in the composer. A user who then presses Enter without typing a name must
    // get an unnamed fork, not a message sent to the model as prose.
    expect(parseForkCommand("/fork ")).toEqual({});
    expect(parseForkCommand("/fork   ")).toEqual({});
  });

  it("takes everything after the verb as the name, spaces and all", () => {
    expect(parseForkCommand("/fork another angle")).toEqual({
      name: "another angle",
    });
    expect(parseForkCommand("/fork   padded  ")).toEqual({ name: "padded" });
  });

  it("tolerates leading whitespace, which a paste can carry", () => {
    expect(parseForkCommand("  /fork")).toEqual({});
    expect(parseForkCommand("\n/fork a name")).toEqual({ name: "a name" });
  });

  it("leaves mid-message /fork as the prose it is", () => {
    // ADR 0050 lets a `/` open the MENU mid-message; this is a different
    // question — whether the whole message IS the command — and the anchor is
    // what keeps "we should /fork the repo here" a message to the model.
    expect(parseForkCommand("we should /fork the repo here")).toBe(null);
    expect(parseForkCommand("please /fork")).toBe(null);
  });

  it("does not fire on a longer verb that merely starts with it", () => {
    expect(parseForkCommand("/forking")).toBe(null);
    expect(parseForkCommand("/fork-me now")).toBe(null);
  });

  it("leaves a skill invocation alone", () => {
    // `/skill:` is the harness's grammar (ADR 0050) and reaches the model; a
    // parser that ate one would silently drop a request.
    expect(parseForkCommand("/skill:tone tighten this")).toBe(null);
    expect(parseForkCommand("/new")).toBe(null);
  });

  it("does not span lines: a two-line message is a message", () => {
    expect(parseForkCommand("/fork one\ntwo")).toBe(null);
  });
});

describe("E6 (D10): the /fork row", () => {
  const tokenAt = (text: string, caret: number) => {
    const t = activeToken(text, caret, SIGIL_SLASH);
    if (!t) throw new Error(`no token in ${JSON.stringify(text)}`);
    return t;
  };

  it("is offered when the token opens the message", () => {
    const rows = forkCandidates("en", tokenAt("/fo", 3));
    expect(rows.map((r) => r.name)).toEqual(["fork"]);
  });

  it("is NOT offered mid-message, where the command could not run", () => {
    // The parser is anchored to the whole message, so a `/fork` typed after
    // prose would be sent to the model. Offering the row there would be the
    // menu promising something the grammar refuses.
    expect(forkCandidates("en", tokenAt("draft this /fo", 14))).toEqual([]);
  });

  it("inserts the verb and a space, so a name can follow", () => {
    const row = forkCandidates("en", tokenAt("/f", 2))[0];
    expect(row?.kind).toBe("insert");
    const text = "/f";
    const done = applyCompletion(text, tokenAt(text, 2), row?.insertion ?? "");
    expect(done.text).toBe("/fork ");
    expect(done.caret).toBe(6);
  });

  it("describes itself in the reader's language", () => {
    expect(forkCandidates("en", tokenAt("/f", 2))[0]?.description).toBe(
      "Fork this session, with an optional new name",
    );
    expect(forkCandidates("zh", tokenAt("/f", 2))[0]?.description).toBe(
      "分叉当前会话，可指定新名称",
    );
  });

  it("ranks beside the command verbs, not below the skills", () => {
    const rows = rank(
      [...commandCandidates("en"), ...forkCandidates("en", tokenAt("/f", 2))],
      "fork",
    );
    expect(rows[0]?.candidate.name).toBe("fork");
    expect(rows[0]?.candidate.group).toBe("commands");
  });
});
/**
 * O23: the `/review` row (R3, ADR 0061 §2).
 *
 * The row's contract is not "it looks like /fork" but "what it writes is what
 * the HARNESS parses" — so the acceptance assertion runs `parseReviewCommand`,
 * the one source of truth, over the composer text the row leaves behind.
 */
describe("the /review row (O23)", () => {
  const tokenAt = (text: string, caret: number) => {
    const t = activeToken(text, caret, SIGIL_SLASH);
    if (!t) throw new Error(`no token in ${JSON.stringify(text)}`);
    return t;
  };

  it("is offered when the token opens the message", () => {
    expect(
      reviewCandidates("en", tokenAt("/rev", 4)).map((r) => r.name),
    ).toEqual(["review"]);
  });

  it("is NOT offered mid-message, where the harness would read it as prose", () => {
    expect(reviewCandidates("en", tokenAt("please /rev", 11))).toEqual([]);
  });

  it("inserts the verb and a space, and the result parses as the command", () => {
    const row = reviewCandidates("en", tokenAt("/r", 2))[0];
    expect(row?.kind).toBe("insert");
    const done = applyCompletion("/r", tokenAt("/r", 2), row?.insertion ?? "");
    expect(done.text).toBe("/review ");
    expect(done.caret).toBe(8);
    // The harness's own parser, over exactly what the composer now holds.
    expect(parseReviewCommand(done.text)).toEqual({});
    expect(parseReviewCommand(`${done.text}the statistics`)).toEqual({
      focus: "the statistics",
    });
  });

  it("describes itself in the reader's language", () => {
    expect(reviewCandidates("en", tokenAt("/r", 2))[0]?.description).toBe(
      "Review the whole manuscript with a blind panel",
    );
    expect(reviewCandidates("zh", tokenAt("/r", 2))[0]?.description).toBe(
      "由盲审小组通读全文并给出意见",
    );
  });

  it("ranks beside the command verbs, not below the skills", () => {
    const rows = rank(
      [...commandCandidates("en"), ...reviewCandidates("en", tokenAt("/r", 2))],
      "review",
    );
    expect(rows[0]?.candidate.name).toBe("review");
    expect(rows[0]?.candidate.group).toBe("commands");
  });
});

/**
 * O16: the `/review-pdf` row (V4, ADR 0081 §8) — the third harness-parsed
 * verb, offered under `/review`'s rule, and asserted against the harness's
 * own `parsePdfReviewCommand` over what the row leaves in the composer.
 */
describe("the /review-pdf row (O16)", () => {
  const tokenAt = (text: string, caret: number) => {
    const t = activeToken(text, caret, SIGIL_SLASH);
    if (!t) throw new Error(`no token in ${JSON.stringify(text)}`);
    return t;
  };

  it("is offered when the token opens the message", () => {
    expect(
      reviewPdfCandidates("en", tokenAt("/rev", 4)).map((r) => r.name),
    ).toEqual(["review-pdf"]);
  });

  it("is NOT offered mid-message, where the harness would read it as prose", () => {
    expect(reviewPdfCandidates("en", tokenAt("please /rev", 11))).toEqual([]);
  });

  it("inserts the verb and a space, and the result parses as the command", () => {
    const row = reviewPdfCandidates("en", tokenAt("/r", 2))[0];
    expect(row?.kind).toBe("insert");
    expect(row?.group).toBe("commands");
    const done = applyCompletion("/r", tokenAt("/r", 2), row?.insertion ?? "");
    expect(done.text).toBe("/review-pdf ");
    expect(done.caret).toBe(12);
    expect(parsePdfReviewCommand(done.text)).toEqual({});
    expect(parsePdfReviewCommand(`${done.text}the figures`)).toEqual({
      focus: "the figures",
    });
    // And it is not `/review` with a focus: the two verbs stay apart.
    expect(parseReviewCommand(done.text)).toBeNull();
  });

  it("describes itself in the reader's language", () => {
    // Sentence case since J1's round, as every other row of the menu is.
    expect(reviewPdfCandidates("en", tokenAt("/r", 2))[0]?.description).toBe(
      "Review the compiled PDF alone",
    );
    expect(reviewPdfCandidates("zh", tokenAt("/r", 2))[0]?.description).toBe(
      "单独评审已编译的 PDF",
    );
  });

  it("ranks second to /review for `review`, and first for `review-p`", () => {
    const token = tokenAt("/r", 2);
    const rows = [
      ...commandCandidates("en"),
      ...reviewCandidates("en", token),
      ...reviewPdfCandidates("en", token),
    ];
    const names = rank(rows, "review").map((r) => r.candidate.name);
    expect(names.slice(0, 2)).toEqual(["review", "review-pdf"]);
    expect(rank(rows, "review-p")[0]?.candidate.name).toBe("review-pdf");
  });
});
