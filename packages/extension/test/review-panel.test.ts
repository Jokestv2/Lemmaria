/**
 * R3 (O27, O28): `/review` end to end in the EXTENSION HOST.
 *
 * The harness suite proves the driver; this proves the seams only a host has —
 * the manuscript port a `/review` is given, the Review tab a completed panel
 * pushes, the file each annotation opens, the diff an adopted suggestion
 * enters, the spend the panel is charged, and the re-present after a reload.
 *
 * The model is keyed by REVIEWER (the first user message of each child),
 * because the reviewers run in parallel: a shared sequential cursor would be
 * nondeterministic. Same reason, same shape as `session.test.ts`'s KeyedModel.
 *
 * R9 (ADR 0069): the panel is N ordinal reviewers, each on a model the user
 * picks, so the keys are `reviewer_a`… rather than the three lens names, and
 * the charge below is per reviewer rather than per panel.
 */
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
  ReviewResult,
  ReviewSeatState,
  SessionEvent,
  StoredReview,
} from "@lemmaria/harness";
import {
  REVIEWER_NAMES,
  ReviewStore,
  VERIFIER_BRIEF_MARKER,
  deriveScorecard,
  scorecardDelta,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import type { ResolvedReviewPanel } from "../src/model";
import {
  DEFAULT_REVIEW_ROLES,
  type ReviewRolesStore,
} from "../src/review-roles-store";
// X6: a module instance of this suite's own — see the last suite below.
import {
  clearReviews as clearReviewsHere,
  initReviews as initReviewsHere,
  persistableReviewsForTests as persistableHere,
  presentPanelReview as presentHere,
  selectReview as selectHere,
  computeReviewTabState as tabStateHere,
} from "../src/review-ui";
import { reviewStoreDir } from "../src/session/session-state";
import type { ReviewTabState, WebviewToHost } from "../src/webview-protocol";

interface PanelApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  sessionEventsForTests(): SessionEvent[];
  resetSessionForTests(): void;
  resetCostForTests(): void;
  /** The cost status-bar item's text (the X6 review round). */
  costStatusForTests(): string | undefined;
  sessionUsageForTests(): Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
  }>;
  lastReviewTabStateForTests(): ReviewTabState | undefined;
  /** X5 (ADR 0074 §8): exactly what the review store would be handed. */
  persistableReviewsForTests(): StoredReview[];
  simulateWindowReloadForTests(): Promise<boolean>;
  // R9 (ADR 0069 §D8).
  setReviewPanelForTests(panel: ResolvedReviewPanel | undefined): void;
  reviewRolesStoreForTests(): ReviewRolesStore | undefined;
  modelStoreForTests(): import("../src/model-store").ModelStore | undefined;
  clearModelsForTests(): Promise<void>;
}

const MAIN = [
  // V2 (ADR 0078 §5): the `\title` shares line 1 with `\documentclass`. A real
  // manuscript has one and the withholding guard needs it, but lines 1-6 keep
  // the numbers the assertions below name — the same discipline line 7's own
  // comment records.
  "\\documentclass{article}\\title{A Two-Stage Least Squares Study}", // 1
  "\\begin{document}", // 2
  "We estimate the effect with a two-stage least squares design.", // 3
  "The instrument is the distance to the nearest treated unit.", // 4
  "Table 2 reports a gain of nine points over the strongest baseline.", // 5
  "We conclude that the method generalises to every domain we tried.", // 6
  // X5 (ADR 0074 §4): the manuscript is the entry's INCLUDE GRAPH, so the
  // second file has to be included for a seat to be able to cite it — which
  // is what this two-file fixture always meant. Placed here rather than
  // higher so lines 1–6 keep the numbers the assertions below name.
  "\\input{sections/method}", // 7
  "\\end{document}", // 8
  "",
].join("\n");

const METHOD = ["The estimator is defined in Appendix A only.", ""].join("\n");

const INSTRUMENT =
  "The instrument is the distance to the nearest treated unit.";
const DESIGN = "We estimate the effect with a two-stage least squares design.";
const TABLE2 =
  "Table 2 reports a gain of nine points over the strongest baseline.";
const ESTIMATOR = "The estimator is defined in Appendix A only.";

/** One ledger per reviewer; `reviewer_b` deliberately annotates the OTHER
 *  file. Under one lens each reviewer reads every angle, so which dimension a
 *  ledger uses is the reviewer's own choice, not its brief's. */
const SEAT_ANSWER: Record<string, string> = {
  reviewer_a: JSON.stringify({
    impressions: {},
    annotations: [
      {
        dimension: "soundness",
        severity: "major",
        anchor: INSTRUMENT,
        evidence: { anchor: DESIGN },
        blocking: true,
        message: "the exclusion restriction is never argued",
        suggestion:
          "The instrument is the distance to the nearest control unit.",
      },
    ],
  }),
  reviewer_b: JSON.stringify({
    impressions: {},
    annotations: [
      {
        dimension: "claims",
        severity: "major",
        anchor: ESTIMATOR,
        file: "sections/method.tex",
        evidence: "missing",
        message: "the estimator is asserted, never defined in the paper",
      },
    ],
  }),
  reviewer_c: JSON.stringify({
    impressions: {},
    annotations: [
      {
        dimension: "positioning",
        severity: "minor",
        anchor: TABLE2,
        evidence: "missing",
        message: "the strongest baseline is not named",
      },
    ],
  }),
  synthesis: JSON.stringify({
    consensus: [
      {
        ids: ["reviewer_a-1", "reviewer_b-1"],
        note: "both read the central design as under-specified",
      },
    ],
    disagreements: [],
  }),
};

/** Keyed on the FIRST user message: a reviewer's goal is stable across its
 *  turns, while the last one becomes shape feedback the moment a retry fires.
 *  The opener is the brief's own *"`reviewer_a`, one of N"*. */
function seatOf(req: GenerateRequest): string {
  const first = req.messages.find((m) => m.role === "user");
  const text = typeof first?.content === "string" ? first.content : "";
  for (const name of REVIEWER_NAMES)
    if (text.includes(`\`${name}\`, one of `)) return name;
  // V1 (ADR 0076 §5): the verifier, keyed by its brief's marker sentence.
  if (text.includes(VERIFIER_BRIEF_MARKER)) return "verifier";
  return text.includes("reviewers have each read") ? "synthesis" : "";
}

/**
 * V1: the verifier's default answer — UPHOLD every id its brief hands it,
 * built from the request because the ids come from the run. With it, every
 * assertion below stands as it was; what V1 changes is a count of calls.
 */
function upholdEvery(req: GenerateRequest): string {
  const first = req.messages.find((m) => m.role === "user");
  const brief = typeof first?.content === "string" ? first.content : "";
  const line = brief.split("\n").find((l) => l.startsWith('{"concerns":'));
  const ids = line
    ? (JSON.parse(line) as { concerns: Array<{ id: string }> }).concerns.map(
        (c) => c.id,
      )
    : [];
  return JSON.stringify({
    verifications: ids.map((id) => ({
      id,
      kind: "absence",
      outcome: "upheld",
    })),
  });
}

class SeatModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly seats: string[] = [];
  /** `gate` is held open before answering, so a test can observe a task IN
   *  FLIGHT (ADR 0064 §3's refusal needs one); `answers` lets one test script
   *  a reviewer differently without a second class. Defaults: answer at once,
   *  from the shared ledgers. */
  constructor(
    private readonly gate: () => Promise<void> = async () => {},
    private readonly answers: Record<string, string> = SEAT_ANSWER,
  ) {}
  private result(req: GenerateRequest): GenerateResult {
    const seat = seatOf(req);
    this.seats.push(seat);
    return {
      text:
        this.answers[seat] ??
        (seat === "verifier" ? upholdEvery(req) : "unscripted"),
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    await this.gate();
    return this.result(req);
  }
  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    await this.gate();
    yield { type: "completed", result: this.result(req) };
  }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** How many reviews the tab holds — the handle every wait below uses, since
 *  a detached panel lands asynchronously rather than at the dispatch's await
 *  (ADR 0065 §2). */
const reviewsHeld = (api: PanelApi): number =>
  api.lastReviewTabStateForTests()?.history?.length ?? 0;

/** Start a panel and wait for it to reach the Review tab. */
async function runPanel(api: PanelApi, msg: WebviewToHost): Promise<void> {
  const before = reviewsHeld(api);
  await api.dispatchWebviewMessageForTests(msg);
  await waitFor(() => reviewsHeld(api) > before, "the detached panel to land");
}

/** Every item kind that reached the SESSION's event stream. The detached
 *  panel must appear in none of them (ADR 0065 §2). */
const sessionItemKinds = (api: PanelApi): string[] =>
  api
    .sessionEventsForTests()
    .flatMap((e) => ("item" in e ? [(e.item as { type: string }).type] : []));

async function getApi(): Promise<PanelApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as PanelApi;
}

/** A throwaway manuscript of two files, with `main.tex` focused. */
async function openManuscript(): Promise<{ dir: string; main: vscode.Uri }> {
  const dir = path.join(
    os.tmpdir(),
    `lemmaria-r3-panel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const main = vscode.Uri.file(path.join(dir, "main.tex"));
  const method = vscode.Uri.file(path.join(dir, "sections", "method.tex"));
  await vscode.workspace.fs.writeFile(main, Buffer.from(MAIN, "utf8"));
  await vscode.workspace.fs.writeFile(method, Buffer.from(METHOD, "utf8"));
  const doc = await vscode.workspace.openTextDocument(main);
  await vscode.window.showTextDocument(doc);
  return { dir, main };
}

suite("R3: /review in the extension host", function () {
  this.timeout(60000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("a /review send drives the panel, fills the tab, and is charged", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.resetCostForTests();
    const model = new SeatModel();
    api.setModelForTests(model, {
      protocol: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      apiKey: "k",
    });
    // V4 (ADR 0081): this case is about the panel, and asserts it carries no
    // limit — so the PDF reviewer, which would otherwise read the fixture's
    // PDF on this seeing model, is turned off. Its own run is review-pdf.test.ts.
    await api
      .reviewRolesStoreForTests()
      ?.set({ ...DEFAULT_REVIEW_ROLES, pdfReviewer: "off" });
    try {
      await openManuscript();
      // ADR 0065 §4: a typed `/review` is intercepted before any session
      // exists, so the send returns at once and the panel runs detached.
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "/review",
      })) as { status: string };
      assert.strictEqual(outcome.status, "review");
      await waitFor(() => reviewsHeld(api) > 0, "the detached panel to land");
      // §2: and NOTHING about it is in the conversation. This is the whole
      // milestone in one assertion — before ADR 0065 the transcript carried a
      // `user_message` and a `review` item, which is what made the history the
      // session's and let `New Session` empty it.
      const kinds = sessionItemKinds(api);
      assert.ok(
        !kinds.includes("review"),
        "a review item reached the conversation",
      );
      assert.ok(
        !kinds.includes("user_message"),
        "the /review text was recorded as a message to the assistant",
      );
      assert.deepStrictEqual(
        // X5 (ADR 0074 §6): the pre-run check is answered by the same adapter
        // but is NOT a seat — it carries no brief, so `seatOf` keys it "".
        // Dropped here rather than counted, the way the panel-mode assertion
        // below already does.
        [...model.seats]
          .filter((x) => x !== "")
          .sort(),
        // V1 (ADR 0076): and the verifier, which runs between the reviewers
        // and the cross-review on every default panel.
        ["reviewer_a", "reviewer_b", "reviewer_c", "synthesis", "verifier"],
        "three reviewers, the verifier and the cross-review, each keyed by its own brief",
      );

      const tab = api.lastReviewTabStateForTests();
      assert.ok(tab, "no review tab state pushed");
      assert.strictEqual(tab.available, true);
      assert.strictEqual(tab.mode, "panel");
      assert.strictEqual(tab.file, "main.tex");
      assert.deepStrictEqual(
        tab.annotations.map((a) => a.id),
        ["reviewer_a-1", "reviewer_b-1", "reviewer_c-1"],
      );
      // O15: the rows come from the ITEM's own seats now, and each carries
      // the model it ran on — here the Writing model, because every role is
      // "same as Writing" until the user says otherwise.
      assert.deepStrictEqual(
        tab.seats?.map((s) => `${s.reviewer}:${s.model}:${s.count}`),
        REVIEWER_NAMES.slice(0, 3).map((n) => `${n}:claude-sonnet-4-5:1`),
      );
      assert.strictEqual(tab.synthesis?.consensus.length, 1);
      // The panel located everything, so there is no honesty record at all.
      assert.strictEqual(tab.limits, undefined);
      // The fields R3 added, on the annotations that carry them.
      assert.strictEqual(tab.annotations[0]?.blocking, true);
      // X6 (ADR 0075 §6): the evidence carries its FILE — the host held it
      // all along and dropped it one line before the wire, which is how the
      // tab came to print `L3` for a line of a different file.
      assert.deepStrictEqual(tab.annotations[0]?.evidence, {
        kind: "span",
        file: "main.tex",
        line: 3,
      });
      assert.deepStrictEqual(tab.annotations[1]?.evidence, {
        kind: "missing",
      });
      assert.strictEqual(tab.annotations[1]?.file, "sections/method.tex");
      assert.strictEqual(tab.annotations[1]?.line, 1);

      // A5 (ADR 0061 §9): the panel's four children never reach a turn event,
      // so the item's usage is what the session is charged. FIVE requests, not
      // four: X5 (ADR 0074 §6) asks the pre-run check first, and every seat
      // here shares the session's one binding, so it is asked exactly once.
      // V1 (ADR 0076 §7): SIX — the verifier's one request, charged to the
      // model it ran on like every other child.
      const usage = api.sessionUsageForTests();
      assert.deepStrictEqual(usage, [
        { model: "claude-sonnet-4-5", inputTokens: 6, outputTokens: 6 },
      ]);
    } finally {
      api.clearModelForTests();
      await api.reviewRolesStoreForTests()?.set(DEFAULT_REVIEW_ROLES);
    }
  });

  test("reveal opens the annotation's OWN file; adopt enters the diff flow", async () => {
    const api = await getApi();
    const tab = api.lastReviewTabStateForTests();
    assert.ok(tab, "the previous test's review is the fixture");

    // `reviewer_b-1` is in sections/method.tex — never focused by the user.
    const claims = tab.annotations.findIndex((a) => a.id === "reviewer_b-1");
    assert.ok(claims >= 0);
    await vscode.commands.executeCommand("lemmaria.revealAnnotation", claims);
    const opened = vscode.window.activeTextEditor?.document.uri.fsPath ?? "";
    assert.ok(
      opened.replace(/\\/g, "/").endsWith("sections/method.tex"),
      `reveal opened ${opened}`,
    );

    // `reviewer_a-1` carries the only suggestion, and it is in the entry.
    const sound = tab.annotations.findIndex((a) => a.id === "reviewer_a-1");
    assert.strictEqual(tab.annotations[sound]?.hasSuggestion, true);
    const adopted = (await vscode.commands.executeCommand(
      "lemmaria.adoptSuggestion",
      sound,
    )) as { status: string; message?: string };
    assert.strictEqual(adopted.status, "proposed", adopted.message);
  });

  test("a window reload leaves the tab alone — nothing re-presents it", async () => {
    // ADR 0065 §1 replaces R3's `represent`. A resume used to CLEAR the tab and
    // put the resumed session's own `review` items back into it, because the
    // reviews were the session's. Both halves are gone: the reviews are the
    // workspace's, a session carries none, and a resume that cleared them would
    // reintroduce the reported defect by another door.
    const api = await getApi();
    const before = api.lastReviewTabStateForTests();
    assert.ok(before, "no review on the tab");

    // Triage one concern first. This is what makes the assertion sharp: under
    // R3 a re-present reset every row to pending, so a surviving `ignored` is
    // proof that nothing re-presented.
    const positioning = before.annotations.findIndex(
      (a) => a.id === "reviewer_c-1",
    );
    assert.ok(positioning >= 0);
    await api.dispatchWebviewMessageForTests({
      type: "ignoreAnnotation",
      index: positioning,
    });

    const restored = await api.simulateWindowReloadForTests();
    // FALSE, and that is the milestone rather than a shortcoming: the only
    // thing that has run since `resetSessionForTests` is a `/review`, and a
    // review creates no session to come back to (ADR 0065 §2/§4). Under R3
    // this same reload restored a conversation whose whole content was the
    // panel — which is exactly how the review came to be owned by a chat.
    assert.strictEqual(
      restored,
      false,
      "a detached review created a conversation",
    );

    const after = api.lastReviewTabStateForTests();
    assert.ok(after, "the reload emptied the Review tab");
    assert.strictEqual(after.mode, "panel");
    assert.deepStrictEqual(
      after.annotations.map((a) => a.id),
      ["reviewer_a-1", "reviewer_b-1", "reviewer_c-1"],
    );
    assert.strictEqual(
      after.annotations[positioning]?.status,
      "ignored",
      "the resume re-presented the review and reset its triage",
    );
  });

  test("a second /review is v2, and the tab can go back to v1", async () => {
    // ADR 0062 §1. The tab used to show exactly one review — the last to
    // complete — so re-reviewing made the first one unreachable while its
    // concerns were still open in the manuscript.
    const api = await getApi();
    api.resetSessionForTests();
    const model = new SeatModel();
    api.setModelForTests(model, {
      protocol: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      apiKey: "k",
    });
    try {
      await openManuscript();
      for (const _ of [0, 1]) {
        // Detached and asynchronous now (ADR 0065 §2), so each panel is waited
        // for rather than awaited at the dispatch.
        await runPanel(api, { type: "composerSend", text: "/review" });
      }
      const tab = api.lastReviewTabStateForTests();
      assert.ok(tab);
      assert.deepStrictEqual(
        tab.history?.map((h) => `${h.mode}:${h.version}`),
        ["panel:1", "panel:2"],
        "both reviews are in the picker, in order, each with its version",
      );
      assert.strictEqual(tab.selected, 1, "the newest is what is shown");

      // Going back is state, not a re-run: no model call, same annotations.
      const seatsBefore = model.seats.length;
      await api.dispatchWebviewMessageForTests({ type: "selectReview", id: 0 });
      const back = api.lastReviewTabStateForTests();
      assert.strictEqual(back?.selected, 0);
      assert.strictEqual(back?.history?.length, 2);
      assert.strictEqual(
        model.seats.length,
        seatsBefore,
        "switching review re-ran a reviewer",
      );
      // An out-of-range id is ignored rather than blanking the tab.
      await api.dispatchWebviewMessageForTests({ type: "selectReview", id: 9 });
      assert.strictEqual(api.lastReviewTabStateForTests()?.selected, 0);
    } finally {
      api.clearModelForTests();
    }
  });

  test("resolve HANDS the concern to the assistant; ignore is still triage", async () => {
    // ADR 0063 §3, replacing ADR 0062 §5's pure triage. The fixture is the
    // review the previous test left selected.
    const api = await getApi();
    const before = api.lastReviewTabStateForTests();
    assert.ok(before, "no review to triage");
    const sound = before.annotations.findIndex((a) => a.id === "reviewer_a-1");
    const claims = before.annotations.findIndex((a) => a.id === "reviewer_b-1");
    assert.ok(sound >= 0 && claims >= 0);

    const model = new SeatModel();
    api.setModelForTests(model, {
      protocol: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      apiKey: "k",
    });
    let outcome: { status: string; items?: { type: string }[] } | undefined;
    try {
      outcome = (await api.dispatchWebviewMessageForTests({
        type: "resolveAnnotation",
        index: sound,
        prompt: "Resolve this reviewer concern in the manuscript.",
      })) as { status: string; items?: { type: string }[] };
    } finally {
      api.clearModelForTests();
    }
    // The prompt went down the SAME path a typed message takes — a real task
    // ran, and the user's message is in the transcript. That is the whole
    // difference from ADR 0062's Resolve, which did nothing but set a word.
    assert.strictEqual(outcome?.status, "completed", "no task ran");
    assert.ok(
      api
        .sessionEventsForTests()
        .some(
          (e) =>
            JSON.stringify(e).includes("Resolve this reviewer concern") ===
            true,
        ),
      "the prompt never reached the session",
    );

    await api.dispatchWebviewMessageForTests({
      type: "ignoreAnnotation",
      index: claims,
    });
    const after = api.lastReviewTabStateForTests();
    // `handed`, not `resolved`: at the click the work was started, not
    // finished, and the archive must not claim a verification nobody made.
    assert.strictEqual(after?.annotations[sound]?.status, "handed");
    assert.strictEqual(
      after?.annotations[claims]?.status,
      "ignored",
      "handing over and ignoring are two different claims and stay apart",
    );

    // A blank prompt is refused outright rather than starting an empty task.
    const blank = await api.dispatchWebviewMessageForTests({
      type: "resolveAnnotation",
      index: claims,
      prompt: "   ",
    });
    assert.strictEqual(blank, undefined);
    assert.strictEqual(
      api.lastReviewTabStateForTests()?.annotations[claims]?.status,
      "ignored",
      "a refused hand-off still moved the row",
    );
    // Read-only, as every review is (invariant 3): the entry is untouched.
    const uri = vscode.Uri.file(
      vscode.window.activeTextEditor?.document.uri.fsPath ?? "",
    );
    if (uri.fsPath.endsWith("main.tex")) {
      const text = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8");
      assert.strictEqual(text, MAIN, "triage wrote to the manuscript");
    }
  });
  test("the entry root follows the paper, and a new session KEEPS the tab", async () => {
    // ADR 0062 §2, second round. `paper-entry.ts` rooted its discovery at
    // `workspaceFolders[0]`, which is wrong in a MULTI-ROOT workspace: with
    // `notes/` first and the paper in `thesis/`, the panel would be briefed on
    // the wrong project's document. It now roots at `sessionEditRoot()` — the
    // same helper, for the same recorded reason, as registry.ts's round-2
    // review C1, which found folder[0] making the write root diverge from the
    // read root.
    //
    // This suite opens NO workspace folder, so it cannot construct the
    // multi-root case; what it CAN pin is that the new discovery path leaves
    // the folder-less answer alone, which is the risk the change carried. A
    // focused paper in a window with no folder is still its own root.
    const api = await getApi();
    api.resetSessionForTests();
    const model = new SeatModel();
    api.setModelForTests(model, {
      protocol: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      apiKey: "k",
    });
    try {
      const { dir } = await openManuscript();
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(dir, "sections", "method.tex")),
      );
      await vscode.window.showTextDocument(doc);
      await runPanel(api, { type: "composerSend", text: "/review" });
      // `method.tex`, not `sections/method.tex`: with no workspace folder,
      // `paperOf()` roots a paper at its OWN directory, so the entry is the
      // basename and the panel reads that one file. That is the single-file
      // window's pre-existing degradation, and pinning it is the point — both
      // routes (the old `paperInContext()` fallback and the new discovery
      // under `entryRoot()`, which finds no `\documentclass` in `sections/`
      // and falls through to it) must land on exactly this.
      assert.strictEqual(
        api.lastReviewTabStateForTests()?.entry,
        "method.tex",
        "the folder-less window's own answer changed",
      );
    } finally {
      api.clearModelForTests();
    }

    // ADR 0065 §1, and this is the operator's report inverted into a test.
    // `Lemmaria: New Session` used to call `clearReviews()` — the picker
    // emptied and the next panel started again at v1, for reviews of a
    // manuscript the new conversation had not touched. A review is the
    // WORKSPACE's, so a conversation boundary must not reach it.
    const before = api.lastReviewTabStateForTests();
    assert.strictEqual(before?.available, true);
    const versions = before?.history?.map((h) => h.version);
    await vscode.commands.executeCommand("lemmaria.newSession");
    const after = api.lastReviewTabStateForTests();
    assert.strictEqual(
      after?.available,
      true,
      "a new session cleared the workspace's review history",
    );
    assert.deepStrictEqual(
      after?.history?.map((h) => h.version),
      versions,
      "a new session renumbered or dropped the workspace's reviews",
    );
  });

  test("the launcher runs a panel BESIDE a live chat task, and never steers it", async () => {
    // ADR 0065 §2/§3, superseding ADR 0064 §3. A panel used to be a chat task,
    // so starting one while a task ran would have become STEERING for it —
    // feeding the running task the literal string `/review` as the user's own
    // words. ADR 0064 answered that by refusing the click. ADR 0065 removes the
    // reason instead: a review is not a message, so it runs beside the
    // conversation and neither one waits for the other.
    const api = await getApi();
    api.resetSessionForTests();
    let release: (() => void) | undefined;
    let held = true;
    // Only the FIRST call is held, so the panel that runs alongside is not.
    const gate = () => {
      if (!held) return Promise.resolve();
      held = false;
      return new Promise<void>((r) => {
        release = r;
      });
    };
    const model = new SeatModel(gate);
    api.setModelForTests(model, {
      protocol: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      apiKey: "k",
    });
    try {
      await openManuscript();
      // A prose task, held open — so a chat task is genuinely in flight.
      const running = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "what do you make of section 2?",
      });
      await waitFor(() => release !== undefined, "the first turn to open");

      // The decisive assertion: the panel starts anyway, and completes while
      // the chat turn is still blocked.
      const started = (await api.dispatchWebviewMessageForTests({
        type: "runReviewPanel",
      })) as { status: string };
      assert.strictEqual(started.status, "started", "the launcher refused");
      await waitFor(
        () => reviewsHeld(api) > 0,
        "the panel to land beside the task",
      );

      const tab = api.lastReviewTabStateForTests();
      assert.strictEqual(tab?.available, true);
      assert.strictEqual(tab?.mode, "panel");
      assert.deepStrictEqual(
        [...new Set(model.seats)].filter((x) => x !== "").sort(),
        // V1 (ADR 0076): and the verifier.
        ["reviewer_a", "reviewer_b", "reviewer_c", "synthesis", "verifier"],
      );

      release?.();
      await running;

      // And the held task never saw the panel: no `/review` was steered into
      // it, and its transcript carries no review item.
      const kinds = sessionItemKinds(api);
      assert.ok(!kinds.includes("review"), "a review item joined the chat");
      assert.ok(
        !api
          .sessionEventsForTests()
          .some((e) => JSON.stringify(e).includes('"text":"/review"')),
        "the panel was steered into the running task as prose",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("only one panel at a time, and the tab can stop the one that runs", async () => {
    // ADR 0065 §3. Two panels would spend twice and race for the version
    // number, so the refusal that remains is a REVIEW's, not a task's.
    const api = await getApi();
    api.resetSessionForTests();
    let release: (() => void) | undefined;
    let held = true;
    const gate = () => {
      if (!held) return Promise.resolve();
      held = false;
      return new Promise<void>((r) => {
        release = r;
      });
    };
    const model = new SeatModel(gate);
    api.setModelForTests(model, {
      protocol: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      apiKey: "k",
    });
    try {
      await openManuscript();
      await api.dispatchWebviewMessageForTests({ type: "runReviewPanel" });
      await waitFor(() => release !== undefined, "the first reviewer to open");
      const second = (await api.dispatchWebviewMessageForTests({
        type: "runReviewPanel",
      })) as { status: string };
      assert.strictEqual(second.status, "busy", "a second panel started");

      // Stop is the TAB's, and it reaches the panel rather than the chat.
      await api.dispatchWebviewMessageForTests({ type: "stopReview" });
      release?.();
      // A stopped panel still reports what its reviewers located (ADR 0061 §8),
      // so the run ends either in the tab or as a run that produced nothing —
      // never hanging, which is what a Stop that reached the wrong thing would
      // look like.
      await waitFor(
        () => reviewsHeld(api) > 0 || model.seats.length > 0,
        "the stopped panel to settle",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("the tab carries the entry the NEXT panel will read", async () => {
    // ADR 0064 §1: `nextEntry` is a second field, shipped in BOTH `available`
    // states, because the launcher renders before any review has run. Opening
    // the tab re-resolves it — which is what a reader who has just changed the
    // setting, or just focused another project, is about to look at.
    const api = await getApi();
    api.resetSessionForTests();
    await openManuscript();
    await api.dispatchWebviewMessageForTests({ type: "requestReview" });
    await waitFor(
      () => api.lastReviewTabStateForTests()?.nextEntry === "main.tex",
      "the launcher's entry to resolve",
    );
    const tab = api.lastReviewTabStateForTests();
    // No review has run in this session, so the tab is unavailable — and the
    // launcher still knows what to aim at. That is the whole change.
    assert.strictEqual(tab?.available, false);
    assert.strictEqual(tab?.nextEntry, "main.tex");
    assert.strictEqual(tab?.entry, "", "an unavailable tab named a review");
  });
});

/**
 * R9 (ADR 0069): what the host owes a panel whose reviewers are not all the
 * same model — the row for a reviewer that found nothing, the spend attributed
 * to the model that actually spent it, and the refusal before any of it when a
 * configured reviewer cannot be bound.
 */
suite("R9: a panel of N reviewers, each on its own model", function () {
  this.timeout(60000);
  suiteTeardown(async () => {
    const api = await getApi();
    api.setReviewPanelForTests(undefined);
    api.clearModelForTests();
    await api.clearModelsForTests();
    await api.reviewRolesStoreForTests()?.set(DEFAULT_REVIEW_ROLES);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("O15: a reviewer that reported nothing still gets a row", async () => {
    const api = await getApi();
    api.resetCostForTests();
    const model = new SeatModel(undefined, {
      ...SEAT_ANSWER,
      // An empty ledger is a REPORT, not a failure: the stage has no quota,
      // so "I found nothing" is a finding and the tab must say who said it.
      reviewer_c: JSON.stringify({ annotations: [], impressions: {} }),
    });
    api.setModelForTests(model, {
      protocol: "anthropic",
      endpoint: "stub://",
      model: "claude-sonnet-4-5",
      apiKey: "k",
    });
    try {
      await openManuscript();
      await runPanel(api, { type: "runReviewPanel" });
      const tab = api.lastReviewTabStateForTests();
      assert.ok(tab);
      assert.deepStrictEqual(
        tab.seats?.map((s) => `${s.reviewer}:${s.count}`),
        ["reviewer_a:1", "reviewer_b:1", "reviewer_c:0"],
        "the silent reviewer was dropped from the tab instead of reported",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("O16: each reviewer's spend is charged to its OWN model", async () => {
    const api = await getApi();
    api.resetCostForTests();
    const model = new SeatModel();
    api.setModelForTests(model, {
      protocol: "anthropic",
      endpoint: "stub://",
      model: "claude-sonnet-4-5",
      apiKey: "k",
    });
    // The same deterministic adapter under two different bindings: what is
    // under test is the ATTRIBUTION, not the transport.
    const on = (id: string) => ({
      adapter: model as ModelAdapter,
      binding: {
        protocol: "anthropic" as const,
        endpoint: "stub://",
        model: id,
        apiKey: "k",
      },
    });
    api.setReviewPanelForTests({
      reviewers: [
        on("claude-sonnet-4-5"),
        on("gpt-5.6-luna"),
        on("claude-sonnet-4-5"),
      ],
      synthesis: on("gpt-5.6-luna"),
      // V1 (ADR 0076 §8): the resolved panel names its verifier; the
      // cross-review's own model is what the default resolves to.
      verifier: on("gpt-5.6-luna"),
      // V4 (ADR 0081): off — this case counts the reviewers' spend, and a PDF
      // reviewer on the parent's model would be one more charge to it.
      pdfReviewer: "off",
    });
    try {
      await openManuscript();
      await runPanel(api, { type: "runReviewPanel" });
      const rows = [...api.sessionUsageForTests()].sort((a, b) =>
        a.model.localeCompare(b.model),
      );
      // Two reviewers on the Writing model, one reviewer plus the
      // cross-review on the other — priced where the tokens were spent, which
      // is what U3's per-model rows were built to show and what charging the
      // whole item to the session's binding got wrong.
      //
      // Three each, not two: X5's pre-run check (ADR 0074 §6) asks each
      // DISTINCT binding once, and its tokens are charged to the model that
      // was actually asked — the same rule, applied to the one request that
      // happens before any seat exists.
      assert.deepStrictEqual(rows, [
        { model: "claude-sonnet-4-5", inputTokens: 3, outputTokens: 3 },
        // V1 (ADR 0076 §7): 4 — the verifier runs on the cross-review's model
        // by default, and is charged there.
        { model: "gpt-5.6-luna", inputTokens: 4, outputTokens: 4 },
      ]);
      // Nothing is lost or double-counted: the rows sum to the four children
      // plus the two checks, which is what the item's own usage totals. A
      // refused panel is the case that would double-count — it has `seats: []`
      // and real check usage, so the whole-item fallback must not also fire.
      assert.strictEqual(
        rows.reduce((n, r) => n + r.inputTokens, 0),
        // V1: plus the verifier.
        7,
      );
      // And *this run*, in the status bar, is the whole panel: all six
      // requests, 12 tokens on this unpriced stub. It was whichever request
      // was charged last — the pre-run check, `2 tok` here, and `$0.000`
      // after a real $0.08 panel in the review round. The day is labelled
      // in the reader's one language, where it read `today/今日` to everyone.
      // Pinned WHOLE, because the middle figure is today's bucket, which the
      // per-model rows above do not reach: a panel accrued twice would read
      // `12 tok · 24 tok Today`, with this run's prefix still right.
      // V1: seven requests now, the verifier's among them — 14 tokens.
      assert.strictEqual(
        api.costStatusForTests(),
        "$(graph) 14 tok · 14 tok Today",
      );
      // And the tab names each reviewer's model, so a reader can tell whose
      // agreement they are looking at.
      assert.deepStrictEqual(
        api.lastReviewTabStateForTests()?.seats?.map((s) => s.model),
        ["claude-sonnet-4-5", "gpt-5.6-luna", "claude-sonnet-4-5"],
      );
    } finally {
      api.setReviewPanelForTests(undefined);
      api.clearModelForTests();
    }
  });

  test("X5 O13: the SAVED review carries the cross-review's model and cost", async () => {
    // The cross-review has ridden the live item since R9 and was dropped at
    // the store boundary, so a reloaded review could not say which model read
    // across the others, or what that reading cost — the one child whose
    // whole job is reading the panel was the one the record could not price.
    const api = await getApi();
    const model = new SeatModel();
    api.setModelForTests(model, {
      protocol: "anthropic",
      endpoint: "stub://",
      model: "claude-sonnet-4-5",
      apiKey: "k",
    });
    const on = (id: string) => ({
      adapter: model as ModelAdapter,
      binding: {
        protocol: "anthropic" as const,
        endpoint: "stub://",
        model: id,
        apiKey: "k",
      },
    });
    api.setReviewPanelForTests({
      reviewers: [
        on("claude-sonnet-4-5"),
        on("claude-sonnet-4-5"),
        on("claude-sonnet-4-5"),
      ],
      synthesis: on("gpt-5.6-luna"),
      // V1 (ADR 0076 §8): the resolved panel names its verifier; the
      // cross-review's own model is what the default resolves to.
      verifier: on("gpt-5.6-luna"),
    });
    try {
      await openManuscript();
      await runPanel(api, { type: "runReviewPanel" });
      // What `persist()` would hand the store — the mapping where the field
      // was being dropped. The save/load round-trip is the harness store's
      // own test; this suite clears the store handle by design, so there is
      // no file here to read back.
      const last: StoredReview | undefined = api
        .persistableReviewsForTests()
        .at(-1);
      assert.ok(last, "no review reached the store");
      assert.strictEqual(last?.synthesisSeat?.reviewer, "synthesis");
      assert.strictEqual(last?.synthesisSeat?.model, "gpt-5.6-luna");
      assert.strictEqual(last?.synthesisSeat?.status, "completed");
      assert.ok(last?.synthesisSeat?.usage);
      // A SIBLING, not a fourth seat: `seats` is still the three reviewers.
      assert.deepStrictEqual(
        last?.seats?.map((s) => s.reviewer),
        ["reviewer_a", "reviewer_b", "reviewer_c"],
      );
      // The stub prices nothing, so every paid row says its cost is unknown
      // rather than letting the total read as exact.
      assert.strictEqual(last?.synthesisSeat?.unpriced, true);
      assert.ok(last?.seats?.every((s) => s.unpriced === true));
      // X6 O8 (ADR 0075 §5): and the TAB is told which model read across the
      // panel — a different one from the reviewers here, so a projection that
      // borrowed a seat's model would fail.
      const tab = api.lastReviewTabStateForTests();
      assert.strictEqual(tab?.crossReview?.model, "gpt-5.6-luna");
      assert.strictEqual(
        tab?.crossReview?.unverified,
        last?.synthesisSeat?.unverified,
      );
    } finally {
      api.setReviewPanelForTests(undefined);
      api.clearModelForTests();
    }
  });

  test("X5 O19: a panel the pre-run check refuses is charged ONCE", async () => {
    // The double-charge this guards against is specific to X5 (ADR 0074 §6).
    // A refused panel has `seats: []` and REAL check usage, so the old
    // "nothing itemised carried usage" fallback — written when seats were the
    // only itemised part — would charge `item.usage` on top of the check rows
    // and bill the author twice for the one thing the run actually spent.
    const api = await getApi();
    api.resetCostForTests();
    /** Answers for one binding and refuses for the other, so the refused
     *  panel still has a check that spent. */
    class MixedModel implements ModelAdapter {
      readonly protocol = "anthropic" as const;
      async generate(req: GenerateRequest): Promise<GenerateResult> {
        if (req.binding.model === "unfunded-1b") {
          throw Object.assign(
            new Error("Your credit balance is too low to access the API"),
            { status: 400 },
          );
        }
        return {
          text: "ready",
          toolCalls: [],
          stopReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      async *generateStream(
        req: GenerateRequest,
      ): AsyncIterable<ModelStreamEvent> {
        yield { type: "completed", result: await this.generate(req) };
      }
    }
    const model = new MixedModel();
    api.setModelForTests(model, {
      protocol: "anthropic",
      endpoint: "stub://",
      model: "claude-sonnet-4-5",
      apiKey: "k",
    });
    const on = (id: string) => ({
      adapter: model as ModelAdapter,
      binding: {
        protocol: "anthropic" as const,
        endpoint: "stub://",
        model: id,
        apiKey: "k",
      },
    });
    api.setReviewPanelForTests({
      reviewers: [
        on("claude-sonnet-4-5"),
        on("unfunded-1b"),
        on("claude-sonnet-4-5"),
      ],
      synthesis: on("claude-sonnet-4-5"),
      // V1 (ADR 0076 §8): the resolved panel names its verifier; the
      // cross-review's own model is what the default resolves to.
      verifier: on("claude-sonnet-4-5"),
    });
    try {
      await openManuscript();
      const before = reviewsHeld(api);
      await api.dispatchWebviewMessageForTests({ type: "runReviewPanel" });
      // NOT `runPanel`: a refused panel has no `result`, so it never enters
      // the tab's history and that wait would never return. The charge is the
      // handle instead — `chargeReviewItem` runs once, on `item.completed`,
      // so a total read after it is the whole total.
      await waitFor(
        () => api.sessionUsageForTests().length > 0,
        "the refused panel to be charged",
      );
      // Exactly the one check that answered, charged to the model that was
      // asked. Not the refused one (it threw, so it reported no tokens), and
      // not the whole item on top.
      assert.deepStrictEqual(api.sessionUsageForTests(), [
        { model: "claude-sonnet-4-5", inputTokens: 1, outputTokens: 1 },
      ]);
      // And the refusal itself is invisible in the Review tab: a `failed`
      // panel carries no result, so nothing lands in the history. Assumption
      // A17's second branch, observed rather than assumed — the author learns
      // of it from the STOP notice, and the surface is X6's to build.
      assert.strictEqual(reviewsHeld(api), before);
    } finally {
      api.setReviewPanelForTests(undefined);
      api.clearModelForTests();
    }
  });

  test("O12: an unbound reviewer refuses the run and names itself", async () => {
    const api = await getApi();
    api.clearModelForTests();
    await api.clearModelsForTests();
    const models = api.modelStoreForTests();
    const roles = api.reviewRolesStoreForTests();
    assert.ok(models);
    assert.ok(roles);
    try {
      const writing = await models.add(
        {
          provider: "anthropic",
          protocol: "anthropic",
          endpoint: "",
          model: "claude-sonnet-4-5",
        },
        "k",
      );
      await models.setActive(writing.id);
      const keyless = await models.add(
        {
          provider: "anthropic",
          protocol: "anthropic",
          endpoint: "",
          model: "claude-haiku-4-5-20251001",
        },
        "",
      );
      // V1: the roles value carries the verifier's default.
      await roles.set({
        reviewers: ["", keyless.id],
        synthesis: "",
        verifier: "",
        pdfReviewer: "",
      });
      await openManuscript();
      const before = reviewsHeld(api);
      // A lit setting the engine silently ignores is the defect ADR 0049 §1
      // names; a panel that quietly ran the Writing model where the card shows
      // another would be worse. So: no send at all, and say who.
      assert.deepStrictEqual(
        await api.dispatchWebviewMessageForTests({ type: "runReviewPanel" }),
        { status: "no-reviewer-model", role: "reviewer_b" },
      );
      assert.strictEqual(
        reviewsHeld(api),
        before,
        "a refused panel still landed a review",
      );
      // The refusal RELEASED the run: a second attempt refuses again rather
      // than reporting a panel busy forever.
      assert.deepStrictEqual(
        await api.dispatchWebviewMessageForTests({ type: "runReviewPanel" }),
        { status: "no-reviewer-model", role: "reviewer_b" },
      );
    } finally {
      await api.clearModelsForTests();
      await roles.set(DEFAULT_REVIEW_ROLES);
    }
  });
});

/**
 * V1 (ADR 0076): what the host owes the verifier — its role reaching the
 * panel, what it found reaching the tab and the record, its spend charged to
 * the model it ran on, and the one new route: open the passage that answered
 * a withdrawn concern.
 */
suite("V1: the verifier in the extension host", function () {
  this.timeout(60000);
  suiteTeardown(async () => {
    const api = await getApi();
    api.setReviewPanelForTests(undefined);
    api.clearModelForTests();
    await api.clearModelsForTests();
    await api.reviewRolesStoreForTests()?.set(DEFAULT_REVIEW_ROLES);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  const SONNET: ModelBinding = {
    protocol: "anthropic",
    endpoint: "stub://",
    model: "claude-sonnet-4-5",
    apiKey: "k",
  };
  const on = (model: ModelAdapter, id: string) => ({
    adapter: model,
    binding: { ...SONNET, model: id },
  });

  /** The verifier's reading of the three concerns: `reviewer_a-1` stands but
   *  is not central, `reviewer_b-1` is answered by the design sentence in
   *  ANOTHER file than its claim, `reviewer_c-1` is a matter of judgment. */
  const NOTE = "The opening sentence of the paper states the estimator.";
  const VERIFY = JSON.stringify({
    verifications: [
      {
        id: "reviewer_a-1",
        kind: "contradiction",
        outcome: "upheld",
        central: false,
      },
      {
        id: "reviewer_b-1",
        kind: "absence",
        outcome: "refuted",
        counter: { anchor: DESIGN },
        note: NOTE,
      },
      { id: "reviewer_c-1", kind: "judgment", outcome: "unverifiable" },
    ],
  });

  test("O19: the tab gets what verification found, and the verifier is charged once, to its own model", async () => {
    const api = await getApi();
    api.resetCostForTests();
    const model = new SeatModel(undefined, {
      ...SEAT_ANSWER,
      verifier: VERIFY,
    });
    api.setModelForTests(model, SONNET);
    api.setReviewPanelForTests({
      reviewers: [
        on(model, "claude-sonnet-4-5"),
        on(model, "claude-sonnet-4-5"),
        on(model, "claude-sonnet-4-5"),
      ],
      synthesis: on(model, "claude-sonnet-4-5"),
      verifier: on(model, "verifier-model"),
    });
    try {
      await openManuscript();
      await runPanel(api, { type: "runReviewPanel" });
      const tab = api.lastReviewTabStateForTests();
      assert.ok(tab);
      const by = (id: string) => tab.annotations.find((a) => a.id === id);

      // The badge needs two models to agree (ADR 0076 §6): the reviewer
      // flagged it, the verifier answered that it is not central.
      assert.strictEqual(by("reviewer_a-1")?.blocking, undefined);
      assert.deepStrictEqual(by("reviewer_a-1")?.verification, {
        outcome: "upheld",
        kind: "contradiction",
      });
      // The counter carries its OWN file — the claim is in method.tex.
      assert.strictEqual(by("reviewer_b-1")?.file, "sections/method.tex");
      assert.deepStrictEqual(by("reviewer_b-1")?.verification, {
        outcome: "refuted",
        kind: "absence",
        counter: { file: "main.tex", line: 3 },
        note: NOTE,
      });
      assert.deepStrictEqual(by("reviewer_c-1")?.verification, {
        outcome: "unverifiable",
        kind: "judgment",
      });
      // Withdrawn is not deleted: all three are still in the result.
      assert.strictEqual(tab.annotations.length, 3);

      // Which model checked them, by the cross-review's own rule.
      const last: StoredReview | undefined = api
        .persistableReviewsForTests()
        .at(-1);
      assert.strictEqual(tab.verifier?.model, "verifier-model");
      assert.strictEqual(
        tab.verifier?.unverified,
        last?.verifierSeat?.unverified,
      );

      // The record keeps both: a reloaded review keeps its withdrawn fold.
      assert.strictEqual(last?.verifierSeat?.reviewer, "verifier");
      assert.strictEqual(last?.verifierSeat?.model, "verifier-model");
      assert.strictEqual(
        last?.result.annotations[1]?.verification?.outcome,
        "refuted",
      );

      // Charged ONCE, to its own model: its pre-run check plus its seat.
      const spent = last?.verifierSeat?.usage;
      assert.ok(spent, "the verifier's seat carried no usage");
      assert.deepStrictEqual(
        api.sessionUsageForTests().find((r) => r.model === "verifier-model"),
        {
          model: "verifier-model",
          inputTokens: 1 + spent.inputTokens,
          outputTokens: 1 + spent.outputTokens,
        },
      );
    } finally {
      api.setReviewPanelForTests(undefined);
      api.clearModelForTests();
    }
  });

  test("O21: the counter route opens the counter's own file at its line, and is a no-op without one", async () => {
    const api = await getApi();
    const tab = api.lastReviewTabStateForTests();
    assert.ok(tab, "the previous test's review is the fixture");
    const withdrawn = tab.annotations.findIndex((a) => a.id === "reviewer_b-1");
    const upheld = tab.annotations.findIndex((a) => a.id === "reviewer_a-1");
    assert.ok(withdrawn >= 0 && upheld >= 0);
    const at = (): { file: string; line: number } => {
      const editor = vscode.window.activeTextEditor;
      return {
        file: (editor?.document.uri.fsPath ?? "").replace(/\\/g, "/"),
        line: editor?.selection.active.line ?? -1,
      };
    };

    // The claim's reveal is unchanged: method.tex.
    await api.dispatchWebviewMessageForTests({
      type: "revealAnnotation",
      index: withdrawn,
    });
    assert.ok(at().file.endsWith("sections/method.tex"), at().file);

    // The counter's: main.tex, line 3 (0-based 2).
    await api.dispatchWebviewMessageForTests({
      type: "revealAnnotation",
      index: withdrawn,
      which: "counter",
    });
    assert.ok(at().file.endsWith("/main.tex"), at().file);
    assert.strictEqual(at().line, 2);

    // No counter, no move — and in particular NOT the claim's reveal, which
    // would land on main.tex line 4 (0-based 3).
    await api.dispatchWebviewMessageForTests({
      type: "revealAnnotation",
      index: upheld,
      which: "counter",
    });
    assert.ok(at().file.endsWith("/main.tex"), at().file);
    assert.strictEqual(at().line, 2);
  });

  test("O17: Off reaches the panel, which asks no verifier and says so", async () => {
    const api = await getApi();
    const model = new SeatModel();
    api.setModelForTests(model, SONNET);
    api.setReviewPanelForTests({
      reviewers: [
        on(model, "claude-sonnet-4-5"),
        on(model, "claude-sonnet-4-5"),
        on(model, "claude-sonnet-4-5"),
      ],
      synthesis: on(model, "claude-sonnet-4-5"),
      verifier: "off",
      // V4 (ADR 0081): off, so the one limit this case is about is the only one.
      pdfReviewer: "off",
    });
    try {
      await openManuscript();
      await runPanel(api, { type: "runReviewPanel" });
      assert.ok(!model.seats.includes("verifier"), "Off still ran a verifier");
      const tab = api.lastReviewTabStateForTests();
      assert.deepStrictEqual(tab?.limits, [
        { kind: "verification_missing", reason: "off" },
      ]);
      assert.strictEqual(tab?.verifier, undefined);
    } finally {
      api.setReviewPanelForTests(undefined);
      api.clearModelForTests();
    }
  });

  test("O17: a verifier that cannot be bound refuses the run and names itself", async () => {
    const api = await getApi();
    api.clearModelForTests();
    await api.clearModelsForTests();
    const models = api.modelStoreForTests();
    const roles = api.reviewRolesStoreForTests();
    assert.ok(models);
    assert.ok(roles);
    try {
      const writing = await models.add(
        {
          provider: "anthropic",
          protocol: "anthropic",
          endpoint: "",
          model: "claude-sonnet-4-5",
        },
        "k",
      );
      await models.setActive(writing.id);
      const keyless = await models.add(
        {
          provider: "anthropic",
          protocol: "anthropic",
          endpoint: "",
          model: "claude-haiku-4-5-20251001",
        },
        "",
      );
      await roles.set({
        reviewers: [""],
        synthesis: "",
        verifier: keyless.id,
        pdfReviewer: "",
      });
      await openManuscript();
      const before = reviewsHeld(api);
      assert.deepStrictEqual(
        await api.dispatchWebviewMessageForTests({ type: "runReviewPanel" }),
        { status: "no-reviewer-model", role: "verifier" },
      );
      assert.strictEqual(reviewsHeld(api), before);
    } finally {
      await api.clearModelsForTests();
      await roles.set(DEFAULT_REVIEW_ROLES);
    }
  });
});

/**
 * X6 O8 (ADR 0075 §5–§6): what the projection carries, on a module instance of
 * this suite's own.
 *
 * `review-ui` is imported as a VALUE here, so this is a second copy of the
 * module beside the one the bundled extension runs — its review list starts
 * empty and its store handle is never set, so nothing here reaches the live
 * tab or the disk. That is what lets a test present the one panel a real run
 * cannot produce any more: one recorded before X5, with no cross-review row.
 */
suite("X6: the tab's projection of a stored panel", () => {
  const RESULT: ReviewResult = {
    annotations: [
      {
        id: "reviewer_a-1",
        reviewer: "reviewer_a",
        dimension: "soundness",
        severity: "major",
        span: { file: "main.tex", line: 4 },
        message: "the exclusion restriction is never argued",
        // Cross-file: the claim is in the entry, its support is not.
        evidence: { kind: "span", file: "sections/method.tex", line: 1 },
      },
      {
        id: "reviewer_b-1",
        reviewer: "reviewer_b",
        dimension: "claims",
        severity: "minor",
        span: { file: "main.tex", line: 5 },
        message: "the baseline is not named",
        evidence: { kind: "span", file: "main.tex", line: 3, endLine: 4 },
      },
    ],
    synthesis: { consensus: [], disagreements: [] },
  };
  const seat = (reviewer: string, model: string): ReviewSeatState => ({
    reviewer,
    status: "completed",
    model,
  });
  const root = path.join(os.tmpdir(), "lemmaria-x6-projection");

  teardown(() => clearReviewsHere());

  test("O8: the evidence carries its file, and only its file and line", () => {
    presentHere(RESULT, root, "main.tex", {
      reveal: false,
      seats: [seat("reviewer_a", "m1"), seat("reviewer_b", "m1")],
    });
    const tab = tabStateHere();
    // V2 (ADR 0078 §8): tagged, and X6's rule is unchanged under the tag —
    // still the file and the line, and still nothing else.
    assert.deepStrictEqual(tab.annotations[0]?.evidence, {
      kind: "span",
      file: "sections/method.tex",
      line: 1,
    });
    // `endLine` is the harness's; the tab names a line, not a range.
    assert.deepStrictEqual(tab.annotations[1]?.evidence, {
      kind: "span",
      file: "main.tex",
      line: 3,
    });
  });

  /**
   * V2 (O20, ADR 0078 §D12): the third kind, and the href rule.
   *
   * The URL on a `paper` is THIRD-PARTY data -- returned by a scholarly index,
   * copied by a model -- so the host decides whether the tab is handed
   * something openable. Only an http(s) URL becomes an href; a DOI resolves
   * through doi.org; anything else yields none and the row draws plain text.
   */
  const paperResult = (over: Record<string, unknown>): ReviewResult => ({
    annotations: [
      {
        id: "reviewer_a-1",
        reviewer: "reviewer_a",
        dimension: "originality",
        severity: "major",
        span: { file: "main.tex", line: 4 },
        message: "the combination is not new",
        evidence: {
          kind: "paper",
          title: "Adam: A Method for Stochastic Optimization",
          authors: ["Kingma", "Ba"],
          source: "arxiv",
          ...over,
        },
      } as ReviewResult["annotations"][number],
    ],
    synthesis: { consensus: [], disagreements: [] },
  });

  const projectPaper = (over: Record<string, unknown>) => {
    presentHere(paperResult(over), root, "main.tex", {
      reveal: false,
      seats: [seat("reviewer_a", "m1")],
    });
    return tabStateHere().annotations[0]?.evidence;
  };

  test("O20: a paper projects its title, year and an http(s) href", () => {
    assert.deepStrictEqual(
      projectPaper({ year: "2015", url: "https://arxiv.org/abs/1412.6980" }),
      {
        kind: "paper",
        title: "Adam: A Method for Stochastic Optimization",
        year: "2015",
        href: "https://arxiv.org/abs/1412.6980",
      },
    );
    // The authors, the venue and the source stay behind: the row draws a
    // title, a year and a link.
    clearReviewsHere();
  });

  test("O20: a DOI resolves through doi.org when there is no http(s) url", () => {
    assert.deepStrictEqual(projectPaper({ doi: "10.5555/abcd" }), {
      kind: "paper",
      title: "Adam: A Method for Stochastic Optimization",
      href: "https://doi.org/10.5555/abcd",
    });
    clearReviewsHere();
  });

  test("O20: a non-http(s) url yields NO href, DOI or not", () => {
    // The case the rule exists for. A `javascript:` or `file:` URL from an
    // index must never reach the tab as something it will open.
    assert.deepStrictEqual(
      projectPaper({ url: "ftp://example.invalid/p.pdf" }),
      {
        kind: "paper",
        title: "Adam: A Method for Stochastic Optimization",
      },
    );
    clearReviewsHere();
    // ...and with a DOI beside it, the DOI is what gets used.
    assert.deepStrictEqual(
      projectPaper({ url: "ftp://example.invalid/p.pdf", doi: "10.5555/x" }),
      {
        kind: "paper",
        title: "Adam: A Method for Stochastic Optimization",
        href: "https://doi.org/10.5555/x",
      },
    );
    clearReviewsHere();
  });

  test('O20: a stored year of "null" or blank is dropped, not drawn', () => {
    // V2's gate review, issue 3, second half. The Crossref mapper now refuses
    // `[[null]]` at the source — but every `reviews.json` written before that
    // fix already holds `"year": "null"`, and this projection is what those
    // records come back through. A missing year is a legitimate state that
    // renders with no parentheses; the literal "null" renders as `(null)`.
    assert.deepStrictEqual(projectPaper({ year: "null" }), {
      kind: "paper",
      title: "Adam: A Method for Stochastic Optimization",
    });
    clearReviewsHere();
    assert.deepStrictEqual(projectPaper({ year: "   " }), {
      kind: "paper",
      title: "Adam: A Method for Stochastic Optimization",
    });
    clearReviewsHere();
    // And a real year is untouched, including one that merely CONTAINS the
    // word — the test is the whole trimmed value, not a substring.
    assert.deepStrictEqual(projectPaper({ year: "2002" }), {
      kind: "paper",
      title: "Adam: A Method for Stochastic Optimization",
      year: "2002",
    });
    clearReviewsHere();
  });

  test("O8: a panel with no cross-review row projects no crossReview", () => {
    // A review stored before X5: the heading simply says less.
    presentHere(RESULT, root, "main.tex", {
      reveal: false,
      seats: [seat("reviewer_a", "m1"), seat("reviewer_b", "m1")],
    });
    const tab = tabStateHere();
    assert.strictEqual(tab.crossReview, undefined);
    assert.ok(!("crossReview" in tab), "an absent row became a present key");
    // And the empty cross-review still reaches the tab as EMPTY, not absent —
    // the difference between *found nothing* and *did not run* (ADR 0075 §5).
    assert.deepStrictEqual(tab.synthesis, {
      consensus: [],
      disagreements: [],
    });
  });

  test("O8: the cross-review's model is projected by the seats' own exception", () => {
    presentHere(RESULT, root, "main.tex", {
      reveal: false,
      seats: [seat("reviewer_a", "m1"), seat("reviewer_b", "m1")],
      synthesisSeat: { ...seat("synthesis", "local-8b"), unverified: true },
    });
    assert.deepStrictEqual(tabStateHere().crossReview, {
      model: "local-8b",
      unverified: true,
    });
    // A row whose model replayed as `""` (the pre-R9 normalization) carries
    // the row but no model — present, and saying less.
    presentHere(RESULT, root, "main.tex", {
      reveal: false,
      seats: [seat("reviewer_a", "m1"), seat("reviewer_b", "m1")],
      synthesisSeat: seat("synthesis", ""),
    });
    assert.deepStrictEqual(tabStateHere().crossReview, {});
  });
});

/**
 * V1 (ADR 0076 §7, O19): verification is part of the RESULT, not triage, so a
 * review read back from disk keeps it — its withdrawn concerns still carry the
 * passage that answered them, its badges are still gated by `central`, and it
 * still names the model that checked it.
 *
 * Driven through `initReviews` on this suite's own module instance, from a
 * file the harness's own `ReviewStore` wrote: the real reload path, not a
 * re-present.
 */
suite("V1: a stored review reloads with what verification found", () => {
  teardown(() => clearReviewsHere());

  test("O19: withdrawn stays withdrawn, the badge stays gated, the verifier is named", async () => {
    const globalStorage = path.join(
      os.tmpdir(),
      `lemmaria-v1-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const context = {
      globalStorageUri: vscode.Uri.file(globalStorage),
    } as vscode.ExtensionContext;
    const root = path.join(os.tmpdir(), "lemmaria-v1-reload-paper");
    const concern = (
      id: string,
      line: number,
      extra: Partial<ReviewResult["annotations"][number]>,
    ): ReviewResult["annotations"][number] => ({
      id,
      reviewer: id.slice(0, id.lastIndexOf("-")),
      dimension: "soundness",
      severity: "major",
      span: { file: "main.tex", line },
      message: `concern ${id}`,
      ...extra,
    });
    const stored: StoredReview = {
      mode: "panel",
      root,
      entry: "main.tex",
      file: path.join(root, "main.tex"),
      at: 1_756_000_000_000,
      version: 1,
      result: {
        annotations: [
          concern("reviewer_a-1", 4, {
            blocking: true,
            verification: {
              outcome: "upheld",
              kind: "contradiction",
              central: false,
            },
          }),
          concern("reviewer_a-2", 5, {
            blocking: true,
            verification: { outcome: "upheld", kind: "absence", central: true },
          }),
          concern("reviewer_b-1", 6, {
            verification: {
              outcome: "refuted",
              kind: "absence",
              counter: { file: "sections/method.tex", line: 1, endLine: 2 },
              note: "Appendix A is quoted in full in Section 2.",
            },
          }),
          // Stored before V1: never checked, and its badge is the reviewer's.
          concern("reviewer_c-1", 7, { blocking: true }),
        ],
      },
      seats: [
        { reviewer: "reviewer_a", status: "completed", model: "m1" },
        { reviewer: "reviewer_b", status: "completed", model: "m1" },
        { reviewer: "reviewer_c", status: "completed", model: "m1" },
      ],
      verifierSeat: {
        reviewer: "verifier",
        status: "completed",
        model: "local-8b",
        unverified: true,
      },
    };
    try {
      await new ReviewStore(reviewStoreDir(context)).save([stored]);
      await initReviewsHere(context);
      const tab = tabStateHere();
      assert.deepStrictEqual(
        tab.annotations.map((a) => a.blocking),
        [undefined, true, undefined, true],
        "the badge is shown iff the reviewer set it and no verifier said not central",
      );
      // `central` gates the badge and is not itself shipped (ADR 0076 §6).
      assert.deepStrictEqual(tab.annotations[0]?.verification, {
        outcome: "upheld",
        kind: "contradiction",
      });
      // The counter names a file and a line; `endLine` stays behind, as the
      // evidence's does (ADR 0075 §6).
      assert.deepStrictEqual(tab.annotations[2]?.verification, {
        outcome: "refuted",
        kind: "absence",
        counter: { file: "sections/method.tex", line: 1 },
        note: "Appendix A is quoted in full in Section 2.",
      });
      assert.strictEqual(tab.annotations[3]?.verification, undefined);
      assert.deepStrictEqual(tab.verifier, {
        model: "local-8b",
        unverified: true,
      });
    } finally {
      await vscode.workspace.fs.delete(vscode.Uri.file(globalStorage), {
        recursive: true,
        useTrash: false,
      });
    }
  });

  test("O19: a panel stored before V1 projects no verifier at all", () => {
    presentHere(
      {
        annotations: [
          {
            id: "reviewer_a-1",
            reviewer: "reviewer_a",
            dimension: "soundness",
            severity: "major",
            span: { file: "main.tex", line: 4 },
            message: "the exclusion restriction is never argued",
            blocking: true,
          },
        ],
      },
      path.join(os.tmpdir(), "lemmaria-v1-pre"),
      "main.tex",
      {
        reveal: false,
        seats: [{ reviewer: "reviewer_a", status: "completed", model: "m1" }],
      },
    );
    const tab = tabStateHere();
    assert.ok(!("verifier" in tab), "an absent row became a present key");
    assert.strictEqual(tab.annotations[0]?.blocking, true);
    assert.ok(!("verification" in (tab.annotations[0] ?? {})));
  });
});

/** A report's counts: what a seat that completed AND wrote a ledger carries,
 *  and what `deriveScorecard` requires of a contributor. */
const LEDGER = {
  entries: 1,
  located: 1,
  relocated: 0,
  dropped: 0,
  rejected: 0,
};

/**
 * V5 (ADR 0087, D14, O15): strengths, assessments and the seat's search
 * counts are part of the RECORD. V6 (ADR 0088 §1, plan D13): they reach the
 * tab through exactly one door — the card the host derives from the record.
 *
 * Driven through `initReviews` from a file the harness's own `ReviewStore`
 * wrote, like V1's reload case above: what reloads must be what was stored,
 * and what the tab projects from it must equal what it projects from the same
 * review with every V5 field taken out — except the card, which is
 * `deriveScorecard` of each record and nothing the tab computed itself.
 */
suite("V6: strengths and impressions reach the tab only via the card", () => {
  teardown(() => clearReviewsHere());

  test("O15: a stored review keeps them through a reload, and projects exactly as one without them", async () => {
    const globalStorage = path.join(
      os.tmpdir(),
      `lemmaria-v5-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const context = {
      globalStorageUri: vscode.Uri.file(globalStorage),
    } as vscode.ExtensionContext;
    const root = path.join(os.tmpdir(), "lemmaria-v5-reload-paper");
    const seat = (reviewer: string): ReviewSeatState => ({
      reviewer,
      status: "completed",
      model: "m1",
      searches: { attempted: 2, answered: 1 },
      // V6: a completed seat that wrote a report — the only kind the card
      // counts as a contributor (ADR 0087 §4) — so the card below has rows.
      ledger: LEDGER,
    });
    const stored: StoredReview = {
      mode: "panel",
      root,
      entry: "main.tex",
      file: path.join(root, "main.tex"),
      at: 1_757_000_000_000,
      version: 1,
      result: {
        annotations: [
          {
            id: "reviewer_a-1",
            reviewer: "reviewer_a",
            dimension: "soundness",
            severity: "major",
            span: { file: "main.tex", line: 4 },
            message: "the exclusion restriction is never argued",
          },
        ],
        strengths: [
          {
            id: "reviewer_b-s1",
            reviewer: "reviewer_b",
            dimension: "clarity",
            span: { file: "main.tex", line: 5 },
            message: "the estimator is defined before it is used",
            evidence: { kind: "span", file: "main.tex", line: 6 },
          },
        ],
        assessments: [
          { reviewer: "reviewer_a", dimension: "soundness", impression: 3 },
          { reviewer: "reviewer_b", dimension: "clarity", impression: null },
          {
            reviewer: "reviewer_b",
            dimension: "originality",
            impression: null,
            notAssessed: "no literature source answered",
          },
        ],
        limits: [
          {
            kind: "strengths_lost",
            reviewer: "reviewer_a",
            dropped: [
              {
                anchor: "a praised passage",
                role: "claim",
                reason: "not_found",
              },
            ],
            rejected: [],
          },
        ],
      },
      seats: [seat("reviewer_a"), seat("reviewer_b")],
    };
    const {
      strengths: _strengths,
      assessments: _assessments,
      ...bareResult
    } = stored.result;
    const bare: StoredReview = {
      ...stored,
      result: bareResult,
      seats: (stored.seats ?? []).map(({ searches: _s, ...rest }) => rest),
    };
    const reload = async (review: StoredReview) => {
      clearReviewsHere();
      await new ReviewStore(reviewStoreDir(context)).save([review]);
      await initReviewsHere(context);
      return { tab: tabStateHere(), back: persistableHere().at(-1) };
    };
    try {
      const full = await reload(stored);
      // The round-trip: store → initReviews → persistable, field for field.
      assert.deepStrictEqual(
        full.back?.result.strengths,
        stored.result.strengths,
      );
      assert.deepStrictEqual(
        full.back?.result.assessments,
        stored.result.assessments,
      );
      assert.deepStrictEqual(full.back?.result.limits, stored.result.limits);
      assert.deepStrictEqual(
        full.back?.seats?.map((s) => s.searches),
        [
          { attempted: 2, answered: 1 },
          { attempted: 2, answered: 1 },
        ],
      );
      // The projection: nothing V5 records reaches the tab but its limit and
      // the card — and the card is the harness's derivation of the record.
      const without = await reload(bare);
      const { scorecard: fullCard, ...fullRest } = full.tab;
      const { scorecard: bareCard, ...bareRest } = without.tab;
      assert.deepStrictEqual(fullRest, bareRest);
      assert.deepStrictEqual(full.tab.limits, stored.result.limits);
      assert.deepStrictEqual(fullCard, deriveScorecard(stored));
      assert.deepStrictEqual(bareCard, deriveScorecard(bare));
      // The strength makes clarity a level 4 and the impressions fill the
      // soundness row, so the two cards are not the same card.
      assert.notDeepStrictEqual(fullCard, bareCard);
    } finally {
      await vscode.workspace.fs.delete(vscode.Uri.file(globalStorage), {
        recursive: true,
        useTrash: false,
      });
    }
  });
});

/**
 * V6 (ADR 0088 §1, plan D1, O19): the host derives the card.
 *
 * The webview cannot — the projection drops `endLine` and `central`, and the
 * harness's scorecard module is reachable only through the barrel — so
 * `computeReviewTabState` calls `deriveScorecard` over the SELECTED review
 * and ships the card beside the annotations. A quick review ships none: it
 * is unversioned, has no seats and no strengths, and its card would be all
 * *nothing raised* on unknown models.
 */
suite("V6: the host derives the scorecard into the tab's state", () => {
  teardown(() => clearReviewsHere());

  const ROOT = path.join(os.tmpdir(), "lemmaria-v6-card");
  const concern = {
    id: "reviewer_a-1",
    reviewer: "reviewer_a",
    dimension: "soundness",
    severity: "major" as const,
    span: { file: "main.tex", line: 4 },
    message: "the exclusion restriction is never argued",
  };

  test("O19: a panel's state carries the card deriveScorecard computes from it", () => {
    const result: ReviewResult = {
      annotations: [concern],
      assessments: [
        { reviewer: "reviewer_a", dimension: "soundness", impression: 3 },
      ],
    };
    const seats: ReviewSeatState[] = [
      {
        reviewer: "reviewer_a",
        status: "completed",
        model: "m1",
        ledger: LEDGER,
      },
      {
        reviewer: "reviewer_b",
        status: "completed",
        model: "m1",
        ledger: LEDGER,
      },
    ];
    presentHere(result, ROOT, "main.tex", {
      reveal: false,
      version: 1,
      seats,
    });
    const tab = tabStateHere();
    assert.deepStrictEqual(tab.scorecard, deriveScorecard({ result, seats }));
    assert.strictEqual(tab.scorecard?.dimensions.length, 8);
    // Not a vacuous equality: both reviewers contributed, and the concern
    // stands as a level.
    assert.strictEqual(tab.scorecard?.panel.reviewers.length, 2);
    assert.deepStrictEqual(tab.scorecard?.dimensions[0]?.standing, {
      kind: "level",
      level: 2,
      checked: false,
    });
  });

  test("O19: a PDF review's state carries its card too", () => {
    const result: ReviewResult = {
      annotations: [
        {
          ...concern,
          id: "pdf_reviewer-1",
          reviewer: "pdf_reviewer",
          dimension: "presentation",
          severity: "minor",
        },
      ],
    };
    const pdfSeat: ReviewSeatState = {
      reviewer: "pdf_reviewer",
      status: "completed",
      model: "vision-1",
      ledger: LEDGER,
    };
    presentHere(result, ROOT, "main.tex", {
      reveal: false,
      version: 1,
      mode: "pdf",
      seats: [],
      pdfSeat,
    });
    const tab = tabStateHere();
    assert.strictEqual(tab.mode, "pdf");
    assert.deepStrictEqual(
      tab.scorecard,
      deriveScorecard({ result, seats: [], pdfSeat }),
    );
    assert.deepStrictEqual(tab.scorecard?.panel.pdf, { model: "vision-1" });
  });

  test("O19: a quick review's state carries no card key at all", async () => {
    const globalStorage = path.join(
      os.tmpdir(),
      `lemmaria-v6-quick-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const context = {
      globalStorageUri: vscode.Uri.file(globalStorage),
    } as vscode.ExtensionContext;
    const quick: StoredReview = {
      mode: "quick",
      root: ROOT,
      entry: "main.tex",
      file: path.join(ROOT, "main.tex"),
      at: 1_757_000_000_000,
      result: { annotations: [{ ...concern, dimension: "clarity" }] },
    };
    try {
      await new ReviewStore(reviewStoreDir(context)).save([quick]);
      await initReviewsHere(context);
      const tab = tabStateHere();
      assert.strictEqual(tab.mode, "quick");
      // Absent stays absent — not an `undefined`-valued key.
      assert.ok(!("scorecard" in tab), "a quick review grew a card");
      assert.ok(!("previous" in tab), "a quick review grew a comparison");
      assert.ok(!("delta" in tab), "a quick review grew a delta");
    } finally {
      await vscode.workspace.fs.delete(vscode.Uri.file(globalStorage), {
        recursive: true,
        useTrash: false,
      });
    }
  });

  test("O19: a second version of the manuscript is compared against the first, and the first against nothing", () => {
    const seats: ReviewSeatState[] = [
      {
        reviewer: "reviewer_a",
        status: "completed",
        model: "m1",
        ledger: LEDGER,
      },
    ];
    const first: ReviewResult = { annotations: [concern] };
    const second: ReviewResult = {
      annotations: [{ ...concern, severity: "minor" }],
    };
    const opts = { reveal: false, seats } as const;
    presentHere(first, ROOT, "main.tex", { ...opts, version: 1 });
    // Another manuscript between them is never a candidate.
    presentHere(first, ROOT, "other.tex", { ...opts, version: 2 });
    presentHere(second, ROOT, "main.tex", { ...opts, version: 3 });
    const tab = tabStateHere();
    assert.deepStrictEqual(tab.previous, { version: 1, comparable: true });
    assert.deepStrictEqual(
      tab.delta,
      scorecardDelta(
        deriveScorecard({ result: first, seats }),
        deriveScorecard({ result: second, seats }),
      ),
    );
    const soundness = tab.delta?.dimensions.find(
      (d) => d.dimension === "soundness",
    );
    assert.strictEqual(
      soundness?.comparable === true ? soundness.change : undefined,
      "improved",
    );
    // Relative to the SELECTED review: v1 is its manuscript's first reading.
    selectHere(0);
    const older = tabStateHere();
    assert.ok(!("previous" in older), "a first reading grew a comparison");
    assert.ok(!("delta" in older));
    assert.deepStrictEqual(
      older.scorecard,
      deriveScorecard({ result: first, seats }),
    );
  });

  test("O19: an empty tab carries no card", () => {
    const tab = tabStateHere();
    assert.strictEqual(tab.available, false);
    assert.ok(!("scorecard" in tab));
  });
});
