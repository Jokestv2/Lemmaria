/**
 * R3 (O22): `runEvalTask({prompt: "/review"})` reaches the panel driver with
 * the CLI's own workspace.
 *
 * The live row (L1) drives the panel through exactly this path, so the seam is
 * asserted OFFLINE with a scripted adapter: a seam whose only test costs real
 * money is a seam nobody re-checks (T2's rule, ADR 0043 §D7).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelStreamEvent,
  ReviewItem,
  Skill,
} from "@lemmaria/harness";
import { PANEL_SKILL, REVIEWER_NAMES } from "@lemmaria/harness";
import { afterEach, describe, expect, it } from "vitest";
import { runEvalTask } from "../src/eval/run-eval.js";
import type { EvalTaskSpec } from "../src/eval/scenarios.js";

const PAPER = [
  "\\documentclass{article}",
  "\\begin{document}",
  "We estimate the effect with a two-stage least squares design.",
  "We conclude that the method generalises to every domain we tried.",
  "\\end{document}",
  "",
].join("\n");

const SPEC: EvalTaskSpec = {
  id: "review-probe",
  prompt: "/review",
  requiredGrants: [],
  tools: ["read_span"],
};

const PROTOCOL: Skill = {
  name: PANEL_SKILL,
  description: "the panel protocol",
  body: "quote one whole line",
  source: "bundled",
  path: `/skills/${PANEL_SKILL}/SKILL.md`,
  references: [],
};

/**
 * A reviewer-aware adapter: each reviewer gets a ledger, the cross-review gets
 * a pair.
 *
 * R9: the reviewers are ORDINALS, so it keys on the brief's own
 * *"`reviewer_a`, one of N"* opener rather than R3's seat sentence, and the
 * second reviewer answers with a different anchor so the cross-review has two
 * DIFFERENT reviewers to cite (`interpretSynthesis` refuses anything less).
 */
class PanelAdapter implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly requests: GenerateRequest[] = [];

  private answerFor(req: GenerateRequest): string {
    const first = req.messages.find((m) => m.role === "user");
    const text = typeof first?.content === "string" ? first.content : "";
    const name = REVIEWER_NAMES.find((n) => text.includes(`\`${n}\`, one of `));
    if (name !== undefined) {
      const second = name === REVIEWER_NAMES[1];
      return JSON.stringify({
        impressions: {},
        annotations: [
          {
            dimension: second ? "claims" : "soundness",
            severity: "major",
            anchor: second
              ? "We conclude that the method generalises to every domain we tried."
              : "We estimate the effect with a two-stage least squares design.",
            evidence: "missing",
            message: `${name} concern`,
          },
        ],
      });
    }
    if (text.includes("reviewers have each read")) {
      return JSON.stringify({
        consensus: [
          {
            ids: [`${REVIEWER_NAMES[0]}-1`, `${REVIEWER_NAMES[1]}-1`],
            note: "both flag the design",
          },
        ],
        disagreements: [],
      });
    }
    return "not a reviewer";
  }

  private done(req: GenerateRequest): GenerateResult {
    return {
      text: this.answerFor(req),
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    return Promise.resolve(this.done(req));
  }

  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(req);
    yield { type: "completed", result: this.done(req) };
  }
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function paperDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lemmaria-eval-review-"));
  dirs.push(dir);
  await writeFile(join(dir, "main.tex"), PAPER, "utf8");
  return dir;
}

describe("runEvalTask + /review (O22)", () => {
  it("runs the panel over the eval's own copy of the paper", async () => {
    const adapter = new PanelAdapter();
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: await paperDir(),
      grants: new Map(),
      stub: true,
      adapter,
      readOnly: true,
      skills: [PROTOCOL],
    });
    dirs.push(task.workDir);

    expect(task.outcome.status).toBe("completed");
    const review = task.outcome.items.find(
      (i): i is ReviewItem => i.type === "review",
    );
    expect(review?.status).toBe("completed");
    // Located against the COPY the seats read, not the caller's original.
    expect(review?.result?.annotations.map((a) => a.span.file)).toEqual([
      "main.tex",
      "main.tex",
      "main.tex",
    ]);
    expect(review?.result?.annotations.map((a) => a.id)).toEqual([
      `${REVIEWER_NAMES[0]}-1`,
      `${REVIEWER_NAMES[1]}-1`,
      `${REVIEWER_NAMES[2]}-1`,
    ]);
    expect(review?.result?.synthesis?.consensus).toHaveLength(1);
    // The pre-run check (X5, ADR 0074 §6), three seats and the synthesis —
    // and no parent turn at all. One check, because every child here runs on
    // the eval's single binding.
    expect(adapter.requests).toHaveLength(5);
  });

  it("refuses honestly when the protocol skill was not loaded", async () => {
    const adapter = new PanelAdapter();
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: await paperDir(),
      grants: new Map(),
      stub: true,
      adapter,
      readOnly: true,
    });
    dirs.push(task.workDir);

    expect(
      task.outcome.items.some(
        (i) => i.type === "notice" && i.code === "review.skill_missing",
      ),
    ).toBe(true);
    expect(adapter.requests).toHaveLength(0);
  });
});

describe("runEvalTask + a mixed panel (O17)", () => {
  it("gives each reviewer the binding it was handed, and the cross-review its own", async () => {
    // D9: the CLI is a faithful SECOND caller of the same seam the extension
    // drives, which is what lets L1 run a mixed panel on the real pins — and
    // what keeps this assertable offline, one scripted adapter under three
    // different bindings.
    const adapter = new PanelAdapter();
    const on = (
      protocol: "anthropic" | "openai-compatible",
      model: string,
    ) => ({
      protocol,
      endpoint: "",
      model,
      apiKey: "k",
    });
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: await paperDir(),
      grants: new Map(),
      stub: true,
      adapter,
      readOnly: true,
      skills: [PROTOCOL],
      reviewers: [
        on("openai-compatible", "gpt-5.6-luna"),
        on("anthropic", "claude-haiku-4-5-20251001"),
        on("openai-compatible", "gpt-5.6-luna"),
      ],
      synthesis: on("openai-compatible", "gpt-5.6-luna"),
    });
    dirs.push(task.workDir);

    const review = task.outcome.items.find(
      (i): i is ReviewItem => i.type === "review",
    );
    expect(review?.status).toBe("completed");
    // §D4: the record says which model each reviewer ran on, which is what
    // makes its agreement interpretable at all.
    expect(review?.seats.map((s) => `${s.reviewer}=${s.model}`)).toEqual([
      `${REVIEWER_NAMES[0]}=gpt-5.6-luna`,
      `${REVIEWER_NAMES[1]}=claude-haiku-4-5-20251001`,
      `${REVIEWER_NAMES[2]}=gpt-5.6-luna`,
    ]);
    expect(review?.synthesisSeat?.model).toBe("gpt-5.6-luna");
    expect(review?.result?.synthesis?.consensus).toHaveLength(1);
  });

  it("takes a count from `reviewers` alone, on the task's own model", async () => {
    const adapter = new PanelAdapter();
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: await paperDir(),
      grants: new Map(),
      stub: true,
      adapter,
      readOnly: true,
      skills: [PROTOCOL],
      reviewers: [],
      synthesis: {
        protocol: "openai-compatible",
        endpoint: "",
        model: "gpt-5.6-luna",
        apiKey: "k",
      },
    });
    dirs.push(task.workDir);
    const review = task.outcome.items.find(
      (i): i is ReviewItem => i.type === "review",
    );
    // An empty list is not zero reviewers — it is "no opinion", which the
    // harness answers with its own default. Zero reviewers is not a panel.
    expect(review?.seats).toHaveLength(3);
    expect(review?.seats.every((s) => s.model === "claude-sonnet-4-5")).toBe(
      true,
    );
    // …while the cross-review still goes where it was sent.
    expect(review?.synthesisSeat?.model).toBe("gpt-5.6-luna");
  });
});
