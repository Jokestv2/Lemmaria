import { afterAll, describe, expect, it } from "vitest";
import type { Skill } from "../../src/contracts/skills.js";
import { buildConversationHistory } from "../../src/session/compaction.js";
import { summarizeToolArgs } from "../../src/session/tool-summary.js";
import {
  cleanupSessionHarnesses,
  createSessionHarness,
} from "../support/session-harness.js";

afterAll(cleanupSessionHarnesses);

const TONE: Skill = {
  name: "tone",
  description: "Voice rules for this paper.",
  body: "ALWAYS use active voice.",
  source: "project",
  path: ".lemmaria/skills/tone/SKILL.md",
  references: [],
};

const VENUE: Skill = {
  name: "venue-rules",
  description: "What this venue requires.",
  body: "NEVER exceed eight pages.",
  source: "project",
  path: ".lemmaria/skills/venue-rules/SKILL.md",
  references: [],
};

const systemOf = (messages: { role: string; content: string }[]): string =>
  messages.find((m) => m.role === "system")?.content ?? "";

/**
 * The end-to-end half of B7's acceptance gate (ADR 0028): the model is told
 * what exists, calls the tool, and the BODY lands in the conversation it sees
 * on the next turn. Everything else in this milestone is scaffolding for that.
 */
describe("load_skill end to end (B7)", () => {
  it("the model calls load_skill and the body reaches the conversation", async () => {
    const h = await createSessionHarness({
      turns: [
        {
          toolCalls: [{ id: "c1", name: "load_skill", args: { name: "tone" } }],
        },
        { text: "Done." },
      ],
    });
    const result = await h.run({ text: "polish this", skills: [TONE] });
    expect(result.status).toBe("completed");

    // Turn 1 was told the skill exists, but not what it says.
    const first = h.model.requests[0];
    expect(systemOf(first?.messages ?? [])).toContain("<name>tone</name>");
    expect(JSON.stringify(first?.messages)).not.toContain(
      "ALWAYS use active voice.",
    );
    expect((first?.tools ?? []).map((t) => t.name)).toContain("load_skill");

    // Turn 2 has the body, carried by the tool result.
    expect(JSON.stringify(h.model.requests[1]?.messages)).toContain(
      "ALWAYS use active voice.",
    );
    expect(h.itemTypes(result)).toEqual([
      "user_message",
      "tool_call",
      "agent_message",
    ]);
  });

  it("offers neither the tool nor the block when no skills are loaded", async () => {
    const h = await createSessionHarness({ turns: [{ text: "Done." }] });
    await h.run({ text: "hi" });
    const req = h.model.requests[0];
    expect((req?.tools ?? []).map((t) => t.name)).not.toContain("load_skill");
    expect(systemOf(req?.messages ?? [])).not.toContain("available_skills");
  });

  it("an UNEQUIPPED subagent child is offered no skills and no block", async () => {
    // ADR 0028 §D7's default, which R1 (ADR 0059) leaves standing: a child is
    // bounded read-only exploration returning a short report, so it gets
    // nothing unless its parent deliberately equips it. `runChild` forwards no
    // `skills` for such a child, so the surface has nothing to offer.
    const h = await createSessionHarness({ turns: [{ text: "report" }] });
    await h.run({ text: "explore", isChild: true });
    const req = h.model.requests[0];
    expect((req?.tools ?? []).map((t) => t.name)).not.toContain("load_skill");
    expect(systemOf(req?.messages ?? [])).not.toContain("available_skills");
  });

  it("an EQUIPPED child gets load_skill and a block naming only its set (R1)", async () => {
    // ADR 0059 supersedes §D7 in part: a child gets neither the tool nor the
    // block UNLESS its parent equips it, and then gets both — restricted to the
    // equipped set. `skills` reaching a child IS the equipping, because
    // `runChild` is the only caller that sets `isChild: true`.
    const h = await createSessionHarness({ turns: [{ text: "report" }] });
    await h.run({ text: "explore", skills: [TONE], isChild: true });
    const req = h.model.requests[0];
    expect((req?.tools ?? []).map((t) => t.name)).toContain("load_skill");
    const system = systemOf(req?.messages ?? []);
    expect(system).toContain("<name>tone</name>");
    // That the block names ONLY the equipped subset is decided where the
    // resolution happens — `loop-tools/subtask.test.ts` (a parent catalogue
    // wider than the request) and `run.test.ts`'s end-to-end row.
    // …the body is still withheld until the child asks for it.
    expect(JSON.stringify(req?.messages)).not.toContain(
      "ALWAYS use active voice.",
    );
  });

  it("an equipped child is STILL offered no update_plan and no spawn_subtask (R1)", async () => {
    // ADR 0059 moves the skills term only. The two gates that stay on
    // `isChild` are untouched — depth stays bounded to one level and a child
    // still has no todo plan (ADR 0022 §4, ADR 0028 §D7's reasoning).
    const h = await createSessionHarness({ turns: [{ text: "report" }] });
    await h.run({ text: "explore", skills: [TONE], isChild: true });
    const names = (h.model.requests[0]?.tools ?? []).map((t) => t.name);
    expect(names).toContain("load_skill");
    expect(names).not.toContain("update_plan");
    expect(names).not.toContain("spawn_subtask");
  });

  it("an unknown skill name is a failed tool row the model can act on", async () => {
    const h = await createSessionHarness({
      turns: [
        {
          toolCalls: [{ id: "c1", name: "load_skill", args: { name: "nope" } }],
        },
        { text: "I could not find that skill." },
      ],
    });
    const result = await h.run({ text: "use nope", skills: [TONE] });
    expect(result.status).toBe("completed");
    const call = result.items.find((i) => i.type === "tool_call");
    expect(call?.type === "tool_call" && call.resultJson).toContain(
      "not_found",
    );
    // The guidance names what IS available, so the next turn can self-correct.
    expect(JSON.stringify(h.model.requests[1]?.messages)).toContain("tone");
  });

  it("an explicit /skill: reaches the model but the transcript records what was typed", async () => {
    const h = await createSessionHarness({ turns: [{ text: "Done." }] });
    const result = await h.run({ text: "/skill:tone fix it", skills: [TONE] });
    // The model got the body without spending a turn on the tool…
    expect(JSON.stringify(h.model.requests[0]?.messages)).toContain(
      "ALWAYS use active voice.",
    );
    expect(JSON.stringify(h.model.requests[0]?.messages)).toContain("fix it");
    // …and the persisted item is the message the user actually sent.
    const userItem = result.items.find((i) => i.type === "user_message");
    expect(userItem?.type === "user_message" && userItem.text).toBe(
      "/skill:tone fix it",
    );
  });

  it("/skill: emits a real load_skill tool_call item, user-initiated (E1)", async () => {
    // The change ADR 0047 records: explicit invocation stops being a second
    // mechanism beside the tool and becomes the tool. No new item type, no new
    // contract field — the same `tool_call` a model-initiated load produces.
    const h = await createSessionHarness({ turns: [{ text: "Done." }] });
    const result = await h.run({ text: "/skill:tone fix it", skills: [TONE] });

    const call = result.items.find((i) => i.type === "tool_call");
    expect(call?.type).toBe("tool_call");
    if (call?.type !== "tool_call") return;
    expect(call.tool).toBe("load_skill");
    expect(JSON.parse(call.argsJson)).toEqual({ name: "tone" });
    expect(call.status).toBe("completed");
    expect(call.resultJson).toContain("ALWAYS use active voice.");

    // The user_message still holds EXACTLY the typed text (§D6 preserved), and
    // it comes before the exchange.
    const order = result.items.map((i) => i.type);
    expect(order.indexOf("user_message")).toBeLessThan(
      order.indexOf("tool_call"),
    );
  });

  it("TWO /skill: tokens emit TWO exchanges, in the order named (ADR 0050)", async () => {
    // The `for` that replaced an `if` in run.ts. Under ADR 0047 a message had
    // one invocation by construction, so the second name here would have been
    // prose and the venue's rules would have silently not loaded.
    const h = await createSessionHarness({ turns: [{ text: "Done." }] });
    const result = await h.run({
      text: "/skill:tone and /skill:venue-rules fix it",
      skills: [TONE, VENUE],
    });

    const calls = result.items.filter((i) => i.type === "tool_call");
    expect(calls).toHaveLength(2);
    expect(
      calls.map((c) =>
        c.type === "tool_call" ? JSON.parse(c.argsJson) : null,
      ),
    ).toEqual([{ name: "tone" }, { name: "venue-rules" }]);
    expect(
      calls.every((c) => c.type === "tool_call" && c.status === "completed"),
    ).toBe(true);

    // BOTH bodies reach the model on the first turn — the point of naming two.
    const sent = JSON.stringify(h.model.requests[0]?.messages);
    expect(sent).toContain("ALWAYS use active voice.");
    expect(sent).toContain("NEVER exceed eight pages.");

    // And the shape is still user-first, then ONE assistant turn carrying both
    // calls followed by both results — a batch, not two exchanges, because
    // that is what `plainHistory` rebuilds a run of tool_call items into. Two
    // separate assistant turns here would make a resumed session send a
    // different shape from a fresh one, which is the invariant below.
    const live = (h.model.requests[0]?.messages ?? []).filter(
      (m) => m.role !== "system",
    );
    expect(live.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
    ]);
    expect(live[1]?.toolCalls?.map((c) => c.name)).toEqual([
      "load_skill",
      "load_skill",
    ]);
    expect(JSON.stringify(live)).toBe(
      JSON.stringify(
        buildConversationHistory(result.items, "claude-sonnet-4-5").slice(
          0,
          live.length,
        ),
      ),
    );
  });

  it("a MID-MESSAGE /skill: really invokes, not just offers (ADR 0050)", async () => {
    // The half the composer cannot prove on its own: `completion.ts`'s
    // `boundary` anchor and `INVOCATION_RE` are the same rule stated twice, and
    // this is the assertion that they stayed the same rule. A menu that
    // inserted a token the harness read as prose is exactly the failure the
    // module comment forbids.
    const h = await createSessionHarness({ turns: [{ text: "Done." }] });
    const result = await h.run({
      text: "please rewrite the intro /skill:tone before I send it",
      skills: [TONE],
    });

    const call = result.items.find((i) => i.type === "tool_call");
    expect(call?.type === "tool_call" && JSON.parse(call.argsJson)).toEqual({
      name: "tone",
    });
    expect(JSON.stringify(h.model.requests[0]?.messages)).toContain(
      "ALWAYS use active voice.",
    );
    // The typed text is still persisted verbatim, token and all (§D6).
    const userItem = result.items.find((i) => i.type === "user_message");
    expect(userItem?.type === "user_message" && userItem.text).toBe(
      "please rewrite the intro /skill:tone before I send it",
    );
  });

  it("THE REGRESSION: the body survives a rebuilt history (E1)", async () => {
    // This is the whole point of the milestone's §4. Under ADR 0028 §D6 the
    // expansion was model-visible ONLY, so a resumed or compacted session
    // replayed "/skill:tone fix it" with no body behind it — the user's
    // explicit instruction evaporating exactly when a long session needed it.
    // Before this change the assertion below failed.
    const h = await createSessionHarness({ turns: [{ text: "Done." }] });
    const result = await h.run({ text: "/skill:tone fix it", skills: [TONE] });

    const rebuilt = buildConversationHistory(result.items, "claude-sonnet-4-5");
    expect(JSON.stringify(rebuilt)).toContain("ALWAYS use active voice.");

    // And it rebuilds as an assistant tool-call message plus its result — the
    // same shape the live history had, which is why a provider cannot tell a
    // resumed session from a fresh one.
    const assistant = rebuilt.find(
      (m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0,
    );
    expect(assistant?.toolCalls?.[0]?.name).toBe("load_skill");
    expect(
      rebuilt.some(
        (m) => m.role === "tool" && m.content.includes("active voice"),
      ),
    ).toBe(true);

    // The typed text is still there too, unexpanded.
    expect(
      rebuilt.some(
        (m) => m.role === "user" && m.content === "/skill:tone fix it",
      ),
    ).toBe(true);
  });

  it("the LIVE history and the REBUILT one are byte-identical (E1)", async () => {
    // The property the ordering exists for, and the one a comment alone cannot
    // hold. Found by review: the exchange used to be pushed BEFORE the user
    // message, so on the first task of a session the request began with an
    // `assistant` turn — which the Anthropic Messages API does not accept —
    // and a resumed session sent a different shape from a fresh one.
    const h = await createSessionHarness({ turns: [{ text: "Done." }] });
    const result = await h.run({ text: "/skill:tone fix it", skills: [TONE] });

    const live = (h.model.requests[0]?.messages ?? []).filter(
      (m) => m.role !== "system",
    );
    const rebuilt = buildConversationHistory(result.items, "claude-sonnet-4-5");

    expect(live.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    // The rebuild is over the FINISHED transcript, so it carries the agent's
    // reply that the first request could not have had — compare the prefix.
    expect(JSON.stringify(live)).toBe(
      JSON.stringify(rebuilt.slice(0, live.length)),
    );
    // And the first non-system turn is a `user` one, which every provider
    // requires and one of them enforces.
    expect(live[0]?.role).toBe("user");
  });

  it("the synthetic exchange is NOT charged to the tool-call budget (E1)", async () => {
    // It is the user's own instruction, not a call the model chose to spend a
    // budgeted turn on — `tool-batch.ts`'s countCall() is deliberately not
    // reached. Pinned because nothing else would notice it starting to charge.
    const h = await createSessionHarness({
      turns: [
        {
          toolCalls: [{ id: "c1", name: "load_skill", args: { name: "tone" } }],
        },
        { text: "Done." },
      ],
    });
    const result = await h.run({ text: "/skill:tone fix it", skills: [TONE] });
    // Two tool_call items — the synthetic one and the model's own…
    expect(result.items.filter((i) => i.type === "tool_call")).toHaveLength(2);
    // …and the run completed rather than tripping a budget it should not have
    // been charged against.
    expect(result.status).toBe("completed");
  });

  it("/skill: with no request still sends the typed text as the turn (E1)", async () => {
    // "apply this skill" is a real instruction, so the turn must not be empty.
    const h = await createSessionHarness({ turns: [{ text: "Done." }] });
    await h.run({ text: "/skill:tone", skills: [TONE] });
    const messages = JSON.stringify(h.model.requests[0]?.messages);
    expect(messages).toContain("ALWAYS use active voice.");
    expect(messages).toContain("/skill:tone");
  });

  it("an unknown /skill: name emits no tool_call — it is prose (E1)", async () => {
    const h = await createSessionHarness({ turns: [{ text: "Done." }] });
    const result = await h.run({ text: "/skill:nope fix it", skills: [TONE] });
    expect(result.items.some((i) => i.type === "tool_call")).toBe(false);
    expect(JSON.stringify(h.model.requests[0]?.messages)).toContain(
      "/skill:nope fix it",
    );
  });

  it("an UNEQUIPPED child's /skill: goal stays prose (E1 row 19, re-homed)", async () => {
    // The §D7 surface gate, unchanged by E1 and unchanged by R1: `/skill:` is
    // gated on the SURFACE, not on `opts.skills`. An unequipped child is
    // offered no skills, so it emits no exchange — exactly as a task in a
    // session where the host loaded none.
    const h = await createSessionHarness({ turns: [{ text: "report" }] });
    const result = await h.run({
      text: "/skill:tone explore",
      isChild: true,
    });
    expect(JSON.stringify(h.model.requests[0]?.messages)).not.toContain(
      "ALWAYS use active voice.",
    );
    expect(result.items.some((i) => i.type === "tool_call")).toBe(false);
  });

  it("an EQUIPPED child's /skill: goal becomes a real exchange (R1, D5)", async () => {
    // ADR 0059 narrows ADR 0047's example rather than changing its mechanism:
    // the gate is still the surface, and an equipped child's surface offers
    // skills — so the parent CAN force the body in, byte-exact, before the
    // child's first turn. Nothing new was written to make this true.
    const h = await createSessionHarness({ turns: [{ text: "report" }] });
    const result = await h.run({
      text: "/skill:tone explore",
      skills: [TONE],
      isChild: true,
    });
    const first = h.model.requests[0];
    expect(JSON.stringify(first?.messages)).toContain(
      "ALWAYS use active voice.",
    );
    // The synthetic exchange sits at the HEAD of the child's history, after
    // the goal — the ADR 0047 shape `plainHistory` rebuilds.
    expect((first?.messages ?? []).map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(h.itemTypes(result)).toEqual([
      "user_message",
      "tool_call",
      "agent_message",
    ]);
  });

  it("an equipped child's /skill: for an UNEQUIPPED name stays prose (R1, D5)", async () => {
    // `parseSkillInvocations` resolves only names in the offered set, and an
    // equipped child's offered set is exactly what it was equipped with. A
    // goal naming a skill the child does not hold is neither rejected nor
    // auto-equipped — it is a typo, and it stays prose.
    const h = await createSessionHarness({ turns: [{ text: "report" }] });
    const result = await h.run({
      text: "/skill:venue-rules explore",
      skills: [TONE],
      isChild: true,
    });
    expect(JSON.stringify(h.model.requests[0]?.messages)).not.toContain(
      "NEVER exceed eight pages.",
    );
    expect(result.items.some((i) => i.type === "tool_call")).toBe(false);
    expect(JSON.stringify(h.model.requests[0]?.messages)).toContain(
      "/skill:venue-rules explore",
    );
  });

  it("the persisted args carry the key the row summarizer reads", async () => {
    // The hazard `tool-summary.ts` was written against: the summarizer guessing
    // an argument name the tool never emits, and silently blanking the row.
    // Asserting the REAL persisted argsJson through the REAL summarizer is the
    // only thing that rules it out.
    const h = await createSessionHarness({
      turns: [
        {
          toolCalls: [{ id: "c1", name: "load_skill", args: { name: "tone" } }],
        },
        { text: "Done." },
      ],
    });
    const result = await h.run({ text: "polish", skills: [TONE] });
    const call = result.items.find((i) => i.type === "tool_call");
    expect(call?.type).toBe("tool_call");
    if (call?.type !== "tool_call") return;
    expect(summarizeToolArgs(call.tool, call.argsJson)).toEqual({
      text: "tone",
    });
  });
});
