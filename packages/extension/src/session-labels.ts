/**
 * The chrome's TEMPLATED strings (E6, ADR 0058 §2 and §7) — the Sessions view's
 * row labels first, and from D13 the rewind path's outcome lines too.
 *
 * `chrome-strings.ts` is the home for every STATIC chrome string, and its test
 * suite pins that property: no value there holds a placeholder. A string that
 * carries a number or a session's own title therefore cannot live in the
 * table, and the alternative it used to have — an inline `isZh() ? … : …` at
 * the call site — is exactly the shape the E5 coverage-debt entry filed
 * against, because a ternary's two arms are reachable only by relaunching VS
 * Code under a different display language.
 *
 * So: small exported formatters, one per rendered string, each asserted in
 * BOTH locales in `test/session-labels.test.ts`. Invariant 6 rule 2 holds by
 * construction — every function returns one language, chosen by the caller's
 * `SessionLocale`, and never a concatenation of two.
 */
import type { SessionLocale, SessionMeta } from "@lemmaria/harness";

/**
 * `1 → "1st"`, `2 → "2nd"`, `11 → "11th"`, `21 → "21st"`.
 *
 * The teens are the special case every `n % 10` implementation gets wrong, and
 * they are reachable here: a writer who rewinds to the eleventh message of a
 * long session gets this row.
 */
function englishOrdinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * What a rewind fork's row says about where it was cut — the operator's own
 * *"(forked from x-th message) "* form, rendered per reader from the stored
 * ordinal (ADR 0058 §2's *store the number, render the text*).
 *
 * The English form keeps its trailing space, because a title follows it; the
 * Chinese form needs no separator after its full-width closing paren. Callers
 * that render a bare prefix trim it — see `sessionRowLabel`.
 */
export function forkOrdinalPrefix(n: number, locale: SessionLocale): string {
  return locale === "zh"
    ? `（从第 ${n} 条消息分叉）`
    : `(forked from ${englishOrdinal(n)} message) `;
}

/**
 * A session row's label: its ordinal prefix, when it has one, then its title.
 *
 * An untitled fork renders as the prefix ALONE — the operator's *"leave XXX
 * empty"* — trimmed, so it does not sit a space wider than every row beside
 * it. A session that was created, or forked at the end (`/fork`, which cuts
 * before nothing and records no ordinal), is its title alone.
 *
 * An untitled session with no lineage renders as the empty string rather than
 * a synthesized placeholder: `sessionTitle("")` is `""` in the store, there is
 * no "untitled" sentinel anywhere in the format, and inventing one here would
 * make the view claim a name the log does not carry.
 */
export function sessionRowLabel(
  meta: Pick<SessionMeta, "title" | "forkedFrom">,
  locale: SessionLocale,
): string {
  const at = meta.forkedFrom?.atMessage;
  if (at === undefined) return meta.title;
  return `${forkOrdinalPrefix(at, locale)}${meta.title}`.trimEnd();
}

/**
 * The tooltip line a PARENT row carries, naming how many sessions were forked
 * from it (ADR 0057 §6 put it there; this moves it into a tested home).
 */
export function forkedFromTooltip(n: number, locale: SessionLocale): string {
  if (locale === "zh") return `已从此会话分叉出 ${n} 个会话——展开查看。`;
  return n === 1
    ? "1 session forked from this one — expand to see it."
    : `${n} sessions forked from this one — expand to see them.`;
}

/**
 * An outcome line with what did NOT go to plan appended, or the line alone.
 *
 * ADR 0057's honest-degradation rule, given one home (D13): a rewind that
 * mostly worked reports what it could not do rather than a clean success over
 * it. Empty caveats render nothing at all — a trailing empty parenthesis would
 * read as a defect.
 */
export function withCaveats(
  line: string,
  caveats: readonly string[],
  locale: SessionLocale,
): string {
  if (caveats.length === 0) return line;
  const joined = caveats.join(locale === "zh" ? "；" : "; ");
  return locale === "zh" ? `${line}（${joined}）` : `${line} (${joined})`;
}

/**
 * A restore that could not be carried out at all, and what that cost.
 *
 * Two forms, because the *both* arm has a second half to report and the
 * restore-only arm does not: E5's sentence ends "so the conversation did NOT
 * fork", which is true of `both` and false of `restore` — the exact case D13
 * means when it says existing copy moves verbatim only where the sentence
 * stays true.
 */
export function restoreFailedLine(
  caveats: readonly string[],
  arm: "restore" | "both",
  locale: SessionLocale,
): string {
  const why = caveats.join(locale === "zh" ? "；" : "; ");
  if (locale === "zh")
    return arm === "both"
      ? `Lemmaria：无法恢复文件，因此未从该消息处分叉——${why}。`
      : `Lemmaria：无法恢复文件——${why}。`;
  return arm === "both"
    ? `Lemmaria: could not restore the files, so the conversation did NOT fork — ${why}.`
    : `Lemmaria: could not restore the files — ${why}.`;
}

/**
 * The four things `guardedRestore` may have to report, each carrying a number
 * or a system message and therefore none of them a `chrome-strings` value.
 *
 * Moved here VERBATIM from `snapshot-host.ts` (D13): they were the last
 * localization ternaries in that file, and a working translation is not
 * re-written on the way into a tested home.
 */
export function caveatNoWorkspace(n: number, locale: SessionLocale): string {
  return locale === "zh"
    ? `未打开工作区文件夹，${n} 个文件未能恢复`
    : `no workspace folder is open, so ${n} file(s) could not be restored`;
}

export function caveatRestoreThrew(
  message: string,
  locale: SessionLocale,
): string {
  return locale === "zh"
    ? `文件恢复失败（${message}）——部分文件可能已被改动，请检查工作区`
    : `restoring the files failed (${message}) — some may already have changed, so check your workspace`;
}

export function caveatDrifted(n: number, locale: SessionLocale): string {
  return locale === "zh"
    ? `${n} 个文件在 Lemmaria 之外被改动过，其内容已先行保存`
    : `${n} file(s) had been changed outside Lemmaria; those contents were saved first`;
}

export function caveatMissingSnapshots(
  n: number,
  locale: SessionLocale,
): string {
  return locale === "zh"
    ? `${n} 个文件的快照已不存在，未做改动`
    : `${n} file(s) had no stored snapshot and were left alone`;
}

/** The title of the read-only diff opened for one file of a proposal. */
export function proposedEditTitle(file: string, locale: SessionLocale): string {
  return locale === "zh" ? `${file} — 拟议编辑` : `${file} — proposed edit`;
}

/**
 * How long ago a session was last used, in words — or, past a week, the
 * absolute date, because "43d" is not something a reader converts.
 *
 * Two complete renderings rather than five interleaved ternaries (D13). The
 * arithmetic stays in `sessions-view.ts`, which owns the clock; what moves
 * here is the only part of it that is a *string*, and the two arms are now
 * reachable from a test without relaunching VS Code.
 */
export function relativeTimeLabel(
  iso: string,
  minutes: number,
  locale: SessionLocale,
): string {
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (locale === "zh") {
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    if (days === 1) return "昨天";
    if (days < 7) return `${days} 天前`;
    // Resolved to the EDITOR's locale, like every other string here, and never
    // to the host OS's (invariant 6).
    return new Date(iso).toLocaleDateString("zh-CN");
  }
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString("en-US");
}

/**
 * A session row's right-hand description — the active dot, how long ago, and
 * the out-of-sync marker (ADR 0058 §7).
 *
 * `marker` is passed in rather than reached for, so this stays free of the
 * view's constants and one test can drive both the marked and unmarked forms.
 * It **ends** the string, so it sits at the row's right edge whatever else the
 * row says — including on the ACTIVE row, which is checked like any other.
 */
export function sessionRowDescription(
  row: {
    active: boolean;
    relative: string;
    outOfSync?: boolean;
  },
  marker: string,
  locale: SessionLocale,
): string {
  const age = row.relative;
  const head = row.active
    ? `● ${locale === "zh" ? "当前" : "active"}${age ? ` · ${age}` : ""}`
    : age;
  return `${head}${row.outOfSync ? marker : ""}`;
}

/**
 * A session row's hover text: what it is, when it was last used, what has been
 * forked from it, whether its files still match, and what a click does.
 *
 * Assembled here rather than at the call site because the whole sentence is
 * templated — the label and the timestamp are data — so an inline ternary was
 * the one shape D13's sweep exists to remove.
 */
export function sessionRowTooltip(
  parts: {
    label: string;
    when: string;
    /** Already localized, already prefixed with a newline, or empty. */
    forks: string;
    /** Likewise — the out-of-sync sentence, or empty. */
    stale: string;
  },
  locale: SessionLocale,
): string {
  const { label, when, forks, stale } = parts;
  return locale === "zh"
    ? `${label}\n最后活动：${when}${forks}${stale}\n点击以恢复该会话。`
    : `${label}\nLast activity: ${when}${forks}${stale}\nClick to resume this session.`;
}
