// E6 (ADR 0058 §2, §7): the Sessions view's TEMPLATED strings — the ones that
// carry a number or a title and therefore cannot live in `chrome-strings.ts`,
// whose test suite pins every value static.
//
// Asserted per locale, both renderings in full, which is the pattern
// `test-webview/strings.test.ts` established: a ternary's two arms are
// otherwise reachable only by relaunching VS Code under a different display
// language, which is exactly the gap the E5 coverage-debt entry filed against
// the rewind path's inline `isZh()` strings.
import * as assert from "node:assert";
import {
  caveatDrifted,
  caveatMissingSnapshots,
  caveatNoWorkspace,
  caveatRestoreThrew,
  forkOrdinalPrefix,
  forkedFromTooltip,
  proposedEditTitle,
  relativeTimeLabel,
  restoreFailedLine,
  sessionRowDescription,
  sessionRowLabel,
  sessionRowTooltip,
  withCaveats,
} from "../src/session-labels";

suite("session-labels — the fork ordinal prefix", () => {
  test("English ordinal suffixes, including the teens and the 21st", () => {
    const en = (n: number) => forkOrdinalPrefix(n, "en");
    assert.strictEqual(en(1), "(forked from 1st message) ");
    assert.strictEqual(en(2), "(forked from 2nd message) ");
    assert.strictEqual(en(3), "(forked from 3rd message) ");
    assert.strictEqual(en(4), "(forked from 4th message) ");
    // 11–13 are the rule every naive `n % 10` implementation gets wrong.
    assert.strictEqual(en(11), "(forked from 11th message) ");
    assert.strictEqual(en(12), "(forked from 12th message) ");
    assert.strictEqual(en(13), "(forked from 13th message) ");
    assert.strictEqual(en(21), "(forked from 21st message) ");
    assert.strictEqual(en(22), "(forked from 22nd message) ");
    assert.strictEqual(en(23), "(forked from 23rd message) ");
    assert.strictEqual(en(101), "(forked from 101st message) ");
    assert.strictEqual(en(111), "(forked from 111th message) ");
  });

  test("Chinese counts with 第 N 条 and needs no ordinal suffix", () => {
    assert.strictEqual(forkOrdinalPrefix(1, "zh"), "（从第 1 条消息分叉）");
    assert.strictEqual(forkOrdinalPrefix(13, "zh"), "（从第 13 条消息分叉）");
    assert.strictEqual(forkOrdinalPrefix(21, "zh"), "（从第 21 条消息分叉）");
  });

  test("neither rendering carries a word of the other language", () => {
    // Invariant 6 rule 2 in its strongest form: one language per reader. The
    // `check-mixed-language-strings` sweep cannot see a COMPOSED string, so
    // the composition is asserted here instead.
    for (const n of [1, 2, 3, 11, 21]) {
      assert.ok(!/[一-鿿]/.test(forkOrdinalPrefix(n, "en")));
      assert.ok(!/[a-z]/i.test(forkOrdinalPrefix(n, "zh")));
    }
  });
});

suite("session-labels — the row label", () => {
  const forked = (atMessage?: number) => ({
    sessionId: "p",
    cutBeforeItemId: "m",
    ...(atMessage === undefined ? {} : { atMessage }),
  });

  test("a rewind fork reads as its ordinal plus its title", () => {
    assert.strictEqual(
      sessionRowLabel({ title: "fix the lemma", forkedFrom: forked(3) }, "en"),
      "(forked from 3rd message) fix the lemma",
    );
    assert.strictEqual(
      sessionRowLabel({ title: "修复引理", forkedFrom: forked(3) }, "zh"),
      "（从第 3 条消息分叉）修复引理",
    );
  });

  test("an untitled fork is JUST the prefix, with no trailing space", () => {
    // The operator's ask: "if the user only forked a message but didn't send
    // the new message, we can leave XXX empty." A trailing space would render
    // as a ragged row against every other one.
    assert.strictEqual(
      sessionRowLabel({ title: "", forkedFrom: forked(2) }, "en"),
      "(forked from 2nd message)",
    );
    assert.strictEqual(
      sessionRowLabel({ title: "", forkedFrom: forked(2) }, "zh"),
      "（从第 2 条消息分叉）",
    );
  });

  test("a session that was created, or forked at the end, is its title alone", () => {
    assert.strictEqual(
      sessionRowLabel({ title: "the intro" }, "en"),
      "the intro",
    );
    // `/fork` cuts before nothing, so it records no ordinal (ADR 0058 §2) —
    // and its child keeps the name it was given, unprefixed.
    assert.strictEqual(
      sessionRowLabel(
        {
          title: "another angle",
          forkedFrom: { sessionId: "p", cutBeforeItemId: null },
        },
        "en",
      ),
      "another angle",
    );
  });

  test("an untitled session with no lineage renders empty, never a placeholder", () => {
    // A synthesized "(untitled)" would be a string the store never wrote, and
    // the store's own `sessionTitle("")` is `""` — there is no sentinel.
    assert.strictEqual(sessionRowLabel({ title: "" }, "en"), "");
  });
});

suite("session-labels — the rewind path's outcome lines (D13)", () => {
  test("caveats ride the line, in the reader's punctuation", () => {
    assert.strictEqual(withCaveats("Done.", [], "en"), "Done.");
    assert.strictEqual(withCaveats("完成。", [], "zh"), "完成。");
    assert.strictEqual(
      withCaveats("Done.", ["one thing", "another"], "en"),
      "Done. (one thing; another)",
    );
    assert.strictEqual(
      withCaveats("完成。", ["一件事", "另一件"], "zh"),
      "完成。（一件事；另一件）",
    );
  });

  test("a failed restore says whether the fork was lost with it", () => {
    // E5's sentence ends "so the conversation did NOT fork", which is true of
    // the both arm and false of the restore-only one. Existing copy moves
    // verbatim only where the sentence stays true (D13).
    assert.strictEqual(
      restoreFailedLine(["no snapshot"], "both", "en"),
      "Lemmaria: could not restore the files, so the conversation did NOT fork — no snapshot.",
    );
    assert.strictEqual(
      restoreFailedLine(["no snapshot"], "restore", "en"),
      "Lemmaria: could not restore the files — no snapshot.",
    );
    assert.ok(!/fork/i.test(restoreFailedLine([], "restore", "en")));
    assert.ok(/未从该消息处分叉/.test(restoreFailedLine([], "both", "zh")));
    assert.ok(!/分叉/.test(restoreFailedLine([], "restore", "zh")));
  });

  test("every caveat renders whole in each language, and never in both", () => {
    const each = (locale: "en" | "zh") => [
      caveatNoWorkspace(2, locale),
      caveatRestoreThrew("EPERM", locale),
      caveatDrifted(3, locale),
      caveatMissingSnapshots(1, locale),
    ];
    for (const line of each("en")) {
      assert.ok(line.length > 0);
      assert.ok(!/[一-鿿]/.test(line), `English caveat has Chinese: ${line}`);
    }
    for (const line of each("zh")) {
      // Two things are deliberately not English PROSE and are stripped before
      // the sweep. `Lemmaria` is the product's name — a proper noun that
      // stands in every locale, which is why the whole `zh` chrome table
      // opens with it. `EPERM` is the system's own word, passed through:
      // invariant 6's stated boundary, the same one a skill description and a
      // filename sit on. What is being asserted is that nothing else Latin
      // survives — no sentence, no clause, no stray label.
      const prose = line.replace(/Lemmaria/g, "").replace("EPERM", "");
      assert.ok(
        !/[a-z]{3,}/i.test(prose),
        `Chinese caveat has English: ${line}`,
      );
    }
    // The numbers are real, not dropped on the way through a template.
    assert.ok(caveatNoWorkspace(2, "en").includes("2"));
    assert.ok(caveatNoWorkspace(2, "zh").includes("2"));
  });

  test("the proposal diff title names the file in either language", () => {
    assert.strictEqual(
      proposedEditTitle("a/b.tex", "en"),
      "a/b.tex — proposed edit",
    );
    assert.strictEqual(
      proposedEditTitle("a/b.tex", "zh"),
      "a/b.tex — 拟议编辑",
    );
  });
});

suite("session-labels — the Sessions row's own strings (D13)", () => {
  const row = (
    over: Partial<Parameters<typeof sessionRowDescription>[0]> = {},
  ) => ({
    active: false,
    relative: "3h",
    ...over,
  });

  test("the description says active, how long ago, and whether disk agrees", () => {
    assert.strictEqual(sessionRowDescription(row(), " ≠", "en"), "3h");
    assert.strictEqual(
      sessionRowDescription(row({ active: true }), " ≠", "en"),
      "● active · 3h",
    );
    assert.strictEqual(
      sessionRowDescription(row({ active: true }), " ≠", "zh"),
      "● 当前 · 3h",
    );
    // The marker ENDS the string, so it is at the row's right edge whatever
    // else the row says — the active row included (ADR 0058 §7).
    assert.strictEqual(
      sessionRowDescription(row({ active: true, outOfSync: true }), " ≠", "en"),
      "● active · 3h ≠",
    );
    assert.strictEqual(
      sessionRowDescription(row({ outOfSync: true }), " ≠", "zh"),
      "3h ≠",
    );
  });

  test("an active row with no timestamp does not trail a separator", () => {
    assert.strictEqual(
      sessionRowDescription(row({ active: true, relative: "" }), " ≠", "en"),
      "● active",
    );
  });

  test("the tooltip is one language per reader, with the parts it was given", () => {
    const parts = { label: "fix it", when: "9:00", forks: "\nF", stale: "\nS" };
    assert.strictEqual(
      sessionRowTooltip(parts, "en"),
      "fix it\nLast activity: 9:00\nF\nS\nClick to resume this session.",
    );
    assert.strictEqual(
      sessionRowTooltip(parts, "zh"),
      "fix it\n最后活动：9:00\nF\nS\n点击以恢复该会话。",
    );
  });

  test("how long ago reads whole in each language, and switches to a date past a week", () => {
    const iso = "2026-01-02T03:04:05.000Z";
    const cases: [number, string, string][] = [
      [0, "just now", "刚刚"],
      [5, "5m", "5 分钟前"],
      [120, "2h", "2 小时前"],
      [60 * 24, "yesterday", "昨天"],
      [60 * 24 * 3, "3d", "3 天前"],
    ];
    for (const [minutes, en, zh] of cases) {
      assert.strictEqual(relativeTimeLabel(iso, minutes, "en"), en);
      assert.strictEqual(relativeTimeLabel(iso, minutes, "zh"), zh);
    }
    // Past a week: an absolute date, resolved to the EDITOR's locale rather
    // than the host OS's — the two differ, and only one of them is invariant
    // 6's answer.
    const weeks = 60 * 24 * 30;
    assert.strictEqual(
      relativeTimeLabel(iso, weeks, "en"),
      new Date(iso).toLocaleDateString("en-US"),
    );
    assert.strictEqual(
      relativeTimeLabel(iso, weeks, "zh"),
      new Date(iso).toLocaleDateString("zh-CN"),
    );
  });
});

suite("session-labels — the forked-from tooltip line", () => {
  test("names the count in both locales", () => {
    assert.strictEqual(
      forkedFromTooltip(1, "en"),
      "1 session forked from this one — expand to see it.",
    );
    assert.strictEqual(
      forkedFromTooltip(3, "en"),
      "3 sessions forked from this one — expand to see them.",
    );
    assert.strictEqual(
      forkedFromTooltip(1, "zh"),
      "已从此会话分叉出 1 个会话——展开查看。",
    );
    assert.strictEqual(
      forkedFromTooltip(3, "zh"),
      "已从此会话分叉出 3 个会话——展开查看。",
    );
  });

  test("neither rendering carries a word of the other language", () => {
    assert.ok(!/[一-鿿]/.test(forkedFromTooltip(2, "en")));
    assert.ok(!/[a-z]/i.test(forkedFromTooltip(2, "zh")));
  });
});
