export const HARNESS_PACKAGE_NAME = "@lemmaria/harness";
export * from "./contracts/index.js";
export * from "./model/scripted.js";
export * from "./model/shared.js";
export * from "./model/pricing.js";
export * from "./model/anthropic.js";
export * from "./model/openai-compatible.js";
export * from "./model/factory.js";
export * from "./model/providers.js";
export * from "./model/floor.js";
export * from "./model/capabilities.js";
export * from "./actions/schema.js";
export * from "./actions/loader.js";
// NOTE: ./actions/builtin.js is intentionally NOT re-exported here. It uses
// import.meta.url (Node ESM) to locate the shipped actions/ dir, which esbuild
// rewrites to empty (with a warning) when the barrel is pulled into the CJS
// extension bundle — even though the extension never calls it (it inlines the
// YAML via loadBundledActions). Node ESM consumers (the CLI) import it from the
// dedicated "@lemmaria/harness/builtin-actions" subpath instead.
export * from "./venue/manifest.js";
export * from "./venue/library.js";
export * from "./venue/scaffold.js";
export * from "./venue/checklist.js";
export * from "./engine/template.js";
export * from "./engine/spans.js";
export * from "./engine/paper.js";
export * from "./engine/memory.js";
export * from "./engine/workspace-utils.js";
export * from "./engine/gitignore.js";
export * from "./engine/grants.js";
export * from "./engine/literature.js";
export * from "./engine/literature-pacer.js";
export * from "./engine/outline.js";
export * from "./engine/anchored-edit.js";
export * from "./engine/review.js";
export * from "./engine/review-spans.js";
export * from "./engine/scorecard.js";
export * from "./engine/pdf-facts.js";
export * from "./engine/verification.js";
export * from "./engine/cost.js";
export * from "./engine/params.js";
export * from "./engine/budget.js";
export * from "./engine/errors.js";
export * from "./engine/context.js";
export * from "./engine/citations.js";
export * from "./engine/citation-lookup.js";
export * from "./engine/citation-metadata.js";
export * from "./engine/tools.js";
export * from "./engine/validators.js";
export * from "./engine/compile.js";
export * from "./engine/verify.js";
export * from "./engine/engine.js";
export * from "./session/cut.js";
export * from "./session/replay.js";
export * from "./session/store.js";
export * from "./session/prompt.js";
export * from "./session/notices.js";
export * from "./session/loop.js";
export * from "./session/child-store.js";
export * from "./session/run.js";
export * from "./session/manuscript-title.js";
export * from "./session/review-panel.js";
// V4 (ADR 0081): the driver re-exports the REVIEWERS' seven under this name;
// the package's own export is the contract's eight. Explicit, so the two star
// exports are not ambiguous.
export { PANEL_DIMENSIONS } from "./contracts/index.js";
export * from "./session/review-pdf.js";
export * from "./session/review-pdf-seat.js";
export * from "./session/review-verifier.js";
// R9: the panel's clamp is the fan-out's, and the EXTENSION needs the same
// number to clamp its reviewer count at the edge (invariant 5: a host can
// only ask for less). Named rather than `export *` — the rest of that module
// is the subtask tool's internals, which no consumer outside the harness has
// any business reaching.
export { MAX_FAN_OUT } from "./session/loop-tools/subtask.js";
export {
  PDF_RENDER_WIDTH_PX,
  PDF_ZOOM_SCALE,
  VIEW_PDF_PAGES_MAX_PER_CALL,
  VIEW_PDF_PAGES_MAX_VIEWS,
  VIEW_PDF_PAGES_SPEC,
  createViewPdfPagesTool,
  type ViewPdfPagesDeps,
  type ViewPdfPagesTool,
} from "./session/loop-tools/pdf-pages.js";
export * from "./session/review-store.js";
export * from "./session/budget.js";
export * from "./session/context.js";
export * from "./session/compaction.js";
export * from "./session/stream-errors.js";
export * from "./session/retry.js";
export * from "./session/edits.js";
// T2: `edits.js` has always re-exported this module's *behaviour* by calling
// into it; the barrel did not re-export the module itself, so the two refusal
// BUILDERS were unreachable from outside the package. That is why two live
// tests carried copies of their English output as literals — a copy that stops
// matching the day the wording or the locale changes, and a live assertion
// matching nothing passes.
export * from "./session/protected-edits.js";
export * from "./session/usage.js";
export * from "./session/tool-summary.js";
export * from "./session/snapshot-store.js";
export * from "./session/snapshot.js";
export * from "./session/skill-invocation.js";
export * from "./skills/loader.js";
export * from "./skills/library.js";
// NOTE: ./skills/bundled.js is intentionally NOT re-exported here, for exactly
// the reason ./actions/builtin.js is not (see the note above): it uses
// import.meta.url to locate the shipped skills/ dir. The extension reads its
// own dist/skills copy; Node ESM consumers use "@lemmaria/harness/bundled-skills".
