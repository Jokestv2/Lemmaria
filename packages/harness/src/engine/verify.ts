/**
 * Compile Check (X1, supersedes M5's Verified Edits): engine resolution, the
 * fix-request shaping, and rollback planning.
 *
 * Zero VS Code API dependency — the host `Workspace` runs the compiler (Node
 * child_process); this module only decides which engine to ask for. There is no
 * orchestration left to do: compiling is the host's response to a user asking
 * for it (ADR 0013), so the host calls `adapter.verify()` directly. See the S3
 * spike outcome (docs/plans/05-s3-compile-log-parsing-spike.md).
 */

import type { EditProposal } from "../contracts/actions.js";
import type { Warning } from "../contracts/data.js";
import type { SessionLocale } from "../contracts/sessions.js";

/** Guidance shown when tectonic would be used but is not installed, in the
 *  reader's language (invariant 6 rule 2, ADR 0034). */
export function tectonicInstallHint(locale: SessionLocale = "en"): string {
  if (locale === "zh") {
    return (
      "未检测到 tectonic。请从 " +
      "https://tectonic-typesetting.github.io/install.html 安装以获得免配置编译，" +
      "或将 lemmaria.verify.engine 设为本地 TeX 引擎。"
    );
  }
  return (
    "tectonic is not installed. Install it from " +
    "https://tectonic-typesetting.github.io/install.html for zero-config " +
    "compilation, or set lemmaria.verify.engine to a local TeX engine."
  );
}

function missingEngineHint(engine: string, locale: SessionLocale): string {
  if (locale === "zh") {
    return `未找到编译引擎 “${engine}”。请安装 TeX 发行版（MiKTeX / TeX Live），或改用 tectonic。`;
  }
  return `Compile engine "${engine}" was not found. Install a TeX distribution (MiKTeX / TeX Live) or use tectonic.`;
}

export interface EngineResolution {
  /** The engine string to hand to `Workspace.compile`. */
  engine: string;
  /** Set (bilingual) when the chosen engine is unavailable — actionable, never a hang. */
  guidance?: string;
}

export interface ResolveEngineOptions {
  /** `lemmaria.verify.engine`: "auto" | "latexmk" | "tectonic" | "xelatex" | "lualatex" | "pdflatex". */
  configEngine: string;
  /** Adapter's `preferredEngines()` — the document's preference, best first. */
  preferred: string[];
  /** Host probe: is this engine runnable on PATH? */
  available: (engine: string) => boolean;
  /** D4 (ADR 0034): the language `guidance` renders in. */
  locale?: SessionLocale;
}

/**
 * Resolve the compile engine (product-design Compile Check step 1): an explicit
 * config override is honored; `auto` walks the document preference then latexmk,
 * falling back to tectonic-with-guidance. An unavailable engine never throws —
 * it returns the engine plus install guidance so the UI can act.
 */
export function resolveEngine(opts: ResolveEngineOptions): EngineResolution {
  const { configEngine, preferred, available, locale = "en" } = opts;
  if (configEngine !== "auto") {
    if (available(configEngine)) return { engine: configEngine };
    if (configEngine === "tectonic") {
      return { engine: "tectonic", guidance: tectonicInstallHint(locale) };
    }
    return {
      engine: configEngine,
      guidance: missingEngineHint(configEngine, locale),
    };
  }
  for (const engine of [...preferred, "latexmk"]) {
    if (available(engine)) return { engine };
  }
  return { engine: "tectonic", guidance: tectonicInstallHint(locale) };
}

/**
 * The Compile Check status item's icon, text and tooltip (D4, CHROME-3).
 *
 * It lives here, not in the extension, for two reasons: it is presentation over
 * ENGINE data, which is the harness-leaf precedent [ADR 0037] §4 kept precisely
 * so a label can be unit-tested; and the defect it fixes — the finding count
 * shown on success-with-warnings and DISCARDED on failure, the branch where a
 * user most needs it — is arithmetic, which a source-level assertion cannot see.
 */
export function compileStatusLabel(opts: {
  ok: boolean;
  findingCount: number;
  locale?: SessionLocale;
}): { icon: string; text: string; tooltip: string } {
  const { ok, findingCount, locale = "en" } = opts;
  const zh = locale === "zh";
  const warnings = zh
    ? `${findingCount} 条警告`
    : `${findingCount} warning${findingCount === 1 ? "" : "s"}`;
  // On the FAILURE branch the findings are dominated by errors, not warnings —
  // `severityOf` maps them to DiagnosticSeverity.Error. Calling them warnings
  // there would be the status item saying something other than what is true,
  // which is the defect CHROME-3 exists to remove. Found by D4's code review.
  const findings = zh
    ? `${findingCount} 个问题`
    : `${findingCount} finding${findingCount === 1 ? "" : "s"}`;
  if (!ok) {
    return {
      icon: "$(error)",
      text:
        findingCount > 0
          ? zh
            ? `编译失败（${findings}）`
            : `Compile failed — ${findings}`
          : zh
            ? "编译失败"
            : "Compile failed",
      tooltip: zh
        ? "Lemmaria：项目未能编译通过"
        : "Lemmaria: the project did not compile",
    };
  }
  if (findingCount > 0) {
    return {
      icon: "$(warning)",
      text: warnings,
      tooltip: zh ? "Lemmaria：编译警告" : "Lemmaria: compile warnings",
    };
  }
  return {
    icon: "$(check)",
    text: zh ? "编译通过" : "Compiles",
    tooltip: zh
      ? "Lemmaria：编译通过，无警告"
      : "Lemmaria: compiles clean, no warnings",
  };
}

/**
 * A one-click rollback of an accepted edit, located by its content anchor so the
 * host reverts exactly that hunk and preserves later manual edits (never a blind
 * whole-file restore). The host applies it with the same staleness guard as M4.
 */
export interface RollbackPlan {
  file: string;
  /** What must currently be present (the accepted edit's replacement). */
  expectedOriginal: string;
  /** Restore this (the accepted edit's original text). */
  replacement: string;
}

export function planRollback(acceptedEdit: EditProposal): RollbackPlan {
  return {
    file: acceptedEdit.file,
    expectedOriginal: acceptedEdit.replacement,
    replacement: acceptedEdit.expectedOriginal,
  };
}

// ── Fix-request shaping ──────────────────────────────────────────────────────

/**
 * Shape compiler findings into the free-text `warnings` param `fix-compile-error`
 * takes — one finding (the Compile tab's per-row Fix) or many (Fix all); the
 * action reads free text either way (ADR 0007: it navigates the document itself
 * rather than trusting the reported line).
 *
 * Capped at 8: a fix prompt is a pointer to the defect, not a log dump, and a
 * failing LaTeX run can emit hundreds of cascading warnings from one error.
 */
export function formatWarningsForFix(warnings: Warning[]): string {
  return warnings
    .slice(0, MAX_FIX_WARNINGS)
    .map((w) => `- ${w.code} (line ${w.line ?? "?"}): ${w.message}`)
    .join("\n");
}

/**
 * The cap in `formatWarningsForFix` — the M5 `proposeFix` value, kept.
 * Exported so a caller that must pre-select which rows go into a fix (e.g. the
 * Compile tab deciding which findings an Accept is allowed to flip) can slice
 * to the SAME cap instead of hardcoding 8 a second place, where it could drift
 * out of sync with the truncation actually applied here.
 */
export const MAX_FIX_WARNINGS = 8;
