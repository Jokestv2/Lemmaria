import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  CompileLogReader,
  CompileResult,
  LedgerCounts,
  ModelBinding,
  PanelDimension,
  PdfDocument,
  PdfFacts,
  PdfRenderer,
  Readiness,
  ReviewAssessment,
  ReviewEvidence,
  ReviewItem,
  ReviewLimit,
  ReviewPaper,
  ReviewPdfDeps,
  ReviewPdfRecord,
  ReviewResult,
  ReviewSeatState,
  ReviewStrength,
  ReviewVenue,
  Scorecard,
  ScorecardDelta,
  ScorecardStanding,
  SessionEvent,
  SessionItem,
  SessionMeta,
  SessionRecord,
  SubtaskItem,
} from "../src/contracts/index.js";
import {
  PANEL_DIMENSIONS,
  SESSION_FORMAT_VERSION,
} from "../src/contracts/index.js";
import {
  ALL_TOOL_ERROR_CODES,
  fail,
  ok,
  toolFail,
} from "../src/contracts/results.js";
import { ALL_TOOL_NAMES, type ToolName } from "../src/contracts/tools.js";

describe("contracts", () => {
  it("session contracts (ADR 0014) compile and discriminate", () => {
    const meta: SessionMeta = {
      id: "s1",
      title: "draft the intro",
      workspace: "/w",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const items: SessionItem[] = [
      { id: "i1", type: "user_message", text: "hi" },
      { id: "i2", type: "agent_message", text: "hello" },
      { id: "i3", type: "reasoning", summary: "…" },
      {
        id: "i4",
        type: "tool_call",
        tool: "get_outline",
        argsJson: "{}",
        status: "completed",
      },
      {
        id: "i5",
        type: "edit_proposal",
        policy: "review",
        edits: [
          {
            file: "main.tex",
            kind: "replace",
            anchor: "teh",
            replacement: "the",
            status: "pending",
          },
          {
            file: "figs/plot.tex",
            kind: "create",
            content: "\\begin{tikzpicture}\\end{tikzpicture}",
            status: "applied",
          },
          {
            file: "main.tex",
            kind: "replace",
            anchor: "x",
            replacement: "y",
            status: "rejected",
            note: "keep the original phrasing",
          },
        ],
        // ADR 0031: the batch-level content-identity manifest compiles too.
        fileStates: [
          {
            file: "figs/plot.tex",
            before: null,
            after: "9f2b1c...",
          },
        ],
      },
      { id: "i6", type: "todo_list", items: [{ text: "t", completed: false }] },
      { id: "i7", type: "interrupted" },
      { id: "i8", type: "error", message: "boom" },
      {
        id: "i9",
        type: "notice",
        code: "context.limit",
        message: "context limit reached / 已达上下文上限",
      },
      {
        id: "i10",
        type: "changed_files",
        files: [{ file: "main.tex", edits: 2, created: false }],
      },
      {
        id: "i11",
        type: "notice",
        code: "provider.quota",
        message: "provider quota exhausted / 服务商额度已用尽",
      },
      {
        id: "i12",
        type: "grant_update",
        action: "added",
        grant: { id: "g1", path: "D:\\data\\results", label: "results" },
      },
    ];
    const events: SessionEvent[] = [
      { type: "task.started" },
      { type: "turn.started", turn: 1 },
      { type: "item.completed", item: items[0] as SessionItem },
      {
        type: "turn.completed",
        turn: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { type: "turn.failed", turn: 2, error: "x" },
      { type: "task.completed", status: "interrupted" },
    ];
    // A file is a versioned meta record then event records, each with its own
    // minted id — and nothing else (ADR 0057; ADR 0027's `leaf` kind is gone).
    // These two literals had been missing `version` and `id` since B5 and
    // still compiled, because nothing typechecks this package's tests; E5 ran
    // that check once by hand and this is what it found.
    const records: SessionRecord[] = [
      {
        at: meta.createdAt,
        kind: "meta",
        version: SESSION_FORMAT_VERSION,
        meta,
      },
      {
        at: meta.createdAt,
        kind: "event",
        id: "n1",
        event: events[0] as SessionEvent,
      },
    ];
    expect(records).toHaveLength(2);
    const first = events[1] as SessionEvent;
    if (first.type === "turn.started") expect(first.turn).toBe(1);
    expect(items).toHaveLength(12);
  });

  it("edit-host contracts (ADR 0016) compile", async () => {
    const decisions: import("../src/contracts/index.js").EditDecision[] = [
      { accept: true },
      { accept: false, note: "not this one" },
    ];
    const host: import("../src/contracts/index.js").SessionEditHost = {
      policy: () => "review",
      readFile: async () => undefined,
      writeFile: async () => {},
      fileExists: async () => false,
      requestDecisions: async () => decisions,
    };
    expect(host.policy()).toBe("review");
    expect(await host.requestDecisions).toBeDefined();
  });

  it("run_script is in the tool allowlist (A4b, invariant 2)", () => {
    expect(ALL_TOOL_NAMES).toContain("run_script");
  });

  it("script-run contracts (A4b, ADR 0020) compile and discriminate", async () => {
    const item: SessionItem = {
      id: "s1",
      type: "script_run",
      command: ["python", "plot.py", "--fast"],
      rootId: "g1",
      rootLabel: "results",
      status: "completed",
      stdout: "done",
      stderr: "",
      exitCode: 0,
      truncated: false,
    };
    expect(item.type).toBe("script_run");
    const host: import("../src/contracts/index.js").SessionScriptHost = {
      interpreters: () => ["python", "Rscript"],
      requestApproval: async () => ({ approve: true }),
      run: async () => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        truncated: false,
      }),
    };
    expect(host.interpreters()).toContain("python");
    expect(await host.run(["python", "x.py"], "/tmp", undefined)).toBeDefined();
  });

  it("spawn_subtask is in both the ToolName type and the runtime mirror (A3)", () => {
    expect(ALL_TOOL_NAMES).toContain("spawn_subtask");
    const name: ToolName = "spawn_subtask"; // type-level: compiles only if in the union
    expect(name).toBe("spawn_subtask");
  });

  it("a SubtaskItem carries ordered per-child reports (A3)", () => {
    const item: SubtaskItem = {
      id: "s1",
      type: "subtask",
      status: "completed",
      reports: [
        {
          goal: "survey repo A",
          status: "completed",
          summary: "found 3 entry points",
          allowedTools: ["read_span", "grep_project"],
        },
        {
          goal: "survey repo B",
          status: "failed",
          summary: "(the subtask produced no report)",
          allowedTools: ["read_span"],
        },
      ],
    };
    const asSessionItem: SessionItem = item; // union membership
    expect(asSessionItem.type).toBe("subtask");
    expect(item.reports.map((r) => r.goal)).toEqual([
      "survey repo A",
      "survey repo B",
    ]);
  });

  it("ALL_TOOL_NAMES mirrors the ToolName union (the capability boundary)", () => {
    expect(ALL_TOOL_NAMES).toEqual([
      "get_outline",
      "read_span",
      "grep_project",
      "glossary_lookup",
      "list_labels",
      "list_citations",
      "count_words",
      "citation_check",
      "apply_edit",
      "verify",
      "update_plan",
      "propose_edit",
      "list_files",
      "literature_search",
      "run_script",
      "spawn_subtask",
      "load_skill",
      "view_pdf_pages",
    ]);
  });

  it("load_skill is in the runtime allowlist, so the loader can clamp to it", () => {
    // Invariant 2's clamp (`actions/loader.ts`) runs off ALL_TOOL_NAMES, not
    // off the union — a name in the union alone is a tool no action can request.
    expect((ALL_TOOL_NAMES as readonly string[]).includes("load_skill")).toBe(
      true,
    );
  });

  it("view_pdf_pages is in the runtime allowlist, and it is the only new name (V3, ADR 0080)", () => {
    expect(
      (ALL_TOOL_NAMES as readonly string[]).includes("view_pdf_pages"),
    ).toBe(true);
    // Invariant 2: the allowlist grew by EXACTLY one name this milestone.
    expect(ALL_TOOL_NAMES).toHaveLength(18);
    expect(ALL_TOOL_NAMES[ALL_TOOL_NAMES.length - 1]).toBe("view_pdf_pages");
  });
});

describe("images on a message, and the PDF renderer port (V3, ADR 0080)", () => {
  it("ImagePart rides beside content on a user message, and data may be absent once evicted", () => {
    const live: ChatMessage = {
      role: "user",
      content: "look at this",
      images: [
        { mimeType: "image/png", data: "iVBORw0KGgo=", label: "page 1" },
      ],
    };
    const evicted: ChatMessage = {
      role: "user",
      content: "look at this",
      images: [{ mimeType: "image/png", label: "page 1" }],
    };
    // `content` stays a string in BOTH cases — the sibling, never a union. That
    // is what leaves compaction, plainHistory, the token estimate and the
    // scripted adapter correct untouched (D1).
    expect(typeof live.content).toBe("string");
    expect(live.images?.[0]?.data).toBe("iVBORw0KGgo=");
    expect(evicted.images?.[0]?.data).toBeUndefined();
    expect(evicted.images?.[0]?.label).toBe("page 1");
  });

  it("a tool message carries images too, and images is optional everywhere", () => {
    const toolMsg: ChatMessage = {
      role: "tool",
      content: '{"pages":[{"page":1}]}',
      toolCallId: "call_1",
      images: [{ mimeType: "image/png", data: "AAA=", label: "page 1" }],
    };
    const plain: ChatMessage = { role: "assistant", content: "ok" };
    expect(toolMsg.images).toHaveLength(1);
    expect(plain.images).toBeUndefined();
  });

  it("ModelBinding may declare image input, and may leave it to the table", () => {
    const declared: ModelBinding = {
      protocol: "openai-compatible",
      endpoint: "https://example.test/v1",
      model: "mystery-1",
      apiKey: "k",
      imageInput: true,
    };
    const undeclared: ModelBinding = {
      protocol: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-haiku-4-5-20251001",
      apiKey: "k",
    };
    expect(declared.imageInput).toBe(true);
    expect(undeclared.imageInput).toBeUndefined();
  });

  it("the PdfRenderer port degrades honestly, in ManuscriptGraphReader's shape", async () => {
    const renderer: PdfRenderer = async (pdf) => {
      if (pdf.length === 0) return undefined; // not a PDF this renderer can open
      const doc: PdfDocument = {
        pageCount: 2,
        pageSize: () => ({ width: 612, height: 792 }),
        renderPage: async (_page, opts) => ({
          png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          width: opts.width,
          height: Math.round(opts.width * (792 / 612)),
        }),
        pageText: async () => "hello",
        metadata: async () => ({ producer: "pdfTeX" }),
        close: () => {},
      };
      return doc;
    };
    expect(await renderer(new Uint8Array())).toBeUndefined();
    const doc = await renderer(new Uint8Array([1]));
    expect(doc?.pageCount).toBe(2);
    const page = await doc?.renderPage(1, { width: 1100 });
    expect(page?.width).toBe(1100);
    doc?.close();
  });

  it("CompileResult may carry the PDF it built, and is otherwise today's shape", () => {
    const withoutPdf: CompileResult = { ok: true, log: "…" };
    const withPdf: CompileResult = {
      ok: true,
      log: "…",
      pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    };
    expect(withoutPdf.pdf).toBeUndefined();
    expect(withPdf.pdf?.[0]).toBe(0x25); // "%"
  });
});

describe("Result / ToolError (B0, ADR 0024)", () => {
  it("ok carries the value and narrows", () => {
    const r = ok({ text: "hi" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ text: "hi" });
  });

  it("toolFail carries a code the model and the UI can both branch on", () => {
    const r = toolFail("not_found", "no such file: a.tex");
    expect(r).toEqual({
      ok: false,
      error: { code: "not_found", message: "no such file: a.tex" },
    });
  });

  it("fail is generic over the error type", () => {
    expect(fail("boom")).toEqual({ ok: false, error: "boom" });
  });

  // The runtime mirror is what the UI's exhaustive locale table is checked
  // against; a code added without a locale must fail a build, not a user.
  it("ALL_TOOL_ERROR_CODES mirrors the union with no duplicates", () => {
    expect([...ALL_TOOL_ERROR_CODES].sort()).toEqual([
      "denied",
      "invalid",
      "not_found",
      "rate_limited",
      "refused",
      "too_large",
      "unavailable",
    ]);
    expect(new Set(ALL_TOOL_ERROR_CODES).size).toBe(
      ALL_TOOL_ERROR_CODES.length,
    );
  });
});

/**
 * V2 (ADR 0078): `ReviewEvidence` is a discriminated union of three kinds, and
 * the panel's dimension list lives in the contracts rather than in the driver.
 *
 * The union is what makes `paper` addable at all: before V2 the two shapes were
 * told apart by `evidence === "missing"`, which leaves no room for a third that
 * is also an object. Tagging them is a REPLACEMENT, not a widening — there is no
 * backward-compatibility burden (CLAUDE.md → Conventions, operator direction
 * 2026-09-20), so nothing reads the old shapes and the store starts over.
 */
describe("review evidence and the panel's dimensions (V2, ADR 0078)", () => {
  it("discriminates the three evidence kinds", () => {
    const evidences: ReviewEvidence[] = [
      { kind: "span", file: "main.tex", line: 12 },
      { kind: "missing" },
      {
        kind: "paper",
        title: "Adam: A Method for Stochastic Optimization",
        authors: ["Diederik P. Kingma", "Jimmy Ba"],
        year: "2015",
        venue: "ICLR",
        doi: "10.48550/arXiv.1412.6980",
        url: "https://arxiv.org/abs/1412.6980",
        source: "arxiv",
      },
      // V4 (ADR 0081): the fourth kind — a page the PDF reviewer viewed.
      { kind: "page", page: 3 },
    ];
    // Each arm narrows on `kind` alone — no `=== "missing"` string test, and
    // no structural guess about which object is which.
    const seen = evidences.map((e) => {
      switch (e.kind) {
        case "span":
          return `${e.file}:${e.line}`;
        case "missing":
          return "missing";
        case "paper":
          return `${e.title} (${e.source})`;
        case "page":
          return `page ${e.page}`;
      }
    });
    expect(seen).toEqual([
      "main.tex:12",
      "missing",
      "Adam: A Method for Stochastic Optimization (arxiv)",
      "page 3",
    ]);
  });

  it("a paper carries only what the RECORDED result had — never an abstract", () => {
    const paper: ReviewPaper = {
      title: "基于注意力的神经机器翻译",
      authors: [],
      source: "crossref",
    };
    // The optional halves are genuinely optional: a result that came back with
    // a title and nothing else is still a paper, and the harness never fills a
    // field the index did not answer with.
    expect(Object.keys(paper).sort()).toEqual(["authors", "source", "title"]);
    // No `abstract` key exists on the type; the verifier is handed it live
    // (ADR 0078, D11) and nothing persists it.
    expect("abstract" in paper).toBe(false);
  });

  it("PANEL_DIMENSIONS is the contract's, and holds eight", () => {
    expect([...PANEL_DIMENSIONS]).toEqual([
      "soundness",
      "claims",
      "clarity",
      "language",
      "positioning",
      "originality",
      "significance",
      // V4 (ADR 0081): last, and only a seat that viewed pages can file it.
      "presentation",
    ]);
    expect(new Set(PANEL_DIMENSIONS).size).toBe(PANEL_DIMENSIONS.length);
    const d: PanelDimension = "originality";
    expect(PANEL_DIMENSIONS.includes(d)).toBe(true);
  });

  it("a review can record that it could not guard its own title", () => {
    const limits: ReviewLimit[] = [
      { kind: "own_title_unguarded", reason: "no_title" },
      { kind: "own_title_unguarded", reason: "unavailable" },
    ];
    // A LIMIT and not a notice (D8): a completed panel's WARN notices do not
    // survive to the tab, and the record has to say so on its own.
    expect(
      limits.map((l) => l.kind === "own_title_unguarded" && l.reason),
    ).toEqual(["no_title", "unavailable"]);
  });
});

/**
 * V4 (ADR 0081): the compiled PDF reaches the record — three limits for the
 * ways a review falls short of it, a facts record, a sibling seat, and the two
 * ports the driver is handed.
 */
describe("a panel's set-aside concerns (ADR 0083 §2)", () => {
  it("is a limit naming the seat and each concern's dimension, and a count present only when non-zero", () => {
    const limit: ReviewLimit = {
      kind: "concerns_set_aside",
      reviewer: "pdf_reviewer",
      entries: [{ dimension: "claims" }, { dimension: "soundness" }],
    };
    expect(limit.kind === "concerns_set_aside" && limit.entries.length).toBe(2);
    const none: LedgerCounts = {
      entries: 1,
      located: 1,
      relocated: 0,
      dropped: 0,
      rejected: 0,
    };
    const some: LedgerCounts = { ...none, entries: 3, setAside: 2 };
    for (const c of [none, some]) {
      expect(c.located + c.dropped + c.rejected + (c.setAside ?? 0)).toBe(
        c.entries,
      );
    }
  });
});

describe("the PDF reviewer's contracts (V4, ADR 0081)", () => {
  it("records the three new limits, each panel-wide, with exactly D1's reasons", () => {
    const limits: ReviewLimit[] = [
      { kind: "pdf_unavailable", reason: "none" },
      { kind: "pdf_unavailable", reason: "stale" },
      {
        kind: "pdf_unavailable",
        reason: "compile_failed",
        detail: "! Undefined control sequence.",
      },
      { kind: "pdf_unavailable", reason: "render_failed" },
      { kind: "visual_unavailable", reason: "model_has_no_image_input" },
      { kind: "visual_unavailable", reason: "no_renderer" },
      { kind: "pages_unviewed", viewed: 2, total: 3 },
    ];
    const read = limits.map((l) => {
      switch (l.kind) {
        case "pdf_unavailable":
        case "visual_unavailable":
          return `${l.kind}/${l.reason}`;
        case "pages_unviewed":
          return `${l.kind}/${l.viewed}of${l.total}`;
        default:
          return "other";
      }
    });
    expect(read).toEqual([
      "pdf_unavailable/none",
      "pdf_unavailable/stale",
      "pdf_unavailable/compile_failed",
      "pdf_unavailable/render_failed",
      "visual_unavailable/model_has_no_image_input",
      "visual_unavailable/no_renderer",
      "pages_unviewed/2of3",
    ]);
    // Panel-wide: none of the three names a reviewer.
    for (const l of limits) expect("reviewer" in l).toBe(false);
  });

  it("a page nobody viewed is a sixth drop reason, with no file", () => {
    const limit: ReviewLimit = {
      kind: "anchors_dropped",
      reviewer: "pdf_reviewer",
      anchors: [
        { anchor: "page 7", role: "evidence", reason: "page_not_viewed" },
      ],
    };
    expect(limit.anchors[0]?.reason).toBe("page_not_viewed");
    expect(limit.anchors[0]?.file).toBeUndefined();
  });

  it("the facts record, the PDF record, the venue summary and the item's siblings compile", () => {
    const venue: ReviewVenue = {
      id: "acm-sigconf",
      pageLimit: { value: 9, unit: "pages", note: "excl. references" },
      anonymity: "double_blind",
    };
    const facts: PdfFacts = {
      pages: 12,
      pageSize: { width: 612, height: 792, name: "letter" },
      referencesStart: 10,
      mainTextPages: 9,
      author: "A. Fixture",
      overfull: { hboxes: 3, vboxes: 1 },
      smallestText: [{ page: 1, sizePt: 5 }],
      venue,
    };
    const pdf: ReviewPdfRecord = {
      source: "output_dir",
      path: "out/main.pdf",
      facts,
      viewed: [1, 2, 3],
    };
    const item: ReviewItem = {
      id: "r1",
      type: "review",
      status: "completed",
      skill: "pdf-reviewer",
      seats: [],
      pdfSeat: { reviewer: "pdf_reviewer", status: "completed", model: "m" },
      pdf,
      pdfOnly: true,
      verification: "skipped",
    };
    expect(item.pdf?.facts.pageSize.name).toBe("letter");
    expect(item.pdfSeat?.reviewer).toBe("pdf_reviewer");
    // Only the points are required; a size that is neither A4 nor Letter
    // names nothing.
    const bare: PdfFacts = { pages: 1, pageSize: { width: 500, height: 700 } };
    expect(Object.keys(bare).sort()).toEqual(["pageSize", "pages"]);
  });

  it("the driver's PDF deps: a renderer, and optionally a compile, a log reader and a venue", () => {
    const compileLog: CompileLogReader = (log, entryFile) =>
      log.includes("Overfull")
        ? [
            {
              id: "w1",
              source: "latexmk",
              severity: "warning",
              code: "overfull-hbox",
              message: log,
              file: entryFile,
            },
          ]
        : [];
    const deps: ReviewPdfDeps = {
      renderer: async () => undefined,
      compileLog,
    };
    expect(deps.compile).toBeUndefined();
    expect(compileLog("Overfull hbox", "main.tex")[0]?.file).toBe("main.tex");
  });
});

/**
 * V5 (ADR 0087): the scorecard's contracts — a second ledger entry kind, a
 * per-seat per-dimension assessment, one persisted seat fact, one limit kind,
 * and the derived types, which are never persisted.
 */
describe("the scorecard's contracts (V5, ADR 0087)", () => {
  it("ReviewLimit has exactly seventeen kinds, the seventeenth strengths_lost", () => {
    // Exhaustive by construction: a new kind without an arm is TS2366 here,
    // and a removed one is a type error on its literal.
    const every = (l: ReviewLimit): true => {
      switch (l.kind) {
        case "anchors_dropped":
        case "entries_rejected":
        case "seat_missing":
        case "seat_unguided":
        case "source_unavailable":
        case "search_budget_spent":
        case "synthesis_missing":
        case "verification_missing":
        case "own_title_unguarded":
        case "pdf_unavailable":
        case "visual_unavailable":
        case "pages_unviewed":
        case "concerns_set_aside":
        case "pages_corrected":
        case "furniture_set_aside":
        case "pages_unchecked":
        case "strengths_lost":
          return true;
      }
    };
    const lost: ReviewLimit = {
      kind: "strengths_lost",
      reviewer: "reviewer_b",
      dropped: [
        {
          anchor: "a passage",
          file: "main.tex",
          role: "claim",
          reason: "not_found",
        },
        { anchor: "page 9", role: "evidence", reason: "page_not_viewed" },
      ],
      rejected: [{ index: 2, reason: "a reason" }],
    };
    expect(every(lost)).toBe(true);
    expect(lost.kind === "strengths_lost" && lost.dropped.length).toBe(2);
  });

  it("a strength is located like a concern and carries no severity, blocking or suggestion", () => {
    const strength: ReviewStrength = {
      id: "reviewer_a-s1",
      reviewer: "reviewer_a",
      dimension: "originality",
      span: { file: "main.tex", line: 12, endLine: 13 },
      message: "Goes beyond the closest work.",
      evidence: {
        kind: "paper",
        title: "Closest Work",
        authors: ["A. Author"],
        source: "arxiv",
      },
    };
    expect(Object.keys(strength).sort()).toEqual([
      "dimension",
      "evidence",
      "id",
      "message",
      "reviewer",
      "span",
    ]);
    // A strength's evidence is never "missing": the field is left out instead.
    const { evidence: _e, ...bare } = strength;
    const plain: ReviewStrength = { ...bare, id: "reviewer_a-s2" };
    expect("evidence" in plain).toBe(false);
  });

  it("an assessment is an impression (1–10 or null) and an optional declaration", () => {
    const rows: ReviewAssessment[] = [
      { reviewer: "reviewer_a", dimension: "soundness", impression: 4 },
      {
        reviewer: "reviewer_a",
        dimension: "positioning",
        impression: null,
        notAssessed: "no literature source answered",
      },
    ];
    const result: ReviewResult = {
      annotations: [],
      strengths: [],
      assessments: rows,
    };
    expect(result.assessments?.map((a) => a.impression)).toEqual([4, null]);
  });

  it("LedgerCounts counts strengths apart, and the concern identity is unchanged", () => {
    const counts: LedgerCounts = {
      entries: 3,
      located: 2,
      relocated: 0,
      dropped: 1,
      rejected: 0,
      strengths: {
        entries: 3,
        located: 1,
        relocated: 1,
        dropped: 1,
        rejected: 1,
      },
    };
    expect(
      counts.located +
        counts.dropped +
        counts.rejected +
        (counts.setAside ?? 0),
    ).toBe(counts.entries);
    const s = counts.strengths;
    expect(s && s.located + s.dropped + s.rejected).toBe(s?.entries);
  });

  it("a seat records what its searches came to, as an optional fact", () => {
    const row: ReviewSeatState = {
      reviewer: "reviewer_a",
      status: "completed",
      model: "m",
      searches: { attempted: 3, answered: 2 },
    };
    const old: ReviewSeatState = {
      reviewer: "reviewer_b",
      status: "completed",
      model: "m",
    };
    expect(row.searches?.answered).toBe(2);
    expect(old.searches).toBeUndefined();
  });

  it("the derived types are closed: a standing, a readiness word, a delta", () => {
    const standings: ScorecardStanding[] = [
      { kind: "level", level: 1, checked: true },
      { kind: "nothing_raised" },
      { kind: "not_assessed", reason: { kind: "no_literature" } },
      { kind: "not_assessed", reason: { kind: "literature_budget" } },
      { kind: "not_assessed", reason: { kind: "no_pdf" } },
      { kind: "not_assessed", reason: { kind: "no_reviewer" } },
      {
        kind: "not_assessed",
        reason: {
          kind: "declared",
          by: [{ reviewer: "reviewer_a", note: "n" }],
        },
      },
    ];
    expect(standings.map((s) => s.kind)).toEqual([
      "level",
      "nothing_raised",
      "not_assessed",
      "not_assessed",
      "not_assessed",
      "not_assessed",
      "not_assessed",
    ]);
    const labels: Readiness[] = [
      "blocking",
      "major",
      "minor",
      "none",
      "not_assessed",
    ];
    const card: Scorecard = {
      readiness: { label: "none", checked: false },
      notAssessed: 0,
      dimensions: [],
      panel: {
        reviewers: [{ reviewer: "reviewer_a", model: "m" }],
        verificationOn: true,
      },
    };
    const delta: ScorecardDelta = {
      dimensions: [
        { dimension: "presentation", comparable: false, reason: "pdf" },
        {
          dimension: "soundness",
          comparable: true,
          from: { kind: "level", level: 2, checked: true },
          to: { kind: "level", level: 3, checked: true },
          change: "improved",
        },
      ],
    };
    expect(labels).toHaveLength(5);
    expect(Object.keys(card).sort()).toEqual([
      "dimensions",
      "notAssessed",
      "panel",
      "readiness",
    ]);
    expect(delta.dimensions).toHaveLength(2);
  });
});
