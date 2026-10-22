/**
 * T2: the two seams that let the live tier observe a run (ADR 0043 §D7).
 *
 * Both are asserted OFFLINE, with a scripted adapter and no key, because what
 * they promise is a property of the driver rather than of a model — and a seam
 * whose only test costs real money is a seam nobody re-checks.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelStreamEvent,
  Skill,
} from "@lemmaria/harness";
import {
  protectedSpanRefusal,
  undeclarableRemovalRefusal,
} from "@lemmaria/harness";
import { afterEach, describe, expect, it } from "vitest";
import { runEvalTask } from "../src/eval/run-eval.js";
import type { EvalTaskSpec } from "../src/eval/scenarios.js";
import {
  protectedRefusalPrefix,
  undeclarableRefusalPrefix,
} from "./live/observe.js";

const PAPER =
  "\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n";

const SPEC: EvalTaskSpec = {
  id: "seam-probe",
  prompt: "What does this paper say?",
  requiredGrants: [],
  tools: ["read_span"],
};

/** Answers nothing and remembers everything it was asked. */
class RecordingAdapter implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly requests: GenerateRequest[] = [];

  private done(): GenerateResult {
    return {
      text: "ok",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    return Promise.resolve(this.done());
  }

  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(req);
    yield { type: "text_delta", text: "ok" };
    yield { type: "completed", result: this.done() };
  }
}

/** Every system message of the first request, joined. */
function systemOf(adapter: RecordingAdapter): string {
  return (adapter.requests[0]?.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function paperDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lemmaria-seam-"));
  dirs.push(dir);
  await writeFile(join(dir, "main.tex"), PAPER, "utf8");
  return dir;
}

describe("EvalTaskOptions.adapter (T2)", () => {
  it("runs the injected adapter instead of building one from the protocol", async () => {
    const adapter = new RecordingAdapter();
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: await paperDir(),
      grants: new Map(),
      stub: true,
      adapter,
    });
    dirs.push(task.workDir);
    expect(task.outcome.status).toBe("completed");
    expect(adapter.requests.length).toBeGreaterThan(0);
  });

  it("exposes WHAT THE MODEL WAS ASKED — the half ADR 0038 §2 could not reach", async () => {
    // The point of the seam. Before it, a live test could only infer the system
    // prompt's branch from the answer; now the request itself is assertable.
    const adapter = new RecordingAdapter();
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: await paperDir(),
      grants: new Map(),
      stub: true,
      adapter,
    });
    dirs.push(task.workDir);

    const first = adapter.requests[0];
    expect(first, "no request was recorded").toBeDefined();
    const system = (first?.messages ?? [])
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(system.length).toBeGreaterThan(0);

    // The driver LOOP-INJECTS `propose_edit` whenever an editHost is present,
    // ignoring `scenario.tools` — pinned here because it is not obvious from
    // the scenario, and because the next test is about what it cost.
    const toolNames = (first?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("read_span");
    expect(toolNames).toContain("propose_edit");

    // The user's own words reach the model unaltered (invariant 6 rule 1).
    const user = (first?.messages ?? [])
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    expect(user).toContain(SPEC.prompt);
  });
});

/**
 * The precondition of D4's live row L1, pinned offline.
 *
 * **The finding this exists for.** `quick-action-names.live.test.ts` asserts
 * that a model never names a RETIRED quick action, and its own comment says the
 * scenario must have no write path *"because that is the only branch of the
 * system prompt that names the quick actions… Offering `propose_edit` here
 * would take the other branch and the test would pass for the wrong reason."*
 * It did: the driver always passed an `editHost`, so `editPolicy` was never
 * `undefined`, the branch never fired, and the model was never given ANY action
 * name — making an assertion that no name appeared unfailable.
 *
 * A live test cannot guard its own precondition (it costs money and needs a
 * key). These two rows do it for free, and they fail loudly if the branch ever
 * stops being reachable again.
 */
describe("EvalTaskOptions.literatureProviders (V2, ADR 0078 §D13)", () => {
  /** Searches once, then stops. Offline: it answers out of nothing. */
  class SearchingAdapter implements ModelAdapter {
    readonly protocol = "anthropic" as const;
    private turn = 0;

    private next(): GenerateResult {
      this.turn += 1;
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (this.turn > 1) {
        return { text: "done", toolCalls: [], stopReason: "stop", usage };
      }
      return {
        text: "",
        toolCalls: [
          {
            id: "call-1",
            name: "literature_search" as const,
            args: { query: "widget representations" },
          },
        ],
        stopReason: "tool_use",
        usage,
      };
    }

    generate(): Promise<GenerateResult> {
      return Promise.resolve(this.next());
    }

    async *generateStream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "completed", result: this.next() };
    }
  }

  it("wins over the STUB set, which is what `whatever else is set` means", async () => {
    // The companion case to `offline-by-construction.test.ts`, which drives
    // the same seam with `stub: false` — the shape that would otherwise build
    // the four real providers. Together the two cover both fallbacks the
    // option overrides; neither covers both on its own.
    const asked: string[] = [];
    const task = await runEvalTask({
      scenario: { ...SPEC, tools: ["literature_search"] },
      paperDir: await paperDir(),
      grants: new Map(),
      stub: true,
      adapter: new SearchingAdapter(),
      literatureProviders: [
        {
          name: "arxiv",
          endpoint: "injected://no-network",
          search: async (q) => {
            asked.push(q.query);
            return { kind: "ok", results: [] };
          },
        },
      ],
    });
    dirs.push(task.workDir);

    expect(asked).toEqual(["widget representations"]);
    // `stub.invalid` is the stub set's host. Its absence is the override.
    const results = task.outcome.items
      .filter((i) => i.type === "tool_call" && i.tool === "literature_search")
      .map((i) => (i.type === "tool_call" ? i.resultJson : undefined));
    expect(results).toHaveLength(1);
    expect(results[0]).toContain("injected://no-network");
    expect(results[0]).not.toContain("stub.invalid");
  });
});

describe("EvalTaskOptions.readOnly (T2) — L1's precondition", () => {
  it("with a write path, the quick-action names are NOT in the prompt", async () => {
    const adapter = new RecordingAdapter();
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: await paperDir(),
      grants: new Map(),
      stub: true,
      adapter,
    });
    dirs.push(task.workDir);
    const system = systemOf(adapter);
    expect(system).toContain("use the propose_edit tool");
    expect(system).not.toContain("point them to the quick actions");
  });

  it("read-only, the branch fires and the action names reach the model", async () => {
    const adapter = new RecordingAdapter();
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: await paperDir(),
      grants: new Map(),
      stub: true,
      readOnly: true,
      adapter,
    });
    dirs.push(task.workDir);

    const toolNames = (adapter.requests[0]?.tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain("propose_edit");

    const system = systemOf(adapter);
    expect(system).toContain("point them to the quick actions");
    // The names themselves — this is the string L1 exists to police, and if it
    // is absent the live assertion is measuring nothing.
    expect(system).toContain("Shrink By");
    expect(system).toContain("Expand By");
  });
});

describe("EvalTaskResult.sessionId (T2)", () => {
  it("names the session the run wrote, so its event stream is reachable", async () => {
    // Without it a caller had to list `<workDir>/sessions` and guess which
    // `<id>.jsonl` was theirs — fine with one run, wrong the moment a scenario
    // does two.
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: await paperDir(),
      grants: new Map(),
      stub: true,
      adapter: new RecordingAdapter(),
    });
    dirs.push(task.workDir);
    expect(typeof task.sessionId).toBe("string");
    expect(task.sessionId.length).toBeGreaterThan(0);
  });
});

/**
 * The derived refusal prefixes, pinned OFFLINE (T2).
 *
 * `observe.ts` derives them by handing a sentinel to the product's own refusal
 * builders and taking the text in front of it, which replaced two copied
 * English literals. That derivation has a silent failure mode of its own: if a
 * builder ever transforms its argument so the sentinel does not survive, or the
 * sentence is reworded so the prefix is empty, a live `startsWith` check
 * matches nothing and PASSES. A live test cannot guard that — it costs money
 * and a key — so it is guarded here, for free, exactly as `readOnly`'s
 * precondition is.
 */
describe("observe.ts derived refusal prefixes (T2)", () => {
  it("derives a non-empty prefix that the real refusal actually starts with", () => {
    const prefix = protectedRefusalPrefix("comment");
    expect(prefix.length).toBeGreaterThan(0);
    // Built the way the engine builds it, from a different span than the
    // sentinel one, so a prefix that accidentally captured the sentinel fails.
    const real = protectedSpanRefusal({
      file: "sections/introduction.tex",
      startOffset: 0,
      endOffset: 12,
      kind: "comment",
      token: "t0",
      raw: "% TODO(kz): drop this",
    });
    expect(real.startsWith(prefix)).toBe(true);
    expect(prefix).not.toContain("lemmaria-probe");
    // The kind is inside the prefix, which is what makes it discriminating:
    // a refusal about a math span must NOT match the comment prefix.
    const mathRefusal = protectedSpanRefusal({
      file: "sections/introduction.tex",
      startOffset: 0,
      endOffset: 12,
      kind: "math",
      token: "t1",
      raw: "$x_1$",
    });
    expect(mathRefusal.startsWith(prefix)).toBe(false);
  });

  it("does the same for the undeclarable-removal refusal", () => {
    const prefix = undeclarableRefusalPrefix();
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix).not.toContain("lemmaria-probe");
    expect(
      undeclarableRemovalRefusal("\textbf{measurement decision}").startsWith(
        prefix,
      ),
    ).toBe(true);
  });
});

/**
 * R1 (ADR 0059), tier-table row 15 — the live scenario's plumbing, offline.
 *
 * `runEvalTask` passes `skills` to the PARENT only; children are built by
 * `run.ts` exactly as in production. That is one hop more than any earlier eval
 * exercised, and it is the hop the live scenario spends real money on — so it
 * is asserted here first, with a scripted adapter and no key. A live run that
 * fails should mean *the model did not equip*, never *the driver did not
 * thread*.
 */
describe("the eval driver threads skills into a child (R1)", () => {
  const LEDGER: Skill = {
    name: "concern-ledger",
    description: "How to write a reviewer's concern ledger.",
    body: "Prefix every concern id with CL-.",
    source: "project",
    path: ".lemmaria/skills/concern-ledger/SKILL.md",
    references: [],
  };

  /**
   * A parent that fans out one equipped child, and a child that loads what it
   * was given. Dispatches on the last user message, so one adapter drives both
   * (the `scriptedByKey` shape from `run.test.ts`).
   */
  class FanOutAdapter implements ModelAdapter {
    readonly protocol = "anthropic" as const;
    private turn = new Map<string, number>();

    private next(req: GenerateRequest): GenerateResult {
      const lastUser = [...req.messages]
        .reverse()
        .find((m) => m.role === "user");
      const key = typeof lastUser?.content === "string" ? lastUser.content : "";
      const n = this.turn.get(key) ?? 0;
      this.turn.set(key, n + 1);
      const usage = { inputTokens: 1, outputTokens: 1 };

      const isParent = key.includes("Review this paper");
      if (isParent && n === 0) {
        return {
          text: "",
          toolCalls: [
            {
              id: "s0",
              name: "spawn_subtask",
              args: {
                children: [
                  { goal: "review the abstract", skills: ["concern-ledger"] },
                ],
              },
            },
          ],
          stopReason: "tool_use",
          usage,
        };
      }
      if (!isParent && n === 0) {
        return {
          text: "",
          toolCalls: [
            { id: "c0", name: "load_skill", args: { name: "concern-ledger" } },
          ],
          stopReason: "tool_use",
          usage,
        };
      }
      return {
        text: isParent ? "relayed" : "CL-1 · Minor · thin · more data",
        toolCalls: [],
        stopReason: "stop",
        usage,
      };
    }

    generate(req: GenerateRequest): Promise<GenerateResult> {
      return Promise.resolve(this.next(req));
    }

    async *generateStream(
      req: GenerateRequest,
    ): AsyncIterable<ModelStreamEvent> {
      const result = this.next(req);
      if (result.text) yield { type: "text_delta", text: result.text };
      yield { type: "completed", result };
    }
  }

  it("records the equipped child's skills in the persisted report", async () => {
    const task = await runEvalTask({
      scenario: {
        id: "r1-seam",
        prompt: "Review this paper's abstract with the concern-ledger skill.",
        requiredGrants: [],
        tools: ["read_span", "get_outline"],
      },
      paperDir: await paperDir(),
      grants: new Map(),
      stub: true,
      readOnly: true,
      skills: [LEDGER],
      adapter: new FanOutAdapter(),
    });
    dirs.push(task.workDir);

    const subtask = task.outcome.items.find((i) => i.type === "subtask");
    expect(subtask?.type).toBe("subtask");
    if (subtask?.type !== "subtask") return;

    // The whole point of the row: `skills` survived parent -> spawn_subtask ->
    // runChild -> the child's surface -> back into the record.
    expect(subtask.reports[0]?.skills).toEqual(["concern-ledger"]);
    expect(subtask.reports[0]?.allowedTools).toContain("load_skill");
    expect(subtask.reports[0]?.status).toBe("completed");
    // And the child really could load it — an equipped child whose load_skill
    // failed would still report `skills`, so the summary is what separates
    // *equipped* from *equipped and loaded*.
    expect(subtask.reports[0]?.summary).toContain("CL-1");
  });
});
