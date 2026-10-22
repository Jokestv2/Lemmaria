/**
 * V1, the **live** row that can actually see the verifier (plan D12, L3 —
 * ADR 0076).
 *
 * ## Why a row of its own
 *
 * L1 and L2 run real panels, and a cheap-pin panel may raise no careless
 * complaint at all — which would read *trap hits 0 → 0* and say nothing about
 * the verifier. So this row hands the verifier a FIXED ledger of 22 concerns,
 * through one scripted reviewer: the sixteen planted defects (claim anchor =
 * the manifest's primary span, message = its tell) and the six traps (claim
 * anchor = the bait, message = the complaint), every one a `major` flagged
 * `blocking` with its evidence recorded `"missing"`. Only the verifier is a
 * real model. 22 concerns is two chunks, so the split is exercised too.
 *
 * ## What it reads — reported, never asserted
 *
 * - **traps withdrawn / 6**, and how many with the counter on the passage that
 *   really answers them;
 * - **true defects withdrawn / 16** — the verifier's error rate on concerns
 *   known to be true, the number that would condemn it;
 * - **`central` answered `true` / answered**, over 22 majors all flagged
 *   blocking.
 *
 * None of these is a floor. A true-defect withdrawal rate the operator does not
 * like is a finding for the Done record, never a reason to add a floor, a
 * retry or a gentler rule (plan, gate clause 6). What IS asserted is
 * structural: the scripted ledger located in full (the precondition for
 * reading anything), the verifier ran on the pin, it was asked in two chunks,
 * and L4's honesty checks hold.
 *
 * ## Cost
 *
 * N = 1, so the cross-review is `insufficient_seats` and costs nothing; the
 * scripted reviewer costs nothing. What is spent is two verifier children on
 * the pin — plan estimate ≈ US$0.03–0.05 a pin.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type GenerateRequest,
  type GenerateResult,
  type ModelAdapter,
  type ModelStreamEvent,
  type Protocol,
  type ReviewItem,
  VERIFIER_BRIEF_MARKER,
  createModelAdapter,
  isWithdrawn,
} from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { type DefectManifest, readManifest } from "../../src/eval/recall.js";
import { runEvalTask } from "../../src/eval/run-eval.js";
import { scenarioById } from "../../src/eval/scenarios.js";
import {
  formatVerificationReport,
  measureVerification,
} from "../../src/eval/verification.js";
import {
  RAISED_CEILINGS,
  assertHonesty,
  liveBinding,
  panelProtocol,
} from "./panel-rows.js";
import {
  LIVE_ANTHROPIC_MODEL,
  LIVE_OPENAI_MODEL,
  liveAnthropicReady,
  liveOpenAIReady,
} from "./pins.js";
import { liveWorkDir } from "./work-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/planted-defects");
const PAPER = resolve(FIXTURE, "paper");
const TAG = "V1 live";

/** The sentence every verifier brief opens its prose with. */
const VERIFIER_MARKER = VERIFIER_BRIEF_MARKER;

/** The 22 concerns, in a fixed order: the defects, then the traps. */
function scriptedLedger(manifest: DefectManifest): string {
  const entry = (anchor: string, message: string) => ({
    dimension: "soundness",
    severity: "major",
    blocking: true,
    anchor,
    evidence: "missing",
    message,
  });
  return JSON.stringify({
    annotations: [
      ...manifest.defects.map((d) =>
        entry((d.spans[0] as { anchor: string }).anchor, d.tell),
      ),
      ...(manifest.traps ?? []).map((t) =>
        entry((t.bait[0] as { anchor: string }).anchor, t.complaint),
      ),
    ],
  });
}

/** The one reviewer, scripted: it hands in the fixed ledger, and answers the
 *  pre-run check with anything at all. It never reaches the verifier — that
 *  has its own, real adapter. */
class ScriptedReviewer implements ModelAdapter {
  constructor(
    readonly protocol: Protocol,
    private readonly ledger: string,
  ) {}
  private done(request: GenerateRequest): GenerateResult {
    const first = request.messages.find((m) => m.role === "user");
    const text = typeof first?.content === "string" ? first.content : "";
    return {
      text: text.includes("`reviewer_a`, one of") ? this.ledger : "ready",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
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

/** The real verifier, counted: every distinct brief it was handed is one
 *  chunk, however many turns that chunk's child took. */
class CountedAdapter implements ModelAdapter {
  readonly briefs = new Set<string>();
  constructor(private readonly inner: ModelAdapter) {}
  get protocol(): Protocol {
    return this.inner.protocol;
  }
  private note(request: GenerateRequest): void {
    const first = request.messages.find((m) => m.role === "user");
    const text = typeof first?.content === "string" ? first.content : "";
    if (text.includes(VERIFIER_MARKER)) this.briefs.add(text);
  }
  generate(request: GenerateRequest): Promise<GenerateResult> {
    this.note(request);
    return this.inner.generate(request);
  }
  generateStream(request: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    this.note(request);
    const stream = this.inner.generateStream?.(request);
    if (stream === undefined) throw new Error("the adapter cannot stream");
    return stream;
  }
}

const PINS = [
  {
    label: "L3/openai",
    protocol: "openai-compatible" as const,
    model: LIVE_OPENAI_MODEL,
    ready: liveOpenAIReady,
  },
  {
    label: "L3/anthropic",
    protocol: "anthropic" as const,
    model: LIVE_ANTHROPIC_MODEL,
    ready: liveAnthropicReady,
  },
];

for (const pin of PINS) {
  describe.skipIf(!pin.ready())(
    `V1 live — the verifier alone, on 22 scripted concerns (${pin.label})`,
    () => {
      it("checks them in two chunks, and what it withdrew is reported", async () => {
        const scenario = scenarioById("planted-defects");
        if (scenario === undefined)
          throw new Error("planted-defects scenario missing");
        const manifest = await readManifest(resolve(FIXTURE, "defects.json"));
        // Before any spend: the row is only readable with six traps planted.
        expect(manifest.traps).toHaveLength(6);

        const binding = liveBinding(pin.protocol, pin.model);
        // The scripted reviewer (and the parent, and so the cross-review's
        // default) sits on a binding of its own. Were it the verifier's, the
        // panel's pre-run check would count them as ONE model and ask only
        // the scripted adapter — so an unfunded key would read as a verifier
        // that failed with zeros, not as a refused panel.
        const scripted = { ...binding, model: "scripted-reviewer" };
        const verifier = new CountedAdapter(createModelAdapter(pin.protocol));
        const evidence = liveWorkDir();
        const started = Date.now();
        const task = await runEvalTask({
          scenario,
          paperDir: PAPER,
          grants: new Map(),
          stub: false,
          readOnly: true,
          skills: await panelProtocol(),
          binding: scripted,
          ceilings: RAISED_CEILINGS,
          adapter: new ScriptedReviewer(pin.protocol, scriptedLedger(manifest)),
          reviewers: [scripted],
          verifier: binding,
          verifierAdapter: verifier,
        });
        evidence.track(task.workDir);
        const item = task.outcome.items.find(
          (i): i is ReviewItem => i.type === "review",
        );
        const annotations = item?.result?.annotations ?? [];

        // The pre-run check first, so a refused panel reads as a refusal —
        // an unfunded verifier key refuses the whole panel now that the
        // verifier has a binding of its own — and not as a ledger that
        // failed to locate.
        const preflight =
          (item?.preflight ?? [])
            .map(
              (p) =>
                `${p.model}:${p.status}${p.cause !== undefined ? `(${p.cause.class})` : ""}`,
            )
            .join(",") || "none";
        console.info(`[${TAG}/${pin.label}] preflight=${preflight}`);
        expect(
          (item?.preflight ?? []).length > 0 &&
            (item?.preflight ?? []).every((p) => p.status === "ok"),
          `the pre-run check did not pass: ${preflight}`,
        ).toBe(true);

        // The precondition for reading anything: the scripted ledger located
        // in full, in its own order (checked offline before this row was
        // written — plan A24).
        expect(annotations).toHaveLength(22);
        expect(item?.verifierSeat?.model).toBe(pin.model);
        // 22 concerns, chunks of at most 20: two children, two briefs.
        expect(verifier.briefs.size).toBe(2);
        assertHonesty(TAG, item, pin.label, PAPER);

        const report = measureVerification(item as ReviewItem, manifest);
        // Rates are over what the verifier CHECKED. A chunk that failed
        // leaves its concerns with no `verification`, and a trap it never saw
        // is not a trap it kept — unmeasured is not zero (ADR 0071 §1).
        const defects = manifest.defects.map((d, i) => ({
          id: d.id,
          checked: annotations[i]?.verification !== undefined,
          withdrawn:
            annotations[i] !== undefined && isWithdrawn(annotations[i]),
        }));
        const checkedDefects = defects.filter((d) => d.checked);
        const lostDefects = defects.filter((d) => d.withdrawn);
        const checkedTraps = report.traps.hits.filter((h) => h.checked);
        const trapsWithdrawn = report.traps.hits.filter((h) => h.withdrawn);
        const onAnswer = trapsWithdrawn.filter((h) => h.counterOnAnswer);
        const answeredNothing =
          checkedDefects.length + checkedTraps.length === 0;
        const c = report.central;
        // Which concern each answer was about: the ledger's own order, so the
        // n-th located concern is the n-th defect, then the traps.
        const nameOf = (i: number): string =>
          manifest.defects[i]?.id ??
          (manifest.traps ?? [])[i - manifest.defects.length]?.id ??
          `#${i + 1}`;
        const notCentral = annotations.flatMap((a, i) =>
          a.verification?.central === false ? [nameOf(i)] : [],
        );
        // The scripted reviewer spends nothing, so the item's usage is the
        // verifier's own (plus the verifier model's pre-run check).
        const cost = item?.usage?.costUsd ?? task.usage?.costUsd;

        const unchecked = (n: number, of: number): string =>
          n < of ? ` (${of - n} not checked)` : "";
        console.info(
          `[${TAG}/${pin.label}] verifier=${item?.verification ?? "?"}@${item?.verifierSeat?.model ?? "?"}` +
            `/${item?.verifierSeat?.usage?.outputTokens ?? "?"}out chunks=${verifier.briefs.size}` +
            ` wall=${((Date.now() - started) / 1000).toFixed(1)}s` +
            `${cost === undefined ? " cost=unpriced" : ` cost=$${cost.toFixed(4)}`}`,
        );
        console.info(
          `[${TAG}/${pin.label}] central answered false on: ${notCentral.join(",") || "none"}`,
        );
        console.info(
          answeredNothing
            ? `[${TAG}/${pin.label}] not measured — the verifier recorded nothing` +
                ` (${item?.verification ?? "no state"}` +
                `${report.limits.length > 0 ? `: ${report.limits.join(", ")}` : ""})`
            : `[${TAG}/${pin.label}] traps withdrawn ${trapsWithdrawn.length}/${checkedTraps.length} checked` +
                `${unchecked(checkedTraps.length, report.traps.planted)}` +
                ` (counter on the answer: ${onAnswer.length})` +
                `; true defects withdrawn ${lostDefects.length}/${checkedDefects.length} checked` +
                `${unchecked(checkedDefects.length, defects.length)}` +
                `${lostDefects.length > 0 ? ` (${lostDefects.map((d) => d.id).join(",")})` : ""}` +
                `; central answered true ${c.centralTrue}/${c.asked} (false ${c.centralFalse})` +
                ` over ${c.majors} majors, ${c.blocking} flagged blocking`,
        );
        console.info(
          `[${TAG}/${pin.label}] ${formatVerificationReport(report)}`,
        );

        await evidence.discard();
      });
    },
  );
}
