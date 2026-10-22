/**
 * ADR 0035's offline tier is offline BY CONSTRUCTION — this is the guard.
 *
 * `run-eval.ts` has named this file in a comment since R5 (*"ADR 0035's offline
 * tier is supposed to be offline BY CONSTRUCTION; this is the construction.
 * `offline-by-construction.test.ts` is the guard."*) and the file did not
 * exist. V2 wrote it, because O25 needs exactly this assertion and a comment
 * promising a guard that is not there is worse than no comment: it is a reason
 * not to look.
 *
 * What it pins is a property rather than a line of code: **no offline run
 * constructs a provider that could reach a scholarly index.** Each real
 * provider carries its host in `endpoint`, and every search reports the
 * endpoints it actually used, so the test reads what the run built instead of
 * trusting the branch that built it.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  GenerateRequest,
  GenerateResult,
  LiteratureProvider,
  ModelAdapter,
  ModelStreamEvent,
  SessionItem,
} from "@lemmaria/harness";
import { afterEach, describe, expect, it } from "vitest";
import { runEvalTask } from "../../src/eval/run-eval.js";
import type { EvalTaskSpec } from "../../src/eval/scenarios.js";
import { scenarioById } from "../../src/eval/scenarios.js";

const PAPER =
  "documentclass{article}\title{A Study Of Nothing}\n\begin{document}\nHello.\nend{document}\n";

/** V3 (O22): the marker fixture's paper, which ships its own compiled PDF. */
const VISUAL_PAPER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../live/fixtures/visual-defects/paper",
);
const MARKER_PAPER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../live/fixtures/pdf-marker/paper",
);

/** A scenario that carries `literature_search`, so the seam is built at all. */
const SPEC: EvalTaskSpec = {
  id: "offline-probe",
  prompt: "What has been written about widgets?",
  requiredGrants: [],
  tools: ["literature_search"],
};

/** Every host one of the four real providers would talk to. */
const REAL_HOSTS = [
  "api.crossref.org",
  "dblp.org",
  "export.arxiv.org",
  "api.semanticscholar.org",
];

/** Searches once, then stops. Offline: it answers from nothing. */
class SearchingAdapter implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  private turn = 0;

  private next(): GenerateResult {
    this.turn += 1;
    const usage = { inputTokens: 1, outputTokens: 1 };
    if (this.turn === 1) {
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
    return { text: "done", toolCalls: [], stopReason: "stop", usage };
  }

  generate(_req: GenerateRequest): Promise<GenerateResult> {
    return Promise.resolve(this.next());
  }

  async *generateStream(
    _req: GenerateRequest,
  ): AsyncIterable<ModelStreamEvent> {
    const result = this.next();
    yield { type: "completed", result };
  }
}

/** A provider that records what it was asked, and answers without a network. */
function recordingProvider(asked: string[]): LiteratureProvider {
  return {
    // Named after a REAL source on purpose: the injection has to win by being
    // injected, not by being distinguishable.
    name: "arxiv",
    endpoint: "injected://no-network",
    search: async (q) => {
      asked.push(q.query);
      return {
        kind: "ok",
        results: [
          {
            title: "A Paper The Test Injected",
            authors: ["Roe, Alex"],
            source: "arxiv",
          },
        ],
      };
    },
  };
}

/** The endpoints a run's literature searches actually reported using. */
function endpointsOf(items: readonly SessionItem[]): string[] {
  return items
    .filter((i) => i.type === "tool_call" && i.tool === "literature_search")
    .flatMap((i) => {
      const raw = i.type === "tool_call" ? i.resultJson : undefined;
      if (raw === undefined) return [];
      const parsed = JSON.parse(raw) as {
        sources?: { endpoint: string }[];
      };
      return (parsed.sources ?? []).map((s) => s.endpoint);
    });
}

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function paperDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lemmaria-offline-"));
  dirs.push(dir);
  await writeFile(join(dir, "main.tex"), PAPER, "utf8");
  return dir;
}

describe("no offline run builds a provider that could reach an index", () => {
  it("uses INJECTED providers over the stub set (V2, ADR 0078 §D13)", async () => {
    const asked: string[] = [];
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: await paperDir(),
      grants: new Map(),
      stub: false,
      adapter: new SearchingAdapter(),
      literatureProviders: [recordingProvider(asked)],
    });
    dirs.push(task.workDir);

    // `stub: false` is the shape that would otherwise construct the four real
    // providers, so this proves the injection WINS rather than merely agreeing
    // with a fallback that was going to be offline anyway.
    expect(asked).toEqual(["widget representations"]);
    expect(endpointsOf(task.outcome.items)).toEqual(["injected://no-network"]);
  });

  it("builds the STUB set when an adapter is injected and `stub` is false", async () => {
    // The F12 claim as its own case: an injected adapter makes the run offline,
    // so the real four must not be constructed.
    //
    // Asserted on the ENDPOINTS, deliberately, and not on `liveBinding`
    // throwing for a missing key. A machine with `LEMMARIA_SMOKE_OPENAI_KEY`
    // exported — the operator's, where the live tier runs — resolves a binding
    // happily and reaches the network anyway, so a key-shaped assertion would
    // pass there for the wrong reason. Verified by mutation: reverting
    // `offline` to `opts.stub` alone fails this line with
    // `expected 'https://api.crossref.org'`, on this machine, key and all.
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: await paperDir(),
      grants: new Map(),
      stub: false,
      adapter: new SearchingAdapter(),
    });
    dirs.push(task.workDir);
    expect(task.outcome.status).toBe("completed");
    // The stub set, whole and in order — NOT a `for` loop over the endpoints
    // asserting each matches `stub.invalid`. That loop is green over an empty
    // list, so a change that stopped the search reaching the registry at all
    // would leave the test passing with nothing to say. Exact equality cannot
    // be satisfied vacuously, and it pins the stub set at the same time.
    expect(endpointsOf(task.outcome.items)).toEqual([
      "https://stub.invalid/crossref",
      "https://stub.invalid/dblp",
      "https://stub.invalid/arxiv",
      "https://stub.invalid/s2",
    ]);
  });

  it("names no real scholarly host anywhere in an offline run", async () => {
    // Asserted over the WHOLE item stream rather than the endpoint list, so a
    // fifth provider added later, or a host reached by some path this file did
    // not anticipate, is covered without this test naming it.
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: await paperDir(),
      grants: new Map(),
      stub: true,
      adapter: new SearchingAdapter(),
    });
    dirs.push(task.workDir);
    const stream = JSON.stringify(task.outcome.items);
    // The search has to have HAPPENED for its absence of real hosts to mean
    // anything — `filter` over a stream that never searched returns `[]` and
    // proves nothing.
    expect(stream).toContain("literature_search");
    expect(REAL_HOSTS.filter((h) => stream.includes(h))).toEqual([]);
  });
});

describe("V3 (O22): the visual door reaches nothing either", () => {
  it("loads PDFium's WASM from DISK, never over the wire", async () => {
    // The hazard is specific and common: a WASM module's own loader typically
    // fetches its `.wasm` from a URL, and PDFium's does read `import.meta.url`
    // to find itself. If it resolved to anything but a local path, every
    // offline run of the marker scenario would be reaching out — and nothing
    // in the suite would say so, because the run would still pass.
    const { pdfiumWasmPath } = await import("@lemmaria/adapters/pdfium-wasm");
    const path = pdfiumWasmPath();
    expect(path.startsWith("http")).toBe(false);
    expect(path.startsWith("file:")).toBe(false);
    // It is a real file, and it is the one inside the dependency.
    expect(path).toContain("pdfium");
    expect((await readFile(path)).byteLength).toBeGreaterThan(1_000_000);
  });

  it("names no real scholarly host in a stub run of the marker scenario", async () => {
    const scenario = scenarioById("pdf-marker");
    if (scenario === undefined) throw new Error("no pdf-marker scenario");
    const { createPdfiumRenderer } = await import("@lemmaria/adapters");
    const { pdfiumWasmPath } = await import("@lemmaria/adapters/pdfium-wasm");

    const task = await runEvalTask({
      scenario,
      paperDir: MARKER_PAPER,
      grants: new Map(),
      stub: true,
      readOnly: true,
      pdfRenderer: createPdfiumRenderer(
        new Uint8Array(await readFile(pdfiumWasmPath())),
      ),
    });
    dirs.push(task.workDir);

    const stream = JSON.stringify(task.outcome.items);
    // The door has to have OPENED for the absence below to mean anything —
    // the same rule the literature case states, for the same reason.
    expect(stream).toContain("view_pdf_pages");
    expect(task.pdf?.viewed).toEqual([1]);
    expect(REAL_HOSTS.filter((h) => stream.includes(h))).toEqual([]);
  });
});

describe("V4 (O24): the PDF reviewer reaches nothing either", () => {
  it("names no real scholarly host in a stub run of the visual-defects scenario", async () => {
    const scenario = scenarioById("visual-defects");
    if (scenario === undefined) throw new Error("no visual-defects scenario");
    const { createPdfiumRenderer } = await import("@lemmaria/adapters");
    const { pdfiumWasmPath } = await import("@lemmaria/adapters/pdfium-wasm");
    const { listSkills } = await import("@lemmaria/harness");
    const { bundledSkillsDir } = await import(
      "@lemmaria/harness/bundled-skills"
    );

    const task = await runEvalTask({
      scenario,
      paperDir: VISUAL_PAPER,
      grants: new Map(),
      stub: true,
      readOnly: true,
      skills: (await listSkills({ bundledDir: bundledSkillsDir() })).skills,
      pdfRenderer: createPdfiumRenderer(
        new Uint8Array(await readFile(pdfiumWasmPath())),
      ),
    });
    dirs.push(task.workDir);

    // The seat has to have LOOKED for the absence below to mean anything.
    expect(task.pdf?.viewed).toEqual([1, 2, 3]);
    const stream = JSON.stringify(task.outcome.items);
    expect(REAL_HOSTS.filter((h) => stream.includes(h))).toEqual([]);
    // A whole run plus the WASM and the shipped skills: more than vitest's
    // five-second default under a full suite's load.
  }, 30_000);
});
