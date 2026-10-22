/**
 * X5 (O18): the milestone's headline claim, end to end, without a model.
 *
 * The round X5 answers lost 33 of 37 dropped anchors to one cause — quotes
 * copied from an `\input`-ed section file, searched for in an entry that holds
 * only the preamble. This file drives the SPLIT fixture through the retained
 * eval driver with a scripted panel whose ledger quotes from those section
 * files, and asserts the concerns arrive and are credited.
 *
 * It is the offline half of the stage gate's claim 1. Its sibling
 * `planted-defects-split-fixture.test.ts` proves the fixture *is* the flat one
 * cut; this one proves the panel can read it. Neither costs a token, which is
 * the point: before X5 this measurement existed only in the live tier, where
 * it was paid for and therefore rarely re-run.
 *
 * The `PanelAdapter` technique is `planted-defects-scenario.test.ts`'s, and
 * deliberately so — two scripted panels that script differently would make the
 * flat/split comparison a comparison of the scripts.
 */
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelStreamEvent,
  Skill,
} from "@lemmaria/harness";
import { PANEL_SKILL } from "@lemmaria/harness";
import { afterEach, describe, expect, it } from "vitest";
import { readManifest } from "../../src/eval/recall.js";
import { formatEvalReport, runFlagshipEval } from "../../src/eval/run-eval.js";
import { scenarioById } from "../../src/eval/scenarios.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../live/fixtures/planted-defects-split");
const PAPER = resolve(FIXTURE, "paper");

const PROTOCOL: Skill = {
  name: PANEL_SKILL,
  description: "the panel protocol",
  body: "quote one whole line",
  source: "bundled",
  path: `/skills/${PANEL_SKILL}/SKILL.md`,
  references: [],
};

/** The scripted panel, keyed by the seat's own brief. */
class PanelAdapter implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly briefs: string[] = [];
  constructor(private readonly ledgers: Map<string, string>) {}

  private answer(request: GenerateRequest): string {
    const first = request.messages.find((m) => m.role === "user");
    const text = typeof first?.content === "string" ? first.content : "";
    this.briefs.push(text);
    for (const [key, body] of this.ledgers) {
      if (text.includes(key)) return body;
    }
    // X5's pre-run check, which asks every distinct binding one minimal
    // question before a seat is carved, and the third reviewer, which raises
    // nothing. An empty ledger answers both; the check ignores the text.
    return '{"annotations": [], "impressions": {}}';
  }

  private done(request: GenerateRequest): GenerateResult {
    return {
      text: this.answer(request),
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  generate(request: GenerateRequest): Promise<GenerateResult> {
    return Promise.resolve(this.done(request));
  }

  async *generateStream(
    request: GenerateRequest,
  ): AsyncIterable<ModelStreamEvent> {
    yield { type: "completed", result: this.done(request) };
  }
}

function ledger(
  entries: Array<{ anchor: string; file?: string; evidence: string }>,
): string {
  return JSON.stringify({
    impressions: {},
    annotations: entries.map((e, i) => ({
      dimension: "soundness",
      severity: "major",
      anchor: e.anchor,
      ...(e.file !== undefined ? { file: e.file } : {}),
      evidence: { anchor: e.evidence },
      message: `concern ${i + 1}`,
    })),
  });
}

const trash: string[] = [];
afterEach(async () => {
  for (const dir of trash.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("X5 O18 — the panel reads an `\\input`-split paper through the driver", () => {
  /** Run the split scenario with a panel scripted from the manifest itself. */
  async function run(how: { nameTheFile: boolean }) {
    const scenario = scenarioById("planted-defects-split");
    if (scenario === undefined) throw new Error("scenario missing");
    const manifest = await readManifest(resolve(FIXTURE, "defects.json"));
    const spanOf = (id: string) => {
      const defect = manifest.defects.find((d) => d.id === id);
      const span = defect?.spans[0];
      if (span === undefined) throw new Error(`no defect ${id}`);
      return span;
    };
    const entry = (id: string) => {
      const span = spanOf(id);
      return {
        anchor: span.anchor,
        ...(how.nameTheFile && span.file !== undefined
          ? { file: span.file }
          : {}),
        evidence: span.anchor,
      };
    };
    const adapter = new PanelAdapter(
      new Map([
        ["`reviewer_a`, one of", ledger([entry("S1"), entry("C2")])],
        ["`reviewer_b`, one of", ledger([entry("S1"), entry("R3")])],
        [
          // The cross-review, scripted so the run reaches `panel_located`
          // rather than `panel_partial`. Both seats raised S1, which is what
          // gives it two different reviewers to cite.
          "reviewers have each read",
          JSON.stringify({
            consensus: [
              {
                ids: ["reviewer_a-1", "reviewer_b-1"],
                note: "both raise the same equation",
              },
            ],
            disagreements: [],
          }),
        ],
      ]),
    );
    const report = await runFlagshipEval({
      scenario,
      paperDir: PAPER,
      grants: new Map(),
      stub: false,
      readOnly: true,
      skills: [PROTOCOL],
      adapter,
      manifest,
    });
    if (report.workDir !== undefined) trash.push(report.workDir);
    return { report, adapter, text: formatEvalReport(report) };
  }

  it("credits concerns quoted from section files, when the seat names them", async () => {
    // Three distinct defects, every one of them anchored OUTSIDE the entry:
    // S1 and C2 in `sections/method.tex` and the tables, R3 further in. Before
    // X5 every one of these dropped, because the locator searched `main.tex`
    // and stopped there.
    const { report, text } = await run({ nameTheFile: true });
    expect(text).toContain("recall overall: 3/16");
    expect(text).toContain("panel outcome: panel_located");
    // Reported, never gated (ADR 0070 §5): what fails is the run not
    // happening, and it happened.
    expect(report.verdict.pass).toBe(true);
    // Nothing dropped: the whole point. `anchors located` is per concern, and
    // all four sent concerns located.
    expect(text).toContain("anchors located: 4/4");
  });

  it("credits them EVEN WHEN the seat names no file at all", async () => {
    // §1's relocation half. A reviewer that forgets the `file` — which the
    // round's reviewers routinely did — still gets its concern placed, because
    // an anchor unique in the manuscript supplies no position and the harness
    // finds where it is. Identical numbers to the run above: that identity IS
    // the claim.
    const { report, text } = await run({ nameTheFile: false });
    expect(text).toContain("recall overall: 3/16");
    expect(text).toContain("anchors located: 4/4");
    expect(report.verdict.pass).toBe(true);
  });

  it("tells the seats the manuscript's files, in reading order", async () => {
    // The brief is the other half of the fix: a reviewer told only
    // "the manuscript's main file is main.tex" reads a preamble. The order is
    // the include graph's, so a seat that reads top-down reads the paper.
    const { adapter } = await run({ nameTheFile: true });
    const brief = adapter.briefs.find((b) =>
      b.includes("`reviewer_a`, one of"),
    );
    expect(brief).toBeDefined();
    const at = (rel: string) => (brief ?? "").indexOf(rel);
    for (const rel of [
      "main.tex",
      "sections/introduction.tex",
      "sections/method.tex",
      "tables/main-results.tex",
      "sections/conclusion.tex",
    ]) {
      expect(`${rel}: ${at(rel) >= 0}`).toBe(`${rel}: true`);
    }
    expect(at("sections/introduction.tex")).toBeLessThan(
      at("sections/method.tex"),
    );
    expect(at("sections/method.tex")).toBeLessThan(
      at("tables/main-results.tex"),
    );
    expect(at("tables/main-results.tex")).toBeLessThan(
      at("sections/conclusion.tex"),
    );
  });

  it("keeps the answer key out of the workspace the reviewers read", async () => {
    // Same rule as the flat fixture (ADR 0070 §3), re-asserted because the
    // split fixture is a NEW directory and the copy is by directory: a
    // manifest that leaked in would hand the panel its own answer key, and
    // every number above would be meaningless rather than wrong.
    const { adapter } = await run({ nameTheFile: true });
    for (const brief of adapter.briefs) {
      expect(brief).not.toContain("defects.json");
      expect(brief).not.toContain('"tell"');
    }
  });
});
