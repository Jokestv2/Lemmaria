/**
 * `lemmaria eval` — the A6 flagship eval command.
 *
 * Offline (`--stub`) it runs in the gate; live it is what the operator points
 * at the private fixture set with `LEMMARIA_SMOKE_*` keys set. Keys are read
 * from the environment and never accepted as flags, so a shell history never
 * holds one (the M1/S4 smoke convention).
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type ModelBinding,
  type PdfRenderer,
  type Protocol,
  type Skill,
  listSkills,
} from "@lemmaria/harness";
import { bundledSkillsDir } from "@lemmaria/harness/bundled-skills";
import { type DefectManifest, readManifest } from "./recall.js";
import {
  DEFAULT_LIVE_MODEL,
  DEFAULT_LIVE_PROTOCOL,
  type EvalReport,
  formatEvalReport,
  liveBinding,
  runFlagshipEval,
} from "./run-eval.js";
import {
  EVIDENCE_SCENARIOS,
  FLAGSHIP_SCENARIOS,
  VISUAL_SCENARIOS,
  evidenceScenario,
  scenarioById,
  visualScenario,
} from "./scenarios.js";
import { type VisualManifest, readVisualManifest } from "./visual.js";

export const EVAL_USAGE = `usage: lemmaria eval --scenario <id> --paper <dir> [--grant <id>=<path>]... [--stub]
                    [--protocol openai-compatible|anthropic] [--model <id>] [--json]
                    [--defects <path>]
                    [--max-turns N] [--max-tool-calls N] [--max-output-tokens N]

budget:    the three --max-* flags are per-field CEILINGS: each raises or lowers
           the default (12 turns, 24 tool calls, 16000 output tokens) for this
           run. A panel divides the output ceiling across its seats, so raising
           it is how a large repo or a long manuscript gets room.

scenarios: ${FLAGSHIP_SCENARIOS.map((s) => s.id).join(", ")}
           (or --scenario all, which is those three)

evidence:  ${EVIDENCE_SCENARIOS.map((s) => s.id).join(", ")}
           measures the review panel against planted defects; needs the
           manifest, read from <paper>/../defects.json unless --defects names
           another path. Never part of --scenario all: it spends a whole panel.

visual:    ${VISUAL_SCENARIOS.map((s) => s.id).join(", ")}
           the PDF reviewer alone on a compiled paper with planted page
           defects; reads <paper>/../visual.json unless --defects names another
           path.

model:     --protocol defaults to ${DEFAULT_LIVE_PROTOCOL}; with no --model at all a live
           run binds ${DEFAULT_LIVE_MODEL} on it. Name both to drive anything else.

Live runs need LEMMARIA_SMOKE_OPENAI_KEY (or, for --protocol anthropic,
LEMMARIA_SMOKE_ANTHROPIC_KEY) in the environment; --stub runs offline with a
scripted model and touches no network.`;

export async function evalCommand(
  rest: string[],
  io: { log: (line: string) => void },
): Promise<number> {
  let values: {
    scenario?: string;
    paper?: string;
    grant?: string[];
    stub?: boolean;
    protocol?: string;
    model?: string;
    json?: boolean;
    defects?: string;
    "max-turns"?: string;
    "max-tool-calls"?: string;
    "max-output-tokens"?: string;
  };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        scenario: { type: "string" },
        paper: { type: "string" },
        grant: { type: "string", multiple: true },
        stub: { type: "boolean" },
        protocol: { type: "string" },
        model: { type: "string" },
        json: { type: "boolean" },
        defects: { type: "string" },
        "max-turns": { type: "string" },
        "max-tool-calls": { type: "string" },
        "max-output-tokens": { type: "string" },
      },
    }));
  } catch (error) {
    io.log(`${(error as Error).message}`);
    io.log(EVAL_USAGE);
    return 1;
  }

  if (!values.scenario || !values.paper) {
    io.log(`missing required flags: --scenario, --paper\n${EVAL_USAGE}`);
    return 1;
  }

  const scenarios =
    values.scenario === "all"
      ? [...FLAGSHIP_SCENARIOS]
      : [scenarioById(values.scenario)].filter((s) => s !== undefined);
  if (scenarios.length === 0) {
    io.log(`unknown scenario "${values.scenario}"\n${EVAL_USAGE}`);
    return 1;
  }

  const grants = new Map<string, string>();
  for (const pair of values.grant ?? []) {
    const at = pair.indexOf("=");
    if (at <= 0) {
      io.log(`invalid --grant "${pair}" (expected <id>=<path>)`);
      return 1;
    }
    grants.set(pair.slice(0, at), resolve(pair.slice(at + 1)));
  }

  const ceilings = numericCeilings(values);
  let binding: ModelBinding | undefined;
  try {
    binding = liveBindingFrom(values);
  } catch (error) {
    io.log((error as Error).message);
    return 1;
  }
  // R5: ground truth for a scenario that measures the panel, and the SHIPPED
  // skills for one that needs the bundled protocol. Both are resolved once,
  // before any spend — a manifest that cannot be read is a usage error, not a
  // run that produces an unreadable number.
  const paperDir = resolve(values.paper);
  // Keyed by scenario id, not held in one variable: `EVIDENCE_SCENARIOS` has
  // one entry today, and a second would silently hand every scenario the last
  // one's ground truth — a wrong number that still looks like a measurement,
  // which is the failure this whole module exists to prevent.
  const manifests = new Map<string, DefectManifest | VisualManifest>();
  let skills: Skill[] | undefined;
  for (const scenario of scenarios) {
    const evidence = evidenceScenario(scenario);
    const visual = visualScenario(scenario);
    if (visual !== undefined) {
      // V4: the same resolution as an evidence scenario's, a different reader.
      const path = values.defects
        ? resolve(values.defects)
        : resolve(paperDir, "..", visual.manifestFile);
      try {
        manifests.set(scenario.id, await readVisualManifest(path));
      } catch (error) {
        io.log(
          `scenario "${scenario.id}" needs its visual manifest: ${(error as Error).message}\n${EVAL_USAGE}`,
        );
        return 1;
      }
    }
    if (evidence !== undefined) {
      const path = values.defects
        ? resolve(values.defects)
        : resolve(paperDir, "..", evidence.manifestFile);
      try {
        manifests.set(scenario.id, await readManifest(path));
      } catch (error) {
        io.log(
          `scenario "${scenario.id}" needs its defect manifest: ${(error as Error).message}\n${EVAL_USAGE}`,
        );
        return 1;
      }
    }
    if (scenario.bundledSkills === true && skills === undefined) {
      const loaded = await listSkills({ bundledDir: bundledSkillsDir() });
      skills = loaded.skills;
    }
  }

  // V3 (ADR 0080 §9): the renderer, built only for a scenario that wants it.
  // Lazy because it reads ~2 MiB of WASM, which no other scenario should pay
  // for. `lemmaria eval --scenario pdf-marker` is what makes the door
  // reachable from the CLI at all — no production path registers the tool.
  //
  // V4 (ADR 0081 §2): and for every review, whose PDF reviewer reads the
  // compiled paper — the marker scenario's wiring is unchanged.
  let pdfRenderer: PdfRenderer | undefined;
  if (
    scenarios.some(
      (s) =>
        s.tools.includes("view_pdf_pages") || /^\s*\/review/.test(s.prompt),
    )
  ) {
    const { createPdfiumRenderer } = await import("@lemmaria/adapters");
    const { pdfiumWasmPath } = await import("@lemmaria/adapters/pdfium-wasm");
    pdfRenderer = createPdfiumRenderer(
      new Uint8Array(await readFile(pdfiumWasmPath())),
    );
  }

  const reports: EvalReport[] = [];
  let failed = false;
  for (const scenario of scenarios) {
    try {
      const report = await runFlagshipEval({
        scenario,
        paperDir,
        grants,
        stub: values.stub === true,
        // A live run is one the OPERATOR paid for and is judging by reading the
        // passage it wrote, so it keeps its working copy even on a pass (the
        // flagship gate's round 2). `--stub` still cleans up: its prose is
        // scripted, and a gate run must leave no copy of the paper behind.
        ...(values.stub === true ? {} : { keepWorkDir: true }),
        ...(scenario.readOnly === true ? { readOnly: true } : {}),
        ...(scenario.bundledSkills === true && skills ? { skills } : {}),
        ...(manifests.has(scenario.id)
          ? {
              manifest: manifests.get(scenario.id) as
                | DefectManifest
                | VisualManifest,
            }
          : {}),
        ...(binding ? { binding } : {}),
        ...(ceilings ? { ceilings } : {}),
        ...(pdfRenderer ? { pdfRenderer } : {}),
      });
      reports.push(report);
      if (!report.verdict.pass) failed = true;
      if (values.json !== true) io.log(formatEvalReport(report));
    } catch (error) {
      // One scenario's failure must not abort the sweep — the S4 discipline.
      failed = true;
      io.log(`FAIL  ${scenario.id}\n    ✗ ${(error as Error).message}`);
    }
  }

  if (values.json === true) io.log(JSON.stringify(reports, null, 2));
  return failed ? 1 : 0;
}

/**
 * The three `--max-*` flags, as the run's per-field budget CEILING.
 *
 * A ceiling rather than a request, which is the whole of the review round's F2:
 * a request can only ever clamp DOWN from the default, so every one of these
 * flags silently did nothing above `DEFAULT_TASK_BUDGET` — see
 * `EvalRunOptions.ceilings` for what that cost.
 */
function numericCeilings(values: {
  "max-turns"?: string;
  "max-tool-calls"?: string;
  "max-output-tokens"?: string;
}):
  | { maxTurns?: number; maxToolCalls?: number; maxOutputTokens?: number }
  | undefined {
  const ceilings: {
    maxTurns?: number;
    maxToolCalls?: number;
    maxOutputTokens?: number;
  } = {};
  const turns = Number(values["max-turns"]);
  const calls = Number(values["max-tool-calls"]);
  const tokens = Number(values["max-output-tokens"]);
  if (Number.isInteger(turns) && turns > 0) ceilings.maxTurns = turns;
  if (Number.isInteger(calls) && calls > 0) ceilings.maxToolCalls = calls;
  if (Number.isInteger(tokens) && tokens > 0) ceilings.maxOutputTokens = tokens;
  return Object.keys(ceilings).length > 0 ? ceilings : undefined;
}

/**
 * `--protocol`, defaulting to the driver's own default when it is omitted.
 *
 * An unknown value is refused rather than mapped: it used to fall through to
 * anthropic, and falling through to a FUNDED provider instead would run — and
 * bill — a model the operator never named.
 */
function protocolFrom(value: string | undefined): Protocol {
  if (value === undefined) return DEFAULT_LIVE_PROTOCOL;
  if (value === "openai-compatible" || value === "anthropic") return value;
  throw new Error(
    `unknown --protocol "${value}" (expected openai-compatible or anthropic)`,
  );
}

/** A binding only when the caller named one; otherwise the driver's default. */
export function liveBindingFrom(values: {
  stub?: boolean;
  protocol?: string;
  model?: string;
}): ModelBinding | undefined {
  if (values.stub === true) return undefined;
  const protocol = protocolFrom(values.protocol);
  if (!values.model) {
    // Only the default protocol has a default model, so a bare `--protocol
    // anthropic` cannot be honoured — and dropping it would bind the default
    // protocol instead, which is the one thing the flag said not to do.
    if (protocol !== DEFAULT_LIVE_PROTOCOL) {
      throw new Error(
        `--protocol ${protocol} needs --model <id>: only ${DEFAULT_LIVE_PROTOCOL} has a default model (${DEFAULT_LIVE_MODEL})`,
      );
    }
    return undefined;
  }
  try {
    return liveBinding(protocol, values.model);
  } catch (error) {
    // Re-throw with --protocol context so the operator knows which flag to adjust
    // (review, Minor 12).
    throw new Error(
      `no API key for --protocol ${protocol}: ${(error as Error).message}`,
    );
  }
}
