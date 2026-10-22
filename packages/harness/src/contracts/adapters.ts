/**
 * Adapter interfaces: the Document Adapter Layer and the Model Adapter Layer.
 *
 * Both layers have ZERO VS Code API dependency (enforced in CI). The Model Adapter
 * interface is the foundational seam every tier calls and every test stubs through —
 * it was only a box in the architecture diagram, so it is pinned here.
 */

import type { ReviewVenue, Warning } from "./data.js";
import type { ToolName } from "./tools.js";

// ── Document Adapter Layer ───────────────────────────────────────────────────

export type DocKind = "latex" | "markdown";
export type SpanKind =
  | "math"
  | "cite"
  | "ref"
  | "code"
  | "macro"
  | "markup"
  | "comment";

/**
 * What a protected span protects (X2, ADR 0033 §3; extended by X3, ADR 0036).
 *
 * **Opaque** — `comment`, `math`, `cite`, `ref`, `code`, `macro`. The whole raw
 * text is protected. None of these carries prose a rewrite could legitimately
 * want: `$\omega = |Q \cap C| / |Q|$` either survives or is deliberately
 * removed, and there is no third thing to do to it.
 *
 * **Container** — `markup` (`\textbf{…}`, `\emph{…}`, `\footnote{…}`, `\item`,
 * a Markdown heading). The command and its delimiters are protected, the prose
 * *between* them is not — and, since X3, **anything protected NESTED inside it
 * is protected in its own right**, which is what stops freeing the prose from
 * also freeing a formula or a citation that happened to sit in it.
 *
 * **Derived from `kind`, never persisted.** The mapping is total and has no
 * per-span exceptions, so storing it would only create something that could go
 * stale (B4's rule for the file-operations set).
 *
 * It lives in the contracts rather than beside either consumer because both
 * sides of the split need it and they are in different packages: the harness
 * decides what a replacement must still contain, and `@lemmaria/adapters`
 * decides which candidates to surface from inside one. Two copies of this set
 * could drift, and a drift here silently *un*protects.
 */
export const CONTAINER_SPAN_KINDS: ReadonlySet<SpanKind> = new Set<SpanKind>([
  "markup",
]);

export interface SourceSpan {
  file: string;
  startOffset: number;
  endOffset: number;
}

export interface ProtectedSpan extends SourceSpan {
  kind: SpanKind;
  /** Opaque token substituted into prompts when protected_spans: freeze. */
  token: string;
  raw: string;
}

/**
 * Protected spans on the AGENTIC path (D1, ADR 0032).
 *
 * `DocumentAdapter.protectedSpans` cannot serve it: that method takes a
 * `SemanticUnit` and is bound to a project loaded at task start, so it throws
 * for a file outside the project and its AST goes stale as soon as an earlier
 * edit in the same task lands. This is the stateless alternative — given a
 * file's name (for the kind) and a piece of TEXT, what inside that text must
 * not change? Implemented by `@lemmaria/adapters`' `protectedSpansIn` and
 * INJECTED by the host, because the harness must not depend on the adapters
 * (invariant 1's dependency direction).
 *
 * `undefined` means "I cannot analyse this file" — an extension no adapter
 * covers. The read side then marks nothing and the write side enforces
 * nothing: honest degradation, never a guess and never a refusal for text we
 * could not read.
 *
 * The SAME reader serves both sides deliberately. A rule enforced but not
 * shown, or shown but not enforced, is the divergence D1 exists to close.
 */
export type ProtectedSpanReader = (
  file: string,
  text: string,
) => Promise<ProtectedSpan[] | undefined>;

/** The files one paper is made of, as its entry declares them (ADR 0074 §4). */
export interface ManuscriptGraph {
  /** Workspace-relative, READING ORDER, the entry first; bibliographies last. */
  files: readonly string[];
  /** Declared but unreadable targets — reported, never thrown. A paper missing
   *  one `\input` is still a paper, so the panel says so and reviews it. */
  missing: readonly string[];
}

/**
 * Resolves an entry's include graph (ADR 0074 §4).
 *
 * **INJECTED by the host**, in the exact shape of `ProtectedSpanReader` above
 * and for the same reason: the walk lives in `@lemmaria/adapters`, and the
 * harness must not depend on it (invariant 1). `read` is the panel's own
 * workspace read, so the graph and the manuscript are read from one copy and
 * cannot disagree about what a file contains.
 *
 * `undefined` = **no adapter covers this entry** — honest degradation, never a
 * guess. The driver then falls back to the suffix glob and emits
 * `review.manuscript_unresolved`, so the fallback is recorded rather than
 * silent.
 */
export type ManuscriptGraphReader = (
  entry: string,
  read: (relPath: string) => Promise<string>,
) => Promise<ManuscriptGraph | undefined>;

// ── PDF renderer port (adapter-provided) ─────────────────────────────────────

/** One rendered page: a PNG and the pixel size it was rendered at. */
export interface PdfPageImage {
  png: Uint8Array;
  width: number;
  height: number;
}

/** A PDF's own metadata. For the HARNESS's use — never shown to a model. */
export interface PdfMetadata {
  title?: string;
  author?: string;
  creator?: string;
  producer?: string;
}

/** One opened PDF. `close()` releases the renderer's native handles. */
export interface PdfDocument {
  readonly pageCount: number;
  /** In PDF points, 1-based page. */
  pageSize(page: number): { width: number; height: number };
  /**
   * Renders the page at `width` px; the height is DERIVED from the page's own
   * aspect ratio and is never supplied by the caller, because a width without a
   * height silently distorts the page (S6 measured it on both candidates).
   *
   * `half` renders the page at exactly `width` and returns only that half of
   * the rows — `[0, ⌊H/2⌋)` for `"top"`, `[⌊H/2⌋, H)` for `"bottom"`, so the
   * two cover every row of an odd-height page between them. **The port does no
   * scaling of its own**: doubling the width to get a zoom is the CALLER's, and
   * `view_pdf_pages` is the one that does it (`PDF_ZOOM_SCALE`). An
   * implementation that doubled here would square the effect.
   */
  renderPage(
    page: number,
    opts: { width: number; half?: "top" | "bottom" },
  ): Promise<PdfPageImage>;
  /** The page's text layer — for the harness's own use, never shown to a model. */
  pageText(page: number): Promise<string>;
  /**
   * The page's text grouped by EFFECTIVE size in points, rounded to 0.1 pt,
   * ascending, whitespace excluded (V4, ADR 0081 §1). *Effective* is the
   * font's nominal size times the scale of that character's own matrix, so
   * text inside a figure included at half width reports the size it prints at.
   * Text inside a raster image has no text layer and is not here. For the
   * harness's own use, never shown to a model.
   */
  pageTextSizes(
    page: number,
  ): Promise<Array<{ sizePt: number; chars: number }>>;
  metadata(): Promise<PdfMetadata>;
  close(): void;
}

/**
 * Opens a PDF from its BYTES (V3, ADR 0080).
 *
 * **INJECTED by the host**, in the exact shape of `ManuscriptGraphReader` and
 * `ProtectedSpanReader` above and for the same reason: the renderer is a WASM
 * build of PDFium living in `@lemmaria/adapters`, and the harness must not
 * depend on the adapters (invariant 1).
 *
 * `undefined` = **these bytes are not a PDF this renderer can open** — honest
 * degradation, never a throw and never a guess, exactly as the two readers
 * above degrade. Bytes in, bytes out: the port reads no file and touches no
 * network, so it adds no egress (invariant 2).
 */
export type PdfRenderer = (pdf: Uint8Array) => Promise<PdfDocument | undefined>;

/**
 * Parses a compile log into warnings (V4, ADR 0081) — the fourth
 * function-typed port in `ManuscriptGraphReader`'s shape, and for the same
 * reason: the log parser lives in `@lemmaria/adapters`, and the harness must
 * not depend on it (invariant 1). The host binds the engine the log came from.
 * Absent ⇒ no overfull fact, never a guess.
 */
export type CompileLogReader = (log: string, entryFile: string) => Warning[];

/**
 * What a review needs to see the compiled paper (V4, ADR 0081), handed to the
 * driver by the host. `renderer` is what makes the PDF reviewer possible at
 * all; the rest are optional and each one's absence is recorded honestly:
 * no `compile` ⇒ this run cannot build a fresh PDF (no engine, no entry); no
 * `compileLog` ⇒ no overfull fact; no `venue` ⇒ no venue line.
 */
export interface ReviewPdfDeps {
  renderer: PdfRenderer;
  compile?: () => Promise<CompileResult>;
  compileLog?: CompileLogReader;
  venue?: ReviewVenue;
}

export interface SemanticUnit {
  scope: "selection" | "paragraph" | "section" | "environment" | "document";
  text: string;
  span: SourceSpan;
}

export interface WordCount {
  language: "en" | "zh" | "mixed";
  unit: "字" | "words";
  count: number;
  /** Per-segment breakdown for mixed CN/EN content. */
  segments?: Array<{ language: "en" | "zh"; count: number }>;
}

/** The entry document's \documentclass (or equivalent) — venue/template detection. */
export interface DocumentClass {
  name: string;
  options: string[];
}

export interface DocumentAdapter {
  kind: DocKind;
  /** Section tree across \input / headings. Drives CM2 Repo Map. */
  parseStructure(): Promise<import("./tools.js").OutlineNode[]>;
  /** Selection (offset range) → smallest enclosing semantic unit. */
  resolveSelection(
    selection: SourceSpan,
    scope: SemanticUnit["scope"],
  ): SemanticUnit;
  /** Frozen placeholders: math / citations / code blocks / macros. */
  protectedSpans(unit: SemanticUnit): ProtectedSpan[];
  /** CN by char, EN by word, per-segment for mixed. */
  countWords(text: string): WordCount;
  /** LaTeX: compile. Markdown: structural parse-check. */
  verify(): Promise<{ ok: boolean; warnings: Warning[] }>;
  /** Extract citation keys + bib metadata (for citation checking). */
  citations(): Promise<{ key: string; fields: Record<string, string> }[]>;
  /** Structure-safe replacement. Returns new source text; never writes to disk itself. */
  applyEdit(unit: SemanticUnit, replacement: string): { newText: string };
  /** Venue/template detection (schema §5 {{venue}}): the entry document's
   *  class, if any (ADR 0010). Optional — adapters without the concept
   *  (Markdown) omit it and {{venue}} renders "". */
  documentClass?(): DocumentClass | undefined;
}

// ── Workspace port (host-provided) ───────────────────────────────────────────
// The seam that lets the harness read, stage edits, and compile WITHOUT the VS
// Code API. The host (extension, or the Phase-2 server) implements this port and
// injects it. apply_edit writes to a WORKING COPY here — it never touches the
// user's real file. Whether the working copy is committed is decided by the host's
// diff/Accept gate (the host renders an EditProposal as a reviewable diff). This is
// what keeps the zero-vscode invariant true even inside an autonomous L2 loop:
// the agent applies edits to the working copy and re-verifies without blocking on
// any UI; the user reviews the accumulated diff at the Accept gate.

/**
 * What a compile run reports (ADR 0013 — a report, not a gate).
 *
 * `pdf` is the artifact the run produced, in memory, and ONLY when the caller
 * asked for it (`wantPdf`). Bytes rather than a path, deliberately: the one
 * consumer loads the document into memory anyway, a path would leave a temp
 * file someone must delete, and bytes keep invariant 3's story one sentence
 * long — nothing here writes into the user's workspace (V3, ADR 0080 D10).
 *
 * `aux` is the same run's `.aux`, as text, beside the PDF and only with it
 * (ADR 0084): the one record of the page each float shipped out on, which the
 * PDF reviewer's page cites are checked against. It lives in the same shadow
 * directory the PDF does and is gone with it, so it rides out here too.
 */
export interface CompileResult {
  ok: boolean;
  log: string;
  pdf?: Uint8Array;
  aux?: string;
}

export interface Workspace {
  root: string;
  /**
   * Current content, resolved through three layers of truth, nearest first
   * (ADR 0002): the agent's staged working copy → the editor's unsaved buffer
   * (supplied by the host) → the on-disk file.
   *
   * `relPath` MUST be workspace-relative; implementations MUST reject a path
   * that resolves outside `root` (absolute paths, `..` escapes) — use the
   * shared `assertWorkspaceRelative` guard. Model-supplied `file` arguments
   * (read_span, replace_anchor) reach this port, so containment is part of
   * the capability boundary (invariant 2), not a per-host courtesy.
   */
  readFile(relPath: string): Promise<string>;
  /** Stage an edit on the working copy. Does NOT write the user's real file.
   *  Same root containment requirement as readFile. */
  writeWorkingCopy(relPath: string, content: string): Promise<void>;
  /** Project files (optionally filtered) — for grep_project / list_* tools. */
  listFiles(glob?: string): Promise<string[]>;
  /**
   * Run the resolved compile/parse engine over the working copy and return the raw
   * log for the adapter to parse into Warning[]. External engines read from disk,
   * so the implementation MATERIALIZES the three-layer overlay (working copy →
   * editor buffers → disk) into a shadow directory before invoking the engine
   * (ADR 0002) — compiling the state the user and agent actually see. (Implemented
   * with Node child_process, which is allowed — the invariant forbids `vscode`, not Node.)
   */
  compile(engine: string, opts?: { wantPdf?: boolean }): Promise<CompileResult>;
  /**
   * The file's size and modification time, or `undefined` when it does not
   * exist (V3, ADR 0080 D12). OPTIONAL: a host that cannot answer simply does
   * not implement it, and the one policy that reads it treats absence as "no
   * candidate". Same root containment requirement as `readFile`.
   */
  stat?(
    relPath: string,
  ): Promise<{ mtimeMs: number; size: number } | undefined>;
  /**
   * The file's raw bytes — for the compiled PDF, which is not text (V3, ADR
   * 0080 D12). OPTIONAL for the same reason as `stat`. Same root containment
   * requirement as `readFile`. This is a READ; invariant 3 is untouched.
   */
  readBinary?(relPath: string): Promise<Uint8Array>;
}

// ── Model Adapter Layer ──────────────────────────────────────────────────────
// Supports the Anthropic protocol and the OpenAI-compatible protocol (OpenAI,
// DeepSeek, Gemini-compatible endpoints, Ollama). BYOK; keys come from the host
// (VS Code Secret Storage) — the adapter receives a key, it never reads storage.

export type Protocol = "anthropic" | "openai-compatible";
export type ThinkingBudget = "none" | "low" | "medium" | "high";

export interface ModelBinding {
  protocol: Protocol;
  endpoint: string; // base URL
  model: string; // model id
  apiKey: string; // injected by the host; adapter does not fetch it
  /**
   * Whether this endpoint accepts image input, OVERRIDING the prefix table in
   * `model/capabilities.ts` (V3, ADR 0080 D6). Absent = "ask the table", which
   * answers `false` for a model id it does not know: deny-by-default, because
   * offering a tool to a model that then errors on the image block mid-review
   * is the failure invariant 2's direction avoids. The user sets this per model
   * in the Models tab, which is the remedy for an endpoint nobody has heard of.
   */
  imageInput?: boolean;
}

export interface ToolSpec {
  name: ToolName;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

/**
 * One image a message carries BESIDE its text (V3, ADR 0080 D1).
 *
 * `data` is base64, and it is ABSENT once the image has been evicted — the part
 * then stands for what was shown, and each protocol adapter renders it as a
 * text placeholder AT THE WIRE. The placeholder deliberately does not live in
 * `content`: `session/run.ts`'s rule is that the LIVE history is the same shape
 * as the REBUILT one, byte-identical in text, and rewriting `content` would
 * break it.
 *
 * This is a SIBLING of `content`, not a union with it — the divergence from
 * Pi Agent, whose `content` is `string | (TextContent | ImageContent)[]`. The
 * sibling is what leaves compaction, `plainHistory`, the token estimate,
 * persistence and the scripted adapter correct untouched.
 */
export interface ImagePart {
  /** "image/png" is the only value the harness produces at this stage. */
  mimeType: string;
  /** base64; ABSENT ⇒ evicted, and the wire renders a placeholder instead. */
  data?: string;
  /** e.g. "page 3", "page 3 (top)" — what the placeholder names. */
  label?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * Images this message carries beside its text (V3, ADR 0080 D1). Valid on
   * `user` and `tool`; the adapters ignore it on any other role. No
   * `SessionItem` has a counterpart, by construction — the tool batch attaches
   * images to the `ChatMessage` it pushes and to nothing it emits, so a
   * persisted transcript cannot carry a pixel.
   */
  images?: ImagePart[];
  /** For role: "assistant" — the tool calls this message made, echoed back into
   *  history so protocol adapters can reconstruct tool_use / tool_calls blocks (ADR 0003). */
  toolCalls?: ToolCall[];
  /** For role: "tool" — which call this result answers. */
  toolCallId?: string;
  /** For role: "assistant" — opaque provider reasoning blocks (e.g. Anthropic
   *  signed `thinking`) echoed verbatim so a thinking-enabled tool loop can
   *  continue after tool_use without dropping them (ADR 0006). The harness never
   *  interprets these; only the producing protocol adapter reads them. */
  reasoning?: unknown;
}

export interface ToolCall {
  id: string;
  name: ToolName;
  args: unknown;
}

export interface GenerateRequest {
  binding: ModelBinding;
  messages: ChatMessage[];
  /** Tools exposed this turn (empty for L0). */
  tools?: ToolSpec[];
  temperature?: number;
  thinkingBudget?: ThinkingBudget;
  maxTokens: number;
  signal?: AbortSignal; // bound to the action's timeout_s
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Estimated cost in USD for this call, for cumulative display. Omitted when the
   * model's pricing is unknown (custom BYOK endpoints, local models) — the UI
   * falls back to token counts rather than showing a fabricated number (ADR 0002).
   */
  costUsd?: number;
}

export interface GenerateResult {
  text: string;
  /** Non-empty ⇒ the model is requesting tool calls (drives the L1/L2 loop). */
  toolCalls: ToolCall[];
  stopReason: "stop" | "tool_use" | "max_tokens" | "aborted";
  usage: Usage;
  /** Opaque provider reasoning blocks for this turn, to echo back on the next
   *  request in a tool loop (ADR 0006). Omitted when the provider has none. */
  reasoning?: unknown;
}

/**
 * One streamed model event (ADR 0015). A `generateStream()` iterable yields
 * zero or more delta events then EXACTLY ONE terminal event — `completed`
 * (carrying the same `GenerateResult` the unary path would return) or
 * `aborted` (the S4 silent-abort made explicit: the adapter checks the
 * request signal after the SDK iterator ends; a stream never just "ends" on
 * the consumer). A throw before the terminal event is a stream failure the
 * caller may classify and retry.
 */
export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | {
      /**
       * Tool-call argument fragment. `index` is a 0-based call ORDINAL
       * aligned with the terminal result's `toolCalls` order — adapters
       * normalize protocol-level block indices to it (consumers key item
       * identity on it). `id`/`name` arrive on the first fragment for that
       * index.
       */
      type: "tool_call_delta";
      index: number;
      id?: string;
      name?: string;
      argsDelta: string;
    }
  | { type: "completed"; result: GenerateResult }
  | { type: "aborted" };

export interface ModelAdapter {
  protocol: Protocol;
  /** One round-trip. Tier loops call this repeatedly, feeding tool results back. */
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /**
   * Streamed generation (ADR 0015). Required by the session task loop; both
   * shipped adapters implement it. Optional in the type so unary-only
   * consumers and test fakes stay valid — the loop reports an honest error
   * item when absent. The streamed path is thinking-off in A1a (the
   * unverified signed-echo gap recorded in ADR 0015).
   */
  generateStream?(req: GenerateRequest): AsyncIterable<ModelStreamEvent>;
}

/**
 * A bound model a CHILD task may be run on instead of its parent's (R9,
 * [ADR 0069] §D3) — the adapter to call and the binding to call it with,
 * exactly the pair `getModel` resolves for the parent.
 *
 * Here rather than beside the review panel that introduced it: three packages
 * name it — the harness's fan-out and task runner, the extension's role
 * resolver, and the CLI's eval driver — which is the convention's test for a
 * cross-component type. Keeping it in `session/` would also have made
 * `loop-tools/fan-out.ts` import from `session/review-panel.ts`, which already
 * imports the fan-out.
 */
export interface ChildModel {
  adapter: ModelAdapter;
  binding: ModelBinding;
}

/** Per-MTok USD prices for one model family (ADR 0009). */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /**
   * A second rate card, for a long prompt (ADR 0090 §5): a call whose input
   * exceeds `aboveInputTokens` is priced WHOLLY at these rates — both
   * providers choose the card by the call's prompt length, and neither prices
   * only the excess. Absent ⇒ one card at every length.
   */
  longContext?: {
    aboveInputTokens: number;
    inputPerMTok: number;
    outputPerMTok: number;
  };
}

/** Optional factory configuration (ADR 0009): a cost table keyed by model-id
 *  prefix. The production factory defaults it to the bundled snapshot table;
 *  an absent/unmatched model ⇒ `Usage.costUsd` omitted (ADR 0002). */
export interface ModelFactoryOptions {
  pricing?: Record<string, ModelPricing>;
}

/**
 * Tests stub this factory to return a deterministic ModelAdapter, so every suite
 * is offline and deterministic (architecture Testing Strategy).
 */
export type ModelAdapterFactory = (
  protocol: Protocol,
  options?: ModelFactoryOptions,
) => ModelAdapter;
