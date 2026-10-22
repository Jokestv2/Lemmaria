import { describe, expect, it } from "vitest";
import {
  choiceAt,
  createDecisionMemory,
  forgetDecisions,
  groupDecisionView,
  liveChoices,
  rememberPosted,
} from "../src/webview/parts/decision.js";

describe("groupDecisionView (CHAT-5)", () => {
  describe("with no local choice, the server status passes through verbatim", () => {
    // The optimism-retraction guard, and the ONLY thing standing between an
    // optimistic row and one stuck forever: the local choice now outlives the
    // post (see the decision memory below), so what ends the optimistic view
    // is this refusal to override a status the server has settled.
    for (const status of [
      "applied",
      "pending",
      "stale",
      "rejected",
      "invalid",
    ] as const) {
      it(`passes through ${status}`, () => {
        const v = groupDecisionView({ serverStatus: status });
        expect(v.status).toBe(status);
        expect(v.optimistic).toBe(false);
      });
    }
  });

  it("shows accepted immediately, before the host has echoed anything", () => {
    // Codex writes the decision into history in past tense BEFORE firing the
    // backend call and treats it as fact (ADR 0037 §5). Today Lemmaria's row
    // keeps saying `pending` until a write-through-buffer save round-trips —
    // which is the reported "clicking Accept appears to do nothing".
    const v = groupDecisionView({
      serverStatus: "pending",
      localChoice: { accept: true },
    });
    expect(v.status).toBe("applied");
    expect(v.optimistic).toBe(true);
  });

  it("shows rejected immediately", () => {
    const v = groupDecisionView({
      serverStatus: "pending",
      localChoice: { accept: false },
    });
    expect(v.status).toBe("rejected");
    expect(v.optimistic).toBe(true);
  });

  it("does not override a status the server has already settled", () => {
    // A stale edit is not made fresh by clicking Accept, and saying so would
    // be a lie the user acts on.
    const v = groupDecisionView({
      serverStatus: "stale",
      localChoice: { accept: true },
    });
    expect(v.status).toBe("stale");
    expect(v.optimistic).toBe(false);
  });

  it("reports how many files the batch is still waiting on", () => {
    // CHAT-5 cause (b): `maybePostDecisions` posts nothing until every pending
    // edit has a choice, so on a three-file proposal deciding the first
    // genuinely does nothing — and said nothing.
    const v = groupDecisionView({
      serverStatus: "pending",
      localChoice: { accept: true },
      undecidedRemaining: 2,
    });
    expect(v.waitingFor).toBe(2);
  });

  it("waits for nothing once the batch is fully decided", () => {
    expect(
      groupDecisionView({
        serverStatus: "pending",
        localChoice: { accept: true },
        undecidedRemaining: 0,
      }).waitingFor,
    ).toBe(0);
  });

  it("never reports waiting on a row that has not been decided", () => {
    // The label belongs to the file you just decided, not to the ones you
    // have not looked at yet.
    expect(
      groupDecisionView({ serverStatus: "pending", undecidedRemaining: 2 })
        .waitingFor,
    ).toBe(0);
  });
});

describe("the decision memory — the half the first cut got wrong", () => {
  it("still knows the choice AFTER the decisions are posted", () => {
    // The regression that shipped in D2's first cut and the code review
    // caught: posting deletes the collecting entry, and the re-render that
    // follows it in the same tick is the ONE render the optimistic state
    // exists for. On a single-file proposal — the common case — that put the
    // row straight back to `● pending` with its buttons, i.e. exactly the
    // pre-D2 behaviour CHAT-5 exists to fix.
    const mem = createDecisionMemory();
    liveChoices(mem, "p1").set(0, { accept: true });
    rememberPosted(mem, "p1");
    expect(choiceAt(mem, "p1", 0)).toEqual({ accept: true });
  });

  it("stops collecting into the live map once posted", () => {
    // The live map is what gates posting (`every index has a choice`). If a
    // posted batch stayed in it, a later render would re-post it.
    const mem = createDecisionMemory();
    liveChoices(mem, "p1").set(0, { accept: true });
    rememberPosted(mem, "p1");
    expect(liveChoices(mem, "p1").size).toBe(0);
  });

  it("reads a live choice in preference to a posted one", () => {
    const mem = createDecisionMemory();
    liveChoices(mem, "p1").set(0, { accept: false });
    rememberPosted(mem, "p1");
    liveChoices(mem, "p1").set(0, { accept: true });
    expect(choiceAt(mem, "p1", 0)).toEqual({ accept: true });
  });

  it("knows nothing about an item nobody has decided", () => {
    const mem = createDecisionMemory();
    expect(choiceAt(mem, "p1", 0)).toBeUndefined();
  });

  it("keeps proposals apart", () => {
    const mem = createDecisionMemory();
    liveChoices(mem, "p1").set(0, { accept: true });
    rememberPosted(mem, "p1");
    expect(choiceAt(mem, "p2", 0)).toBeUndefined();
  });

  it("forgets everything on a reset, both layers", () => {
    // A pending batch that outlived a reload is decided again from the card;
    // a stale memory would mislabel its rows.
    const mem = createDecisionMemory();
    liveChoices(mem, "p1").set(0, { accept: true });
    rememberPosted(mem, "p1");
    liveChoices(mem, "p2").set(0, { accept: false });
    forgetDecisions(mem);
    expect(choiceAt(mem, "p1", 0)).toBeUndefined();
    expect(choiceAt(mem, "p2", 0)).toBeUndefined();
  });

  it("is retracted by the server's own word, with no extra bookkeeping", () => {
    // The memory has no expiry of its own and needs none: `groupDecisionView`
    // refuses to override any settled status, so the host's `applied` /
    // `rejected` / `stale` echo is what ends the optimistic view. This is the
    // equivalent of Codex's `dismiss_resolved_request`.
    const mem = createDecisionMemory();
    liveChoices(mem, "p1").set(0, { accept: true });
    rememberPosted(mem, "p1");
    const choice = choiceAt(mem, "p1", 0);
    expect(
      groupDecisionView({ serverStatus: "pending", localChoice: choice }),
    ).toMatchObject({ status: "applied", optimistic: true });
    expect(
      groupDecisionView({ serverStatus: "stale", localChoice: choice }),
    ).toMatchObject({ status: "stale", optimistic: false });
  });
});
