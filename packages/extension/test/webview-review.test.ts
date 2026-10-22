/**
 * X6 O10 (ADR 0075 §6; ADR 0043): a review concern's id line is its own line,
 * measured in the REAL webview.
 *
 * The defect was layout — `citeRow` builds the message and the detail as two
 * adjacent inline spans, so the detail flowed on from the message's last word
 * (`…robustness.reviewer_b-1 · major · …`). jsdom performs no layout, so the
 * stylesheet test (`styles.test.ts`) can only say the scoped rule EXISTS; this
 * suite says what the layout engine did with it: the detail's box starts at or
 * below the title's bottom, and the evidence box at or below the detail's — at
 * the default width and at 280px.
 *
 * The X6 review round added one more layout claim to the same panel: across
 * a sweep of narrow widths a seat heading wraps, but never inside its model
 * id, which also keeps its own case inside the uppercase heading.
 *
 * It needs a real panel on screen, so it carries its own copy of the fake
 * panel `review-panel.test.ts` drives (`seatOf`, `SeatModel`, a two-file
 * manuscript) rather than importing across test files. No wall-clock waits: host facts are
 * awaited by condition, DOM facts by probing until they hold.
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
} from "@lemmaria/harness";
import { REVIEWER_NAMES } from "@lemmaria/harness";
import * as vscode from "vscode";
import type {
  ProbeRect,
  ProbeResult,
  ProbeStep,
  ReviewTabState,
  WebviewToHost,
} from "../src/webview-protocol";

interface ReviewDriveApi {
  revealWebviewForTests(): Promise<void>;
  probeWebviewForTests(
    steps: ProbeStep[],
    opts?: { timeoutMs?: number },
  ): Promise<ProbeResult[]>;
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  lastReviewTabStateForTests(): ReviewTabState | undefined;
  resetSessionForTests(): void;
}

async function getApi(): Promise<ReviewDriveApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as ReviewDriveApi;
}

const MAIN = [
  "\\documentclass{article}", // 1
  "\\begin{document}", // 2
  "We estimate the effect with a two-stage least squares design.", // 3
  "The instrument is the distance to the nearest treated unit.", // 4
  "Table 2 reports a gain of nine points over the strongest baseline.", // 5
  "\\input{sections/method}", // 6
  "\\end{document}", // 7
  "",
].join("\n");
const METHOD = ["The estimator is defined in Appendix A only.", ""].join("\n");

const INSTRUMENT =
  "The instrument is the distance to the nearest treated unit.";
const DESIGN = "We estimate the effect with a two-stage least squares design.";
const ESTIMATOR = "The estimator is defined in Appendix A only.";

/** reviewer_a's concern is the FIRST card on the tab, and it carries all
 *  three lines this suite measures: a message, an id line, and evidence —
 *  in another file, so the evidence line is the long `file:line` form. */
const SEAT_ANSWER: Record<string, string> = {
  reviewer_a: JSON.stringify({
    annotations: [
      {
        dimension: "soundness",
        severity: "major",
        anchor: INSTRUMENT,
        evidence: { anchor: ESTIMATOR, file: "sections/method.tex" },
        blocking: true,
        message: "the exclusion restriction is never argued",
      },
    ],
  }),
  reviewer_b: JSON.stringify({
    annotations: [
      {
        dimension: "claims",
        severity: "major",
        anchor: DESIGN,
        evidence: "missing",
        message: "the design is asserted, never justified",
      },
    ],
  }),
  reviewer_c: JSON.stringify({ annotations: [] }),
  synthesis: JSON.stringify({ consensus: [], disagreements: [] }),
};

/** Keyed on the FIRST user message, as `review-panel.test.ts` keys it. */
function seatOf(req: GenerateRequest): string {
  const first = req.messages.find((m) => m.role === "user");
  const text = typeof first?.content === "string" ? first.content : "";
  for (const name of REVIEWER_NAMES)
    if (text.includes(`\`${name}\`, one of `)) return name;
  return text.includes("reviewers have each read") ? "synthesis" : "";
}

class SeatModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  private result(req: GenerateRequest): GenerateResult {
    return {
      text: SEAT_ANSWER[seatOf(req)] ?? "unscripted",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.result(req);
  }
  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "completed", result: this.result(req) };
  }
}

/** Wait for a HOST fact by condition — the panel lands asynchronously. */
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

/** Probe until the DOM says what the caller is waiting for — polling the
 *  assertion itself, the `webview-rewind.test.ts` shape, so no fixed sleep
 *  stands in for the render. */
async function probeUntil(
  api: ReviewDriveApi,
  steps: ProbeStep[],
  ready: (results: ProbeResult[]) => boolean,
  label: string,
  timeoutMs = 10000,
): Promise<ProbeResult[]> {
  const start = Date.now();
  let last = await api.probeWebviewForTests(steps);
  while (!ready(last)) {
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `timed out waiting for ${label}; last: ${JSON.stringify(last)}`,
      );
    await new Promise((r) => setTimeout(r, 25));
    last = await api.probeWebviewForTests(steps);
  }
  return last;
}

function val<T>(r: ProbeResult | undefined, what: string): T {
  assert.ok(r, `${what}: no result`);
  assert.strictEqual(r.error, undefined, `${what}: ${r.error}`);
  return r.value as T;
}

const isRendered = (b: ProbeRect): boolean => b.width > 0 && b.height > 0;

/** The first card's three lines — reviewer_a's concern, the first on the
 *  tab. `rect` measures the first match, so each selector lands on it. */
const CARD = ".lm-review-tab .lm-review-card";
const LINES: ProbeStep[] = [
  { verb: "rect", selector: `${CARD} .lm-cite-row__title` },
  { verb: "rect", selector: `${CARD} .lm-cite-row__detail` },
  { verb: "rect", selector: `${CARD} .lm-cite-row__evidence` },
  { verb: "text", selector: `${CARD} .lm-cite-row__detail` },
];

/**
 * Sub-pixel slack: boxes on consecutive lines can share a fractional edge, and
 * a line-box overlap of a pixel or more is the defect this suite exists for.
 */
const SLACK = 0.5;

async function assertThreeLines(api: ReviewDriveApi, width: string) {
  const [title, detail, evidence, detailText] = await probeUntil(
    api,
    LINES,
    (r) =>
      r.slice(0, 3).every((x) => x.error === undefined) &&
      isRendered(r[0]?.value as ProbeRect),
    `the first review card at ${width}`,
  );
  // It is the card this suite built — the id line names reviewer_a's concern.
  assert.match(val<string>(detailText, "detail text"), /^reviewer_a-1 · /);
  const t = val<ProbeRect>(title, "title");
  const d = val<ProbeRect>(detail, "detail");
  const e = val<ProbeRect>(evidence, "evidence");
  for (const [box, what] of [
    [d, "detail"],
    [e, "evidence"],
  ] as const)
    assert.ok(isRendered(box), `${what} is not laid out at ${width}`);
  assert.ok(
    d.top >= t.bottom - SLACK,
    `at ${width} the id line starts inside the message's last line: title ${JSON.stringify(t)}, detail ${JSON.stringify(d)}`,
  );
  assert.ok(
    e.top >= d.bottom - SLACK,
    `at ${width} the evidence line starts inside the id line: detail ${JSON.stringify(d)}, evidence ${JSON.stringify(e)}`,
  );
}

suite(
  "X6 O10 (ADR 0075 §6): the id line is its own line, in the real webview",
  function () {
    this.timeout(60000);

    /** The throwaway manuscript — removed in teardown, see there. */
    let dir = "";

    suiteSetup(async () => {
      const api = await getApi();
      await api.revealWebviewForTests();
      api.setModelForTests(new SeatModel(), {
        protocol: "anthropic",
        endpoint: "stub://",
        model: "claude-sonnet-4-5",
        apiKey: "k",
      });
      dir = path.join(
        os.tmpdir(),
        `lemmaria-x6-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const main = vscode.Uri.file(path.join(dir, "main.tex"));
      await vscode.workspace.fs.writeFile(main, Buffer.from(MAIN, "utf8"));
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(path.join(dir, "sections", "method.tex")),
        Buffer.from(METHOD, "utf8"),
      );
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(main),
      );
      const held = () => api.lastReviewTabStateForTests()?.history?.length ?? 0;
      const before = held();
      await api.dispatchWebviewMessageForTests({ type: "runReviewPanel" });
      await waitFor(() => held() > before, "the detached panel to land");
      // A completed panel reveals the Review tab itself (`reveal: true` →
      // `activeTab = 4`). If an earlier suite left the view elsewhere and the
      // reveal raced it, the tab button gets us there — same as a reader.
      const [present] = await api.probeWebviewForTests([
        { verb: "exists", selector: ".lm-review-tab" },
      ]);
      if (present?.value !== true)
        await api.probeWebviewForTests([
          { verb: "click", selector: "#lm-tab-4" },
        ]);
    });

    suiteTeardown(async () => {
      const api = await getApi();
      // The width is an override on a live view the whole suite shares; a 280px
      // panel left behind would change what a later suite measures. So is the
      // active tab: later suites draw on the Assistant tab, so hand it back.
      await api.probeWebviewForTests([
        { verb: "setWidth", selector: ".lm-app", px: 0 },
        { verb: "click", selector: "#lm-tab-0" },
      ]);
      api.clearModelForTests();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      // Focusing `main.tex` made it the session's STICKY paper, and closing
      // the editor does not forget it — so a later suite's `@` menu walked
      // this manuscript (E3's "nothing granted, no paper" saw its 3 rows).
      // Forget the paper and the panel this suite ran, and delete the files.
      api.resetSessionForTests();
      if (dir !== "")
        await vscode.workspace.fs.delete(vscode.Uri.file(dir), {
          recursive: true,
          useTrash: false,
        });
    });

    test("message, id line and evidence are three lines at the default width", async () => {
      const api = await getApi();
      await api.probeWebviewForTests([
        { verb: "setWidth", selector: ".lm-app", px: 0 },
      ]);
      await assertThreeLines(api, "the default width");
    });

    test("and still three lines at 280px", async () => {
      const api = await getApi();
      const [, width] = await api.probeWebviewForTests([
        { verb: "setWidth", selector: ".lm-app", px: 280 },
        { verb: "rect", selector: ".lm-app" },
      ]);
      assert.ok(
        Math.abs(val<ProbeRect>(width, ".lm-app").width - 280) < 1,
        "the forced width did not take",
      );
      await assertThreeLines(api, "280px");
    });

    // The X6 review round, in a 中文 sidebar at ~440px: a seat heading wrapped
    // as `REVIEWER_A · GPT-5.6-LUNA · 9` / `条意见`, a mark as `…gpt-` /
    // `5.6-luna`, and the uppercase heading printed an id that is
    // case-sensitive in the wrong case. jsdom can only say the spans exist;
    // this says what the layout engine did with them.
    //
    // A SWEEP, not one width. Where a line breaks depends on the font, and at
    // any single width the break may simply fall outside the id — measured:
    // at 280px the id stays whole with the fix removed, so a one-width test
    // passes either way. Somewhere in 180–320px the line's end falls inside
    // `claude-sonnet-4-5` on any font that fits the heading at all.
    test("a heading wraps at a narrow width, but never inside its model id", async () => {
      const api = await getApi();
      const HEAD =
        ".lm-review-tab .lm-review-fold--group > .lm-review-fold__summary";
      let wrapped = 0;
      for (let px = 180; px <= 320; px += 10) {
        const [, app, id, count, heading, padTop, padBottom] = await probeUntil(
          api,
          [
            { verb: "setWidth", selector: ".lm-app", px },
            { verb: "rect", selector: ".lm-app" },
            { verb: "rect", selector: `${HEAD} .lm-review-model` },
            { verb: "rect", selector: `${HEAD} .lm-review-count` },
            { verb: "rect", selector: HEAD },
            { verb: "computed", selector: HEAD, name: "padding-top" },
            { verb: "computed", selector: HEAD, name: "padding-bottom" },
          ],
          (r) =>
            r.slice(1).every((x) => x.error === undefined) &&
            isRendered(r[2]?.value as ProbeRect),
          `the first seat heading at ${px}px`,
        );
        assert.ok(
          Math.abs(val<ProbeRect>(app, ".lm-app").width - px) < 1,
          `the forced width ${px}px did not take`,
        );
        const m = val<ProbeRect>(id, "model id");
        const c = val<ProbeRect>(count, "count");
        const h = val<ProbeRect>(heading, "heading");
        // The count's box holds a few characters and cannot wrap, so it is
        // one line tall: the unit both measurements are read against.
        assert.ok(
          m.height < c.height * 1.5,
          `at ${px}px the model id broke across lines: id ${JSON.stringify(m)}, count ${JSON.stringify(c)}`,
        );
        const textHeight =
          h.height -
          Number.parseFloat(val<string>(padTop, "padding-top")) -
          Number.parseFloat(val<string>(padBottom, "padding-bottom"));
        if (textHeight > c.height * 1.5) wrapped++;
      }
      // Some width in the sweep must have wrapped the heading, or the loop
      // above tested nothing.
      assert.ok(wrapped > 0, "no width in 180–320px wrapped the heading");

      const [transform, idText] = await api.probeWebviewForTests([
        {
          verb: "computed",
          selector: `${HEAD} .lm-review-model`,
          name: "text-transform",
        },
        { verb: "text", selector: `${HEAD} .lm-review-model` },
      ]);
      // The seats ran on the suite's bound model, so the id is that one — in
      // its own case, inside a heading that is uppercase.
      assert.strictEqual(val<string>(idText, "id text"), "claude-sonnet-4-5");
      assert.strictEqual(val<string>(transform, "text-transform"), "none");
    });
  },
);
