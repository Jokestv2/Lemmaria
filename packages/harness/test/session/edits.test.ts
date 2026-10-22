import { describe, expect, it } from "vitest";
import type { ProposedEdit, SessionItem } from "../../src/contracts/index.js";
import {
  awaitsEditDecision,
  branchPoints,
  createdFilesSince,
  groupEditsByFile,
  invalidPathReason,
  parseProposeEditArgs,
  spliceAnchor,
  spliceEditsForFile,
  summarizeEditGroup,
  validateProposedEdits,
} from "../../src/session/edits.js";
import { expectLocalePair } from "../support/locale.js";

function reader(files: Record<string, string>) {
  return {
    readFile: async (file: string) => files[file],
    fileExists: async (file: string) => files[file] !== undefined,
  };
}

describe("parseProposeEditArgs", () => {
  it("seeds pending ProposedEdits from a valid replace + create batch", () => {
    const result = parseProposeEditArgs({
      edits: [
        { file: "main.tex", anchor: "teh", replacement: "the" },
        { file: "figs/new.tex", create: true, content: "x" },
      ],
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.edits).toEqual([
      {
        file: "main.tex",
        kind: "replace",
        anchor: "teh",
        replacement: "the",
        status: "pending",
      },
      {
        file: "figs/new.tex",
        kind: "create",
        content: "x",
        status: "pending",
      },
    ]);
  });

  it("rejects malformed payloads with one honest error", () => {
    expect(parseProposeEditArgs(null)).toHaveProperty("error");
    expect(parseProposeEditArgs({})).toHaveProperty("error");
    expect(parseProposeEditArgs({ edits: [] })).toHaveProperty("error");
    expect(parseProposeEditArgs({ edits: "x" })).toHaveProperty("error");
    // replace missing its replacement
    expect(
      parseProposeEditArgs({ edits: [{ file: "a.tex", anchor: "x" }] }),
    ).toHaveProperty("error");
    // create missing its content
    expect(
      parseProposeEditArgs({ edits: [{ file: "a.tex", create: true }] }),
    ).toHaveProperty("error");
    // neither variant
    expect(parseProposeEditArgs({ edits: [{ file: "a.tex" }] })).toHaveProperty(
      "error",
    );
  });
});

describe("invalidPathReason", () => {
  it("accepts workspace-relative paths in either slash style", () => {
    expect(invalidPathReason("sec/intro.tex")).toBeUndefined();
    expect(invalidPathReason("sec\\intro.tex")).toBeUndefined();
    expect(invalidPathReason("main.tex")).toBeUndefined();
  });

  it("refuses empty, absolute, and escaping paths", () => {
    expect(invalidPathReason("")).toBeTruthy();
    expect(invalidPathReason("../x.tex")).toBeTruthy();
    expect(invalidPathReason("a/../../x.tex")).toBeTruthy();
    expect(invalidPathReason("/abs/x.tex")).toBeTruthy();
    expect(invalidPathReason("C:\\x.tex")).toBeTruthy();
    expect(invalidPathReason("\\\\server\\share.tex")).toBeTruthy();
  });
});

describe("validateProposedEdits", () => {
  const pending = (edit: Partial<ProposedEdit>): ProposedEdit =>
    ({ status: "pending", ...edit }) as ProposedEdit;

  it("marks anchor/path/create defects invalid and keeps valid edits pending", async () => {
    const host = reader({
      "main.tex": "alpha beta alpha",
      "exists.tex": "already here",
    });
    const validated = await validateProposedEdits(
      [
        pending({
          file: "main.tex",
          kind: "replace",
          anchor: "beta",
          replacement: "b",
        }),
        pending({
          file: "main.tex",
          kind: "replace",
          anchor: "alpha",
          replacement: "a",
        }),
        pending({
          file: "main.tex",
          kind: "replace",
          anchor: "gamma",
          replacement: "g",
        }),
        pending({
          file: "missing.tex",
          kind: "replace",
          anchor: "x",
          replacement: "y",
        }),
        pending({
          file: "../out.tex",
          kind: "replace",
          anchor: "x",
          replacement: "y",
        }),
        pending({ file: "exists.tex", kind: "create", content: "clobber" }),
        pending({ file: "new.tex", kind: "create", content: "fresh" }),
      ],
      host,
    );
    expect(validated.map((e) => e.status)).toEqual([
      "pending",
      "invalid", // ambiguous anchor
      "invalid", // anchor not found
      "invalid", // file not found
      "invalid", // escaping path
      "invalid", // create target exists
      "pending",
    ]);
    expect(validated[1]?.note).toMatch(/ambiguous|once/i);
    expect(validated[2]?.note).toMatch(/not found/i);
    expect(validated[3]?.note).toMatch(/not found|no such/i);
    expect(validated[5]?.note).toMatch(/exists/i);
  });
});

describe("spliceAnchor", () => {
  it("replaces a unique anchor in place", () => {
    expect(spliceAnchor("say teh word", "teh", "the")).toBe("say the word");
  });

  it("returns undefined when the anchor no longer matches or is ambiguous", () => {
    expect(spliceAnchor("content changed", "teh", "the")).toBeUndefined();
    expect(spliceAnchor("teh and teh", "teh", "the")).toBeUndefined();
  });
});

// --- A1b follow-up (manual-test round): per-file decision grouping, the
// approval-pause predicate, and per-turn created-file bookkeeping. ---

function pending(
  file: string,
  anchor: string,
  replacement: string,
): ProposedEdit {
  return { file, kind: "replace", anchor, replacement, status: "pending" };
}

describe("groupEditsByFile", () => {
  it("groups a file's edits into one decision unit, in first-appearance order", () => {
    const edits = [
      pending("a.tex", "one", "1"),
      pending("b.tex", "two", "2"),
      pending("a.tex", "three", "3"),
    ];
    expect(groupEditsByFile(edits)).toEqual([
      { file: "a.tex", indices: [0, 2] },
      { file: "b.tex", indices: [1] },
    ]);
  });

  it("keeps a create and a replace of the same file in one group", () => {
    const edits: ProposedEdit[] = [
      { file: "p.py", kind: "create", content: "x", status: "pending" },
      pending("p.py", "x", "y"),
    ];
    expect(groupEditsByFile(edits)).toEqual([
      { file: "p.py", indices: [0, 1] },
    ]);
  });

  it("returns no groups for an empty batch", () => {
    expect(groupEditsByFile([])).toEqual([]);
  });
});

describe("spliceEditsForFile", () => {
  it("applies every replace of one file in order, so the diff shows them together", () => {
    const content = "teh cat sat on teh mat";
    const edits = [
      pending("a.tex", "teh cat", "the cat"),
      pending("a.tex", "teh mat", "the mat"),
    ];
    expect(spliceEditsForFile(content, edits)).toBe("the cat sat on the mat");
  });

  it("returns undefined when any anchor no longer matches exactly once", () => {
    const edits = [
      pending("a.tex", "teh cat", "the cat"),
      pending("a.tex", "nope", "x"),
    ];
    expect(spliceEditsForFile("teh cat", edits)).toBeUndefined();
  });

  it("takes a create's content as the whole proposed file", () => {
    const edits: ProposedEdit[] = [
      {
        file: "p.py",
        kind: "create",
        content: "print(1)\n",
        status: "pending",
      },
    ];
    expect(spliceEditsForFile("", edits)).toBe("print(1)\n");
  });
});

describe("awaitsEditDecision", () => {
  it("is true while a proposal still has a pending edit", () => {
    expect(
      awaitsEditDecision([
        { id: "1", type: "user_message", text: "hi" },
        {
          id: "2",
          type: "edit_proposal",
          policy: "review",
          edits: [pending("a.tex", "x", "y")],
        },
      ]),
    ).toBe(true);
  });

  it("is false once every edit reached a terminal status", () => {
    expect(
      awaitsEditDecision([
        {
          id: "2",
          type: "edit_proposal",
          policy: "review",
          edits: [{ ...pending("a.tex", "x", "y"), status: "applied" }],
        },
      ]),
    ).toBe(false);
  });

  it("is false for a transcript with no proposals", () => {
    expect(
      awaitsEditDecision([{ id: "1", type: "user_message", text: "hi" }]),
    ).toBe(false);
  });
});

describe("createdFilesSince", () => {
  const items: SessionItem[] = [
    { id: "u1", type: "user_message", text: "first" },
    {
      id: "p1",
      type: "edit_proposal",
      policy: "review",
      edits: [
        { file: "early.py", kind: "create", content: "", status: "applied" },
      ],
    },
    { id: "u2", type: "user_message", text: "second" },
    {
      id: "p2",
      type: "edit_proposal",
      policy: "review",
      edits: [
        { file: "late.py", kind: "create", content: "", status: "applied" },
        { file: "skipped.py", kind: "create", content: "", status: "rejected" },
      ],
    },
  ];

  it("lists only files created at or after the given user message", () => {
    expect(createdFilesSince(items, "u2")).toEqual(["late.py"]);
  });

  it("lists every applied creation from the first message", () => {
    expect(createdFilesSince(items, "u1")).toEqual(["early.py", "late.py"]);
  });

  it("lists nothing for an unknown message id", () => {
    expect(createdFilesSince(items, "nope")).toEqual([]);
  });
});

describe("summarizeEditGroup (review round 2: a file row must not hide a write)", () => {
  const at = (status: ProposedEdit["status"]): ProposedEdit => ({
    file: "a.tex",
    kind: "replace",
    anchor: "x",
    replacement: "y",
    status,
  });

  it("is pending while any edit is still undecided", () => {
    expect(summarizeEditGroup([at("pending"), at("applied")]).status).toBe(
      "pending",
    );
  });

  it("reports applied when work landed, even alongside a failure", () => {
    // The old 'any non-applied wins' rule rendered this as ✗ invalid, telling
    // the user nothing was written when in fact a file had been changed.
    const summary = summarizeEditGroup([at("applied"), at("invalid")]);
    expect(summary.status).toBe("applied");
    expect(summary.counts).toEqual({ applied: 1, invalid: 1 });
  });

  it("reports the failure when nothing landed", () => {
    expect(summarizeEditGroup([at("invalid"), at("invalid")])).toEqual({
      status: "invalid",
      counts: { invalid: 2 },
    });
  });

  it("treats a wholly rejected group as rejected", () => {
    expect(summarizeEditGroup([at("rejected")]).status).toBe("rejected");
  });

  it("is applied for an all-applied group with no failure counts to show", () => {
    expect(summarizeEditGroup([at("applied"), at("applied")])).toEqual({
      status: "applied",
      counts: { applied: 2 },
    });
  });
});

describe("branchPoints", () => {
  it("offers every non-steered user message, whether or not it wrote", () => {
    const items: SessionItem[] = [
      { id: "m1", type: "user_message", text: "a question" },
      { id: "m2", type: "user_message", text: "steered", steered: true },
      { id: "m3", type: "user_message", text: "an edit" },
    ];
    expect(branchPoints(items)).toEqual(["m1", "m3"]);
  });

  it("offers a message whose turn wrote nothing", () => {
    // The defect the redesign exists to fix, stated the other way round: B6's
    // `restoreTargets` offered nothing after the last git checkpoint, so "ask
    // it differently" — the everyday reason to branch — was unreachable, and
    // in a non-git workspace EVERY message was.
    const items: SessionItem[] = [
      { id: "u1", type: "user_message", text: "one" },
      {
        id: "p1",
        type: "edit_proposal",
        policy: "review",
        edits: [{ file: "paper.tex", status: "applied", kind: "replace" }],
      },
      { id: "u2", type: "user_message", text: "two (nothing written after)" },
    ];
    expect(branchPoints(items)).toEqual(["u1", "u2"]);
  });

  it("ignores everything that is not a user message", () => {
    const items: SessionItem[] = [
      { id: "a1", type: "agent_message", text: "hi" },
      { id: "u1", type: "user_message", text: "one" },
      { id: "n1", type: "notice", code: "context.limit", message: "…" },
    ];
    expect(branchPoints(items)).toEqual(["u1"]);
  });

  it("is empty for an empty transcript", () => {
    expect(branchPoints([])).toEqual([]);
  });
});

describe("round-2 review hardening", () => {
  it("refuses writes into .git (a hook write survives restore and runs on commit)", () => {
    expect(invalidPathReason(".git/hooks/pre-commit")).toBeTruthy();
    expect(invalidPathReason(".git\\config")).toBeTruthy();
    // …but a dotfile that merely starts with "git" is fine.
    expect(invalidPathReason(".gitconfig")).toBeUndefined();
    expect(invalidPathReason("nested/.git/hooks/pre-commit")).toBeTruthy();
    // A legitimately-named file is not caught by the guard.
    expect(invalidPathReason("gitignore.tex")).toBeUndefined();
    expect(invalidPathReason("docs/.gitkeep")).toBeUndefined();
  });

  it("does not offer a branch point on a steering message", () => {
    // Steering joins a RUNNING task, so it is not a task boundary: branching
    // there would split a turn from its own request.
    const items: SessionItem[] = [
      { id: "u1", type: "user_message", text: "task one" },
      { id: "s1", type: "user_message", text: "steering", steered: true },
      { id: "u2", type: "user_message", text: "task two" },
    ];
    expect(branchPoints(items)).toEqual(["u1", "u2"]);
  });
});

/**
 * D1 (ADR 0032): the protected-span arm of proposal-time validation. It can
 * only ever refuse — nothing is written here, under either policy.
 */
describe("validateProposedEdits — protected spans (D1)", () => {
  const pending = (edit: Partial<ProposedEdit>): ProposedEdit =>
    ({ status: "pending", ...edit }) as ProposedEdit;

  /** `%` comments and `$…$` math, standing in for the real fragment detector. */
  const spanReader = (file: string, text: string) => {
    const spans = [];
    for (const re of [/%[^\n]*/g, /\$[^$\n]+\$/g]) {
      for (const m of text.matchAll(re)) {
        spans.push({
          file,
          startOffset: m.index,
          endOffset: m.index + m[0].length,
          kind: (m[0].startsWith("%") ? "comment" : "math") as
            | "comment"
            | "math",
          token: "⟦P0⟧",
          raw: m[0],
        });
      }
    }
    return Promise.resolve(spans);
  };

  const source = "The result holds. % TODO: verify\nWe see $O(n)$ growth.\n";

  it("marks an edit that drops a comment invalid, and says how to proceed", async () => {
    const validated = await validateProposedEdits(
      [
        pending({
          file: "main.tex",
          kind: "replace",
          anchor: "The result holds. % TODO: verify",
          replacement: "The result holds firmly.",
        }),
      ],
      reader({ "main.tex": source }),
      spanReader,
    );
    expect(validated[0]?.status).toBe("invalid");
    expect(validated[0]?.note).toContain("% TODO: verify");
    expect(validated[0]?.note).toMatch(/dropped silently/);
    // Names the escape as well as the failure — and the escape is now the
    // declaration, not D1's withdrawn anchor trick (ADR 0033).
    expect(validated[0]?.note).toMatch(/removes_protected/);
    // ADR 0034: ONE language. The same call under "zh" renders Chinese and no
    // English clause; asserting both against ONE string was the D1 mistake.
    expect(validated[0]?.note).not.toMatch(/[一-鿿]/);
    const zh = await validateProposedEdits(
      [
        pending({
          file: "main.tex",
          kind: "replace",
          anchor: "The result holds. % TODO: verify",
          replacement: "The result holds firmly.",
        }),
      ],
      reader({ "main.tex": source }),
      spanReader,
      "zh",
    );
    expect(zh[0]?.note).toMatch(/受保护内容/);
    expect(zh[0]?.note).toMatch(/removes_protected/);
    expect(zh[0]?.note).not.toMatch(/dropped silently/);
  });

  it("leaves an edit that reproduces the protected content pending", async () => {
    const validated = await validateProposedEdits(
      [
        pending({
          file: "main.tex",
          kind: "replace",
          anchor: "The result holds. % TODO: verify",
          replacement: "The result holds firmly. % TODO: verify",
        }),
      ],
      reader({ "main.tex": source }),
      spanReader,
    );
    expect(validated[0]?.status).toBe("pending");
  });

  it("reports a bad anchor rather than a protected span — the better message wins", async () => {
    const validated = await validateProposedEdits(
      [
        pending({
          file: "main.tex",
          kind: "replace",
          anchor: "no such text % TODO: verify",
          replacement: "anything",
        }),
      ],
      reader({ "main.tex": source }),
      spanReader,
    );
    expect(validated[0]?.status).toBe("invalid");
    expect(validated[0]?.note).toMatch(/not found/i);
  });

  it("never constrains a create — a new file has nothing to preserve", async () => {
    const validated = await validateProposedEdits(
      [pending({ file: "new.tex", kind: "create", content: "fresh prose" })],
      reader({ "main.tex": source }),
      spanReader,
    );
    expect(validated[0]?.status).toBe("pending");
  });

  it("without a reader, behaviour is exactly what it was before D1", async () => {
    const validated = await validateProposedEdits(
      [
        pending({
          file: "main.tex",
          kind: "replace",
          anchor: "The result holds. % TODO: verify",
          replacement: "The result holds firmly.",
        }),
      ],
      reader({ "main.tex": source }),
    );
    expect(validated[0]?.status).toBe("pending");
  });

  it("a reader that cannot analyse the file enforces nothing", async () => {
    const validated = await validateProposedEdits(
      [
        pending({
          file: "notes.rst",
          kind: "replace",
          anchor: "The result holds. % TODO: verify",
          replacement: "The result holds firmly.",
        }),
      ],
      reader({ "notes.rst": source }),
      () => Promise.resolve(undefined),
    );
    expect(validated[0]?.status).toBe("pending");
  });
});

/**
 * D4 (invariant 6 rule 2, ADR 0034): the proposal-time notes render in the
 * session locale. X2 threaded the locale into `validateProposedEdits` and
 * localized the two protected-content refusals through it; the path-containment
 * reasons and the anchor notes stayed English literals, which is the standing
 * D1 open question — raised 2026-08-08, proposed for D4, closed here.
 *
 * Note what is NOT asserted: that one string carries both languages. That is
 * the assertion ADR 0034 §5 identifies as certifying the defect.
 */
describe("proposal notes — one language per reader (D4)", () => {
  const noteFor = async (
    edit: ProposedEdit,
    locale: "en" | "zh",
  ): Promise<string> => {
    const host = {
      readFile: async (f: string) =>
        f === "main.tex" ? "alpha beta alpha" : undefined,
      fileExists: async (f: string) => f === "main.tex",
    };
    const [out] = await validateProposedEdits([edit], host, undefined, locale);
    return out?.note ?? "";
  };

  const replace = (over: Partial<ProposedEdit>): ProposedEdit =>
    ({
      kind: "replace",
      file: "main.tex",
      anchor: "beta",
      replacement: "gamma",
      ...over,
    }) as ProposedEdit;

  it("renders every path-containment reason in one language, differing by locale", async () => {
    for (const file of [
      "",
      "/abs/x.tex",
      "C:\\x.tex",
      ".git/hooks/pre-commit",
      "../escape.tex",
    ]) {
      const en = await noteFor(replace({ file }), "en");
      const zh = await noteFor(replace({ file }), "zh");
      expectLocalePair(en, zh, [file, ".git"]);
    }
  });

  it("renders the ambiguous-anchor note in one language, differing by locale", async () => {
    const edit = replace({ anchor: "alpha" });
    expectLocalePair(await noteFor(edit, "en"), await noteFor(edit, "zh"));
  });

  it("renders the anchor-not-found note in one language, differing by locale", async () => {
    const edit = replace({ anchor: "nowhere" });
    expectLocalePair(await noteFor(edit, "en"), await noteFor(edit, "zh"));
  });

  it("renders the file-not-found note in one language, differing by locale", async () => {
    const edit = replace({ file: "missing.tex" });
    expectLocalePair(await noteFor(edit, "en"), await noteFor(edit, "zh"), [
      "missing.tex",
    ]);
  });

  it("renders the file-already-exists note in one language, differing by locale", async () => {
    const edit = {
      kind: "create",
      file: "main.tex",
      replacement: "x",
    } as ProposedEdit;
    expectLocalePair(await noteFor(edit, "en"), await noteFor(edit, "zh"), [
      "main.tex",
    ]);
  });

  it("defaults to English, so every pre-D4 caller is byte-identical", async () => {
    const host = {
      readFile: async () => undefined,
      fileExists: async () => false,
    };
    const [dflt] = await validateProposedEdits(
      [replace({ file: "missing.tex" })],
      host,
    );
    const [en] = await validateProposedEdits(
      [replace({ file: "missing.tex" })],
      host,
      undefined,
      "en",
    );
    expect(dflt?.note).toBe(en?.note);
  });
});
