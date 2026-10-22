/** Minimal argv entry: `run <actionId> --root ... --entry ... --select a:b --stub-text ...`. */

import { parseArgs } from "node:util";
import {
  ActionEngineError,
  ScriptedModelAdapter,
  VenueError,
  getVenue,
  listVenues,
  scaffoldVenue,
} from "@lemmaria/harness";
import { bundledVenuesDir } from "@lemmaria/harness/bundled-venues";
import { runCliCitationCheck } from "./citation-check.js";
import { EVAL_USAGE, evalCommand } from "./eval/command.js";
import { runCliAction } from "./run-action.js";

export async function main(
  argv: string[],
  io: { log: (line: string) => void } = { log: (line) => console.log(line) },
): Promise<number> {
  const [command, ...tail] = argv;
  if (command === "citations") {
    return citationsCommand(tail, io);
  }
  if (command === "venues") {
    return venuesCommand(io);
  }
  if (command === "new") {
    return newCommand(tail, io);
  }
  if (command === "eval") {
    return evalCommand(tail, io);
  }
  const [actionId, ...rest] = tail;
  if (command !== "run" || !actionId) {
    io.log(
      [
        "usage: lemmaria run <actionId> --root <dir> --entry <file> --select <start:end> [--file <rel>] [--param k=v]... --stub-text <reply>",
        "       lemmaria citations --root <dir> --entry <file>",
        "       lemmaria venues",
        "       lemmaria new --venue <id> --target <dir> [--no-compile]",
        EVAL_USAGE,
      ].join("\n"),
    );
    return 1;
  }
  let values: {
    root?: string;
    entry?: string;
    select?: string;
    file?: string;
    param?: string[];
    "stub-text"?: string[];
  };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        root: { type: "string" },
        entry: { type: "string" },
        select: { type: "string" },
        file: { type: "string" },
        param: { type: "string", multiple: true },
        "stub-text": { type: "string", multiple: true },
      },
    }));
  } catch (error) {
    io.log(`${(error as Error).message}`);
    io.log(
      "usage: lemmaria run <actionId> --root <dir> --entry <file> --select <start:end> [--file <rel>] [--param k=v]... --stub-text <reply>",
    );
    return 1;
  }
  if (!values.root || !values.entry || !values.select || !values["stub-text"]) {
    io.log("missing required flags: --root, --entry, --select, --stub-text");
    return 1;
  }
  const [startRaw, endRaw] = values.select.split(":");
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    io.log(
      `invalid --select "${values.select}" (expected <start:end> offsets)`,
    );
    return 1;
  }
  const params: Record<string, unknown> = {};
  for (const pair of values.param ?? []) {
    const at = pair.indexOf("=");
    if (at < 0) {
      io.log(`invalid --param "${pair}" (expected k=v)`);
      return 1;
    }
    const raw = pair.slice(at + 1);
    const asNumber = Number(raw);
    params[pair.slice(0, at)] =
      raw !== "" && !Number.isNaN(asNumber) ? asNumber : raw;
  }
  try {
    const result = await runCliAction({
      root: values.root,
      entry: values.entry,
      actionId,
      selection: {
        ...(values.file !== undefined ? { file: values.file } : {}),
        start,
        end,
      },
      params,
      model: new ScriptedModelAdapter(
        values["stub-text"].map((text) => ({ text })),
      ),
    });
    io.log(
      JSON.stringify(
        {
          action: actionId,
          retries: result.retries,
          validators: result.validators,
          usage: result.usage,
          templateWarnings: result.templateWarnings,
          ...(result.kind === "review"
            ? { review: result.review }
            : { proposals: result.proposals }),
        },
        null,
        2,
      ),
    );
    return (result.kind === "review" ? result.review : result.proposals)
      ? 0
      : 1;
  } catch (error) {
    if (error instanceof ActionEngineError) {
      io.log(`${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/** `lemmaria venues` — list the resolved Venue Template Library (M10). */
async function venuesCommand(io: {
  log: (line: string) => void;
}): Promise<number> {
  const { venues, errors } = await listVenues({
    bundledDir: bundledVenuesDir(),
  });
  io.log(
    JSON.stringify(
      {
        venues: venues.map((v) => ({
          id: v.manifest.id,
          name: v.manifest.name,
          engine: v.manifest.engine,
          redistribute: v.manifest.redistribute,
          source: v.source,
        })),
        errors,
      },
      null,
      2,
    ),
  );
  return 0;
}

/** `lemmaria new --venue <id> --target <dir> [--no-compile]` — New from Venue (M10). */
async function newCommand(
  rest: string[],
  io: { log: (line: string) => void },
): Promise<number> {
  const usage =
    "usage: lemmaria new --venue <id> --target <dir> [--no-compile]";
  let values: { venue?: string; target?: string; "no-compile"?: boolean };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        venue: { type: "string" },
        target: { type: "string" },
        "no-compile": { type: "boolean" },
      },
    }));
  } catch (error) {
    io.log(`${(error as Error).message}`);
    io.log(usage);
    return 1;
  }
  if (!values.venue || !values.target) {
    io.log(`missing required flags: --venue, --target\n${usage}`);
    return 1;
  }
  try {
    const venue = await getVenue(values.venue, {
      bundledDir: bundledVenuesDir(),
    });
    const report = await scaffoldVenue({
      venue,
      targetDir: values.target,
      ...(values["no-compile"] ? { compile: false as const } : {}),
    });
    io.log(JSON.stringify(report, null, 2));
    // Honest exit: a baseline compile that RAN and failed is a failure.
    return "ok" in report.compile && !report.compile.ok ? 1 : 0;
  } catch (error) {
    if (error instanceof VenueError || error instanceof ActionEngineError) {
      io.log(error.message);
      return 1;
    }
    throw error;
  }
}

/** `lemmaria citations --root <dir> --entry <file>` — offline C1 consistency check. */
async function citationsCommand(
  rest: string[],
  io: { log: (line: string) => void },
): Promise<number> {
  let values: { root?: string; entry?: string };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { root: { type: "string" }, entry: { type: "string" } },
    }));
  } catch (error) {
    io.log(`${(error as Error).message}`);
    io.log("usage: lemmaria citations --root <dir> --entry <file>");
    return 1;
  }
  if (!values.root || !values.entry) {
    io.log("missing required flags: --root, --entry");
    return 1;
  }
  const warnings = await runCliCitationCheck({
    root: values.root,
    entry: values.entry,
  });
  io.log(JSON.stringify({ warnings }, null, 2));
  return warnings.some((w) => w.severity === "error") ? 1 : 0;
}
