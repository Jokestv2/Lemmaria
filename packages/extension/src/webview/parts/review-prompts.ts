/**
 * What a review concern becomes on its way to the assistant: the Resolve
 * prompt it is SENT as (ADR 0063 §3), and the draft Chat puts in the composer
 * (ADR 0062 §6).
 *
 * Both were composed inline in `main.ts`, which calls `acquireVsCodeApi()` at
 * module scope and so cannot be imported by a test. That is how the Resolve
 * prompt kept giving the evidence as a bare `L<n>` after X6 fixed the same
 * defect on the tab: the one copy nothing could assert was the one a model
 * reads. Pure in ADR 0037's sense — strings from `strings.ts`, the locale as
 * an argument, no host.
 *
 * Each message is built from string keys plus the reviewer's own words —
 * invariant 6 rule 2 for what we write, rule 1 for what the reviewer wrote.
 */
import type { SessionLocale } from "@lemmaria/harness";
import type { ReviewAnnotationInfo } from "../../webview-protocol.js";
import { tr } from "./strings.js";

/**
 * Where a line is, for a reader with no tab around it: `<file>:<n>` whenever
 * the file is known, a bare `L<n>` only when it is not.
 *
 * Deliberately NOT the tab's `whereOf`. The tab prints `L<n>` for the entry
 * because the launcher above it names the entry; a prompt has no such header,
 * so a bare line number there is a location the model has to guess — and the
 * guess it has every reason to make is the concern's own file.
 */
export function locationOf(file: string, line: number): string {
  return file === "" ? `L${line}` : `${file}:${line}`;
}

/**
 * ADR 0063 §3: one concern, handed to the assistant as a message of its own.
 *
 * It carries **both** locations, the anchor and the supporting passage,
 * because the second is what the assistant needs in order to check the
 * concern rather than take it on faith — and both by `locationOf`, so the two
 * cannot disagree about which file a line is in.
 */
export function resolvePrompt(
  locale: SessionLocale,
  a: ReviewAnnotationInfo,
): string {
  const lines = [
    tr(locale, "rFixIntro"),
    "",
    `${tr(locale, "rFixConcern")} ${a.id} (${a.dimension} · ${a.severity}) — ${tr(locale, "rFixAt")} ${locationOf(a.file, a.line)}:`,
    `> ${a.message}`,
  ];
  if (a.evidence?.kind === "span")
    lines.push(
      "",
      `${tr(locale, "rFixEvidence")}: ${locationOf(a.evidence.file, a.evidence.line)}`,
    );
  // V2: a paper is the OTHER thing evidence can be, and a draft that dropped
  // it would ask the assistant to act on a concern with its support removed.
  if (a.evidence?.kind === "paper")
    lines.push("", priorWorkLine(locale, a.evidence));
  // V4 (ADR 0081 §4): a page is where the PDF reviewer SAW the concern, and
  // the draft says so — the assistant cannot see the page, but it can tell
  // the author which one to look at.
  if (a.evidence?.kind === "page") lines.push("", pageLine(locale, a.evidence));
  if (a.suggestion !== undefined)
    lines.push("", `${tr(locale, "rFixSuggested")}: ${a.suggestion}`);
  lines.push("", tr(locale, "rFixInstruction"));
  return lines.join("\n");
}

/**
 * A paper evidence, as one line of a draft (V2, ADR 0078 D12).
 *
 * `prior work: "Title" (2015) https://...`, with absent parts omitted. The
 * title is QUOTED because it is the reviewer's copied text and the assistant
 * has to be able to tell where it ends; the href is bare so it stays
 * clickable in the composer.
 */
function priorWorkLine(
  locale: SessionLocale,
  evidence: { title: string; year?: string; href?: string },
): string {
  const parts = [`${tr(locale, "rPriorWork")}: "${evidence.title}"`];
  if (evidence.year !== undefined) parts.push(`(${evidence.year})`);
  if (evidence.href !== undefined) parts.push(evidence.href);
  return parts.join(" ");
}

/** V4 (ADR 0081 §4): a page evidence, as one line of a draft. */
function pageLine(locale: SessionLocale, evidence: { page: number }): string {
  return tr(locale, "rFixEvidencePage").replace("{n}", String(evidence.page));
}

/**
 * ADR 0062 §6: the draft Chat puts in the composer — the writer's sentence
 * to finish, so it ends on a question rather than an instruction.
 *
 * **On a WITHDRAWN concern it also carries the withdrawal** (V1's J1 round,
 * Judge question 3): the passage the verifier pointed at, and the verifier's
 * own sentence under it. Chat is the only route left on a withdrawn row
 * (ADR 0076 §9), so it is the route a reader who disagrees with the verifier
 * takes — and without this they had to explain the verifier's decision to the
 * assistant themselves. The note is third-party text, quoted as authored.
 */
export function chatDraft(
  locale: SessionLocale,
  a: ReviewAnnotationInfo,
): string {
  const head = `${tr(locale, "rChatIntro")} (${a.id} · ${a.dimension} · ${a.severity} · ${locationOf(a.file, a.line)}):`;
  const lines = [head, "", `> ${a.message}`];
  const v = a.verification;
  if (v?.outcome === "refuted" && v.counter !== undefined) {
    lines.push(
      "",
      tr(locale, "rChatWithdrawn").replace("{where}", () =>
        locationOf(v.counter?.file ?? "", v.counter?.line ?? 0),
      ),
    );
    if (v.note !== undefined && v.note !== "") lines.push("", `> ${v.note}`);
  }
  if (a.evidence?.kind === "paper")
    lines.push("", priorWorkLine(locale, a.evidence));
  // V4: and a page, for the same reason — a draft that dropped it would ask
  // about a layout concern without saying where it is visible.
  if (a.evidence?.kind === "page") lines.push("", pageLine(locale, a.evidence));
  lines.push("", tr(locale, "rChatAsk"));
  return lines.join("\n");
}
