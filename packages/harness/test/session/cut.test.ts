import { describe, expect, it } from "vitest";
import type { SessionEntry, SessionItem } from "../../src/contracts/index.js";
import { cutBeforeItem } from "../../src/session/cut.js";

/**
 * An item-bearing entry. The node id and the item id are deliberately
 * unrelated — `cutBeforeItem` resolves an ITEM id and answers with a POSITION,
 * and a fixture that reused one for the other could pass while confusing them.
 */
function itemEntry(nodeId: string, item: SessionItem): SessionEntry {
  return {
    id: nodeId,
    event: { type: "item.completed", item },
  };
}

function said(nodeId: string, itemId: string): SessionEntry {
  return itemEntry(nodeId, { id: itemId, type: "user_message", text: itemId });
}

function turn(nodeId: string): SessionEntry {
  return {
    id: nodeId,
    event: { type: "turn.started", turn: 1 },
  };
}

describe("cutBeforeItem", () => {
  it("returns the INDEX of the record that carried the item", () => {
    const entries = [said("n0", "a"), turn("n1"), said("n2", "b")];
    // The copy is entries.slice(0, cut), so 2 means "a and the turn travel; b
    // and everything after it do not" — the whole contract in one number.
    expect(cutBeforeItem(entries, "b")).toBe(2);
  });

  it("returns 0 for the first record — an empty copy, never a refusal", () => {
    // The one place the retired node-id space and this index space differ in
    // FALSINESS: `nodeBeforeItem` answered `null` here and callers tested for
    // it explicitly. `0` is falsy, so every caller must test `=== undefined`.
    const entries = [said("n0", "a"), said("n1", "b")];
    expect(cutBeforeItem(entries, "a")).toBe(0);
    expect(cutBeforeItem(entries, "a")).not.toBeUndefined();
  });

  it("is undefined for an item no record carries, so a caller can refuse", () => {
    // ADR 0018's rule, carried forward: an unresolvable target refuses rather
    // than widening the move.
    expect(cutBeforeItem([said("n0", "a")], "nope")).toBeUndefined();
  });

  it("resolves to the FIRST record of a twice-persisted item", () => {
    // edit_proposal / script_run / subtask persist pending-then-terminal; a
    // rewind past one must land before it APPEARED, not before it settled
    // (ADR 0027 §1's first-record rule, kept verbatim).
    const proposal = (status: "pending" | "applied"): SessionItem => ({
      id: "p",
      type: "edit_proposal",
      policy: "auto_apply",
      edits: [{ file: "a.tex", status, kind: "replace" }],
    });
    const entries = [
      said("n0", "a"),
      itemEntry("n1", proposal("pending")),
      itemEntry("n2", proposal("applied")),
    ];
    expect(cutBeforeItem(entries, "p")).toBe(1);
  });

  it("counts every entry, not only item-bearing ones", () => {
    // The index addresses the ENTRY array, which is what the copy slices and
    // what `manifestAt` folds. Counting only items would silently drop the
    // turn records a copy has to carry for usage to stay honest.
    const entries = [turn("n0"), turn("n1"), said("n2", "a")];
    expect(cutBeforeItem(entries, "a")).toBe(2);
  });

  it("is undefined for an empty session", () => {
    expect(cutBeforeItem([], "a")).toBeUndefined();
  });
});
