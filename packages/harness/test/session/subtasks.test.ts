import { describe, expect, it } from "vitest";
import type { SessionItem } from "../../src/contracts/index.js";
import { ok } from "../../src/contracts/results.js";
import {
  READ_ONLY_CHILD_TOOLS,
  lastAgentSummary,
  narrowChildTools,
  parseSpawnSubtaskArgs,
  sumUsage,
} from "../../src/session/subtasks.js";
import { unwrapErr } from "../support/results.js";

describe("subtask helpers (A3)", () => {
  it("READ_ONLY_CHILD_TOOLS excludes every mutating / session-scoped tool", () => {
    for (const forbidden of [
      "propose_edit",
      "run_script",
      "update_plan",
      "spawn_subtask",
      "apply_edit",
      "verify",
    ]) {
      expect(READ_ONLY_CHILD_TOOLS as readonly string[]).not.toContain(
        forbidden,
      );
    }
    expect(READ_ONLY_CHILD_TOOLS).toContain("read_span");
    expect(READ_ONLY_CHILD_TOOLS).toContain("grep_project");
  });

  it("narrows to read-only ∩ parent ∩ requested — never widening", () => {
    const parent = [
      "read_span",
      "grep_project",
      "propose_edit",
      "list_files",
    ] as const;
    // no request → all read-only tools the parent has (propose_edit dropped)
    expect(narrowChildTools([...parent])).toEqual([
      "read_span",
      "grep_project",
      "list_files",
    ]);
    // request narrows further; a request for a mutating tool or one the parent
    // lacks is refused
    expect(
      narrowChildTools(
        [...parent],
        ["grep_project", "propose_edit", "count_words"],
      ),
    ).toEqual(["grep_project"]);
  });

  it("parses a children array and rejects a malformed one", () => {
    expect(
      parseSpawnSubtaskArgs({
        children: [{ goal: "a" }, { goal: "b", allowed_tools: ["read_span"] }],
      }),
    ).toEqual(ok([{ goal: "a" }, { goal: "b", allowedTools: ["read_span"] }]));
    // ADR 0024: a malformed request is an `invalid` failure, never a throw.
    for (const args of [{ children: [] }, { children: [{ goal: "" }] }, {}]) {
      expect(unwrapErr(parseSpawnSubtaskArgs(args)).code).toBe("invalid");
    }
  });

  it("rejects a malformed allowed_tools instead of silently widening (review)", () => {
    // present-but-wrong-type must be an error, not "absent" (which widens the
    // child to every parent read tool).
    for (const bad of ["read_span", [1, 2]]) {
      const error = unwrapErr(
        parseSpawnSubtaskArgs({
          children: [{ goal: "a", allowed_tools: bad }],
        }),
      );
      expect(error.code).toBe("invalid");
      expect(error.message).toMatch(/allowed_tools/);
    }
    // a genuinely absent allowed_tools is still fine (default = all read tools).
    expect(parseSpawnSubtaskArgs({ children: [{ goal: "a" }] })).toEqual(
      ok([{ goal: "a" }]),
    );
  });

  it("parses a per-child skills list, de-duplicated, in given order (R1)", () => {
    // ADR 0059 / D1: names exactly as they appear in the parent's
    // <available_skills> block. Duplicates collapse — naming a skill twice is a
    // typo, not a request to load it twice (the ADR 0050 rule).
    expect(
      parseSpawnSubtaskArgs({
        children: [{ goal: "a", skills: ["b", "a", "b"] }],
      }),
    ).toEqual(ok([{ goal: "a", skills: ["b", "a"] }]));
    // Absent → no key at all, so an unequipped child is byte-identical to
    // pre-R1 (the D7 identity claim starts here).
    expect(parseSpawnSubtaskArgs({ children: [{ goal: "a" }] })).toEqual(
      ok([{ goal: "a" }]),
    );
    // An explicit empty list is carried through and means unequipped.
    expect(
      parseSpawnSubtaskArgs({ children: [{ goal: "a", skills: [] }] }),
    ).toEqual(ok([{ goal: "a", skills: [] }]));
    // It coexists with allowed_tools rather than replacing it.
    expect(
      parseSpawnSubtaskArgs({
        children: [{ goal: "a", allowed_tools: ["read_span"], skills: ["s"] }],
      }),
    ).toEqual(ok([{ goal: "a", allowedTools: ["read_span"], skills: ["s"] }]));
  });

  it("rejects a malformed skills instead of silently UN-equipping (R1)", () => {
    // The `allowed_tools` rule at the same site, for the mirror-image reason:
    // treating a bad list as absent would silently strip the guidance the
    // parent meant to hand down — the exact failure R1 exists to remove.
    for (const bad of ["a", [1], [null], {}]) {
      const error = unwrapErr(
        parseSpawnSubtaskArgs({ children: [{ goal: "a", skills: bad }] }),
      );
      expect(error.code).toBe("invalid");
      expect(error.message).toMatch(/skills/);
    }
    // A malformed skills on the SECOND child rejects the WHOLE call — the
    // pre-flight, deny-by-default rule (D2): no child runs on a bad request.
    const error = unwrapErr(
      parseSpawnSubtaskArgs({
        children: [{ goal: "a" }, { goal: "b", skills: "nope" }],
      }),
    );
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/skills/);
  });

  it("lastAgentSummary returns the final agent message or an honest note in ONE language", () => {
    const items: SessionItem[] = [
      { id: "u", type: "user_message", text: "go" },
      { id: "a1", type: "agent_message", text: "first" },
      { id: "a2", type: "agent_message", text: "final report" },
    ];
    expect(lastAgentSummary(items)).toBe("final report");
    expect(
      lastAgentSummary([{ id: "u", type: "user_message", text: "go" }]),
    ).toBe("(the subtask produced no report)");
    // ADR 0034: the SAME call renders differently per locale — never both at
    // once. Asserting one string against two languages was the D1 mistake.
    expect(lastAgentSummary([], "zh")).toBe("（子任务没有产生报告）");
  });

  it("sumUsage adds token/cost fields and ignores undefined", () => {
    expect(
      sumUsage([
        { inputTokens: 10, outputTokens: 5, costUsd: 0.5 },
        undefined,
        { inputTokens: 3, outputTokens: 2, costUsd: 0.25 },
      ]),
    ).toEqual({ inputTokens: 13, outputTokens: 7, costUsd: 0.75 });
    expect(sumUsage([undefined, undefined])).toBeUndefined();
  });

  it("sumUsage omits costUsd when no child reported one (honest, ADR 0002)", () => {
    expect(
      sumUsage([
        { inputTokens: 4, outputTokens: 1 },
        { inputTokens: 2, outputTokens: 1 },
      ]),
    ).toEqual({ inputTokens: 6, outputTokens: 2 });
  });
});

describe("view_pdf_pages is child-safe (V3, ADR 0080 §7)", () => {
  it("is in READ_ONLY_CHILD_TOOLS — V4's visual seat is a child", () => {
    expect(READ_ONLY_CHILD_TOOLS).toContain("view_pdf_pages");
  });

  it("reaches a child only when the PARENT had it", () => {
    expect(narrowChildTools(["read_span", "view_pdf_pages"])).toContain(
      "view_pdf_pages",
    );
    // A parent without it cannot hand it down — ADR 0022 §3's guarantee.
    expect(narrowChildTools(["read_span"])).not.toContain("view_pdf_pages");
  });

  it("a child that did not request it does not get it", () => {
    expect(
      narrowChildTools(["read_span", "view_pdf_pages"], ["read_span"]),
    ).toEqual(["read_span"]);
  });
});
