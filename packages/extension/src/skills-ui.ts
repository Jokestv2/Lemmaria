/**
 * Writing Skills in the extension (B7, ADR 0028; E1, ADRs 0045–0046): resolving
 * the four source roots, persisting the user's disabled selection, and the
 * Skills view over what actually loaded.
 *
 * The harness owns discovery, precedence, validation, the catalogue budget and
 * every diagnostic; this file owns only what needs `vscode` — where the bundled
 * set lives (`extensionUri`), which venue matched the paper, where the user's
 * home and workspace are, and where a per-user selection is persisted. The
 * `venue-ui.ts` / `venue/library.ts` split is the precedent.
 *
 * **The disabled selection lives HERE and not in the harness** (invariant 1,
 * the `engine/memory.ts` convention): the harness must never decide where a
 * user's home is or own a persisted preference, so it takes
 * `disabled: SkillSelector[]` as an option and this file supplies it from
 * `globalState`.
 */

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadAdapterFor } from "@lemmaria/adapters";
import {
  SKILL_DIAGNOSTIC_LEVEL,
  type Skill,
  type SkillDiagnostic,
  type SkillSelector,
  type SkillSource,
  contextWindowFor,
  listSkills,
  listVenues,
  matchVenueByClass,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { currentLocale, resolvedLocale } from "./i18n";
import { modelStore } from "./model";
import { paperInContext } from "./session/registry";
import { libraryOptions } from "./venue-ui";
import { VscodeWorkspace } from "./workspace";

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
  /**
   * The skills the user switched off — filtered before the merge, so absent
   * from BOTH `skills` and `diagnostics`, and deliberately not a diagnostic:
   * a skill the user turned off is not a problem to report.
   *
   * The harness hands them back rather than dropping them (second gate-review
   * round) precisely so this file can render a row per skill. Before that they
   * were a count and nothing else, so turning one off made it vanish and the
   * only route back was a palette command.
   */
  disabled: Skill[];
}

const EMPTY: LoadedSkills = { skills: [], diagnostics: [], disabled: [] };

let loaded: LoadedSkills = EMPTY;

/** The skills a task is handed. Cached; recomputed by `refreshSkills`. */
export function currentSkills(): Skill[] {
  return loaded.skills;
}

/**
 * `<venue dir>/skills`, when the paper's `\documentclass` matches a library
 * venue — so a venue's writing rules arrive with the venue. No paper, no class,
 * or no match ⇒ `undefined`, which the loader treats as an empty layer.
 */
async function venueSkillsDir(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const paper = await paperInContext();
  if (!paper) return undefined;
  try {
    const adapter = await loadAdapterFor(
      new VscodeWorkspace(paper.root, paper.entry),
      paper.entry,
    );
    const detected =
      "documentClass" in adapter ? adapter.documentClass() : undefined;
    if (!detected) return undefined;
    const { venues } = await listVenues(libraryOptions(context));
    const matched = matchVenueByClass(detected, venues);
    return matched === undefined
      ? undefined
      : vscode.Uri.joinPath(vscode.Uri.file(matched.dir), "skills").fsPath;
  } catch {
    // An unparseable paper has no venue; it must never break skill loading,
    // which the other two sources can still satisfy.
    return undefined;
  }
}

/**
 * `~/.lemmaria`, or whatever `LEMMARIA_HOME` names.
 *
 * The env override is a test seam, and the precedent is `action-run.ts`'s
 * `LEMMARIA_MEMORY_DIR` for the global `MEMORY.md`. It is separate from that
 * one deliberately: `LEMMARIA_MEMORY_DIR` names one FILE's directory and
 * re-pointing it is a different change with different consequences, so
 * collapsing the two is another milestone's call and not a silent side effect
 * of this one.
 */
function lemmariaHome(): string {
  return process.env.LEMMARIA_HOME ?? join(homedir(), ".lemmaria");
}

/** `~/.lemmaria/skills` — the user's own, and where a dropped-in pack lands. */
export function userSkillsDir(): string {
  return join(lemmariaHome(), "skills");
}

/**
 * The `globalState` key holding the user's disabled selection (E1, ADR 0045).
 * Global rather than workspace: `~/.lemmaria/skills` and the bundled set are
 * the same in every workspace, so a per-workspace toggle would make the user
 * re-disable a pack they have already dismissed once per paper.
 */
const DISABLED_KEY = "lemmaria.skills.disabled";

/**
 * What is persisted per disabled skill: the harness's `SkillSelector` plus the
 * skill's NAME.
 *
 * **The name is not redundant, and leaving it out was a real bug.** A selector
 * is a `{name}` OR a `{path}`, and the row-menu path stores `{path}` so one
 * copy of a twice-resolving name can be silenced. But a disabled skill is
 * absent from `loaded.skills` by construction — that is what disabling means —
 * so at re-enable time there is nothing left to map a name back to its path,
 * and a toggle invoked by name would fail to find the `{path}` entry it had
 * itself written and disable the skill a *second* time. Storing the name makes
 * the identity of the thing independent of how it was selected, and it is also
 * what lets the quick pick offer a disabled skill under its name instead of an
 * absolute path.
 */
interface DisabledSkill {
  name: string;
  selector: SkillSelector;
}

/** Separator-insensitive, matching the harness's own selector comparison. */
const samePath = (a: string, b: string): boolean =>
  a.replace(/\\/g, "/") === b.replace(/\\/g, "/");

/**
 * Does this stored entry refer to the same skill the user just acted on?
 *
 * **Path first, name only as a fallback, and the split matters** (found by
 * review). Matching purely by name breaks the two-copy case: with `tone` in
 * both `bundled` and `project`, disabling the project copy stores a `{path}`
 * entry, the bundled copy then wins the merge and appears as an enabled row
 * called `tone`, and disabling *that* would remove the project entry instead of
 * adding a second one — the toggle acting as its own inverse on a different
 * skill. Matching purely by path breaks the opposite case: a disabled skill is
 * absent from the loaded set, so a re-enable invoked by name has no path to
 * offer and would write a second entry rather than removing the first.
 */
function refersToSame(entry: DisabledSkill, target: DisabledSkill): boolean {
  if ("path" in entry.selector && "path" in target.selector) {
    return samePath(entry.selector.path, target.selector.path);
  }
  return entry.name === target.name;
}

/**
 * The AUTHORITATIVE copy of the selection; `globalState` is its persisted
 * mirror.
 *
 * Reads used to go straight to the Memento, and that is the hazard
 * `model-store.ts` already documents from U4 gate debugging: `globalState` was
 * observed to intermittently hand back a stale value just after an `update`
 * resolved. The toggle writes and then immediately re-reads — to recompute the
 * loaded set, to redraw the view — so a stale read makes a toggle silently
 * undo itself, and the failure is intermittent and ordering-dependent, which is
 * the worst kind to chase. Write through, read from memory.
 */
let disabledCache: DisabledSkill[] | undefined;

function disabledSkills(context: vscode.ExtensionContext): DisabledSkill[] {
  disabledCache ??= context.globalState.get<DisabledSkill[]>(DISABLED_KEY, []);
  return disabledCache;
}

/** The one writer. Memory first, so the next read cannot lose the change. */
async function setDisabledSkills(
  context: vscode.ExtensionContext,
  next: DisabledSkill[],
): Promise<void> {
  disabledCache = next;
  await context.globalState.update(DISABLED_KEY, next);
}

function disabledSelection(context: vscode.ExtensionContext): SkillSelector[] {
  return disabledSkills(context).map((d) => d.selector);
}

/**
 * The bound model's context window, which the catalogue budget is 2 % of
 * (ADR 0048) — and **`undefined` when nothing is bound**, which is not a
 * degenerate case but the state a fresh window is in until the user picks a
 * model. Codex's rule takes that branch to a character budget rather than
 * inventing a window, and passing `contextWindowFor("")`'s 128,000-token
 * default here would quietly turn "we do not know" into "we are sure it is
 * 128k" — the failure ADR 0048 §3 names.
 */
function contextWindowTokens(): number | undefined {
  const model = modelStore()?.active()?.model;
  return model === undefined || model === ""
    ? undefined
    : contextWindowFor(model);
}

/**
 * Load all four sources. The locale is `resolvedLocale()` — the ADR 0031
 * `lemmaria.language` setting — NOT `currentLocale()`: a skill body is
 * model-facing text, so it follows the model-output language, while the view's
 * own chrome below follows the display language.
 */
export async function loadWorkspaceSkills(
  context: vscode.ExtensionContext,
): Promise<LoadedSkills> {
  const bundledDir = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "skills",
  ).fsPath;
  const folder = vscode.workspace.workspaceFolders?.[0];
  const projectDir = folder
    ? vscode.Uri.joinPath(folder.uri, ".lemmaria", "skills").fsPath
    : undefined;
  const venueDir = await venueSkillsDir(context);
  const disabled = disabledSelection(context);
  return listSkills({
    bundledDir,
    userDir: userSkillsDir(),
    locale: resolvedLocale(),
    ...(contextWindowTokens() !== undefined
      ? { contextWindowTokens: contextWindowTokens() }
      : {}),
    ...(venueDir !== undefined ? { venueDir } : {}),
    ...(projectDir !== undefined ? { projectDir } : {}),
    ...(disabled.length > 0 ? { disabled } : {}),
  });
}

/**
 * Generation guard: `loadWorkspaceSkills` awaits a venue match and three
 * directory reads, so a slow refresh (the watcher firing) can resolve AFTER a
 * fast one (an editor change) and overwrite it with the older world. Only the
 * newest refresh may write. The same guard `glossary-ui.ts` carries, for the
 * same reason.
 */
let refreshSeq = 0;

/** Reload and refresh the view. Safe to call often; it is three small reads. */
export async function refreshSkills(
  context: vscode.ExtensionContext,
): Promise<LoadedSkills> {
  const seq = ++refreshSeq;
  const next = await loadWorkspaceSkills(context);
  if (seq !== refreshSeq) return loaded; // superseded mid-read
  loaded = next;
  refreshView();
  // An open read-only preview must not go stale when its file changes on disk.
  // Firing for every loaded skill rather than tracking which previews are open
  // is deliberate: VS Code ignores a change for a document nobody has open, so
  // the bookkeeping would buy nothing but a set to keep correct.
  for (const skill of [...loaded.skills, ...loaded.disabled]) {
    previewChanged.fire(previewUri(skill.name, skill.path));
  }
  // E2 (ADR 0049): the composer's `/` menu is PUSHED, not polled. E1 shipped a
  // runtime toggle, so the enabled set moves while the panel is open, and a
  // menu that read a stale catalogue would offer a slug the harness now
  // ignores.
  skillsChanged?.(loaded.skills);
  return loaded;
}

// ── The read-only preview ───────────────────────────────────────────────────

/**
 * The scheme a skill's own `SKILL.md` opens under (gate-review round,
 * 2026-08-24). `lemmaria-proposal` and the session-edit diff scheme are the
 * precedent.
 *
 * **A content provider rather than the real file, because read-only is the
 * point.** A `SKILL.md` is not the user's working document — it is the text
 * the model is handed, and most of them belong to a pack the user installed
 * rather than wrote. Opening the real path puts a writable buffer over someone
 * else's file one keystroke away from a silent edit; a
 * `TextDocumentContentProvider` document cannot be edited at all, so the
 * guarantee is structural rather than a habit.
 *
 * The URI carries the real path in its **query** and names its **path** for the
 * skill, so twenty open previews are twenty distinct tab titles instead of
 * twenty tabs all reading `SKILL.md` — and the `.md` suffix is what gets the
 * buffer markdown highlighting.
 */
const SKILL_SCHEME = "lemmaria-skill";

const previewChanged = new vscode.EventEmitter<vscode.Uri>();

function previewUri(name: string, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SKILL_SCHEME,
    path: `/${name}.md`,
    query: path,
  });
}

/**
 * Only files the view is currently showing. The provider is reachable by
 * hand-typed URI, and while a user opening their own file is harmless, a
 * surface that will read any path on request is not one to leave lying around
 * — the same instinct invariant 2 encodes for the model's side.
 */
function previewablePaths(): Set<string> {
  return new Set([
    ...loaded.skills.map((s) => s.path),
    ...loaded.disabled.map((s) => s.path),
    ...loaded.diagnostics.map((d) => d.path),
  ]);
}

// ── The view ────────────────────────────────────────────────────────────────

/**
 * **One row per skill, and nothing else** (gate-review round, 2026-08-24).
 *
 * Diagnostics used to be rows of their own — an info note beneath its skill, a
 * failure at the top of the list. Driving `tests/e1/1-pack-at-density` showed
 * what that costs at real density: a 19-skill pack rendered ~50 flat rows, one
 * skill appearing as three of them, and no way to scan the list for a name.
 * ADR 0045 §3 requires a truncation or a drop to be VISIBLE, not to occupy a
 * row — so an info note now rides in its skill's hover, and a skill that did
 * not load keeps a row of its own wearing a `warning` icon.
 *
 * Rows are objects, never indices: the ext host truthiness-filters
 * `getChildren` results, so an index element `0` is dropped and the FIRST row
 * would never render (the U5 round-1 bug that silently hid every view's first
 * row).
 */
type SkillRow =
  | { kind: "skill"; skill: Skill }
  | { kind: "unavailable"; diagnostic: SkillDiagnostic }
  | { kind: "disabled"; skill: Skill };

/** A skill's own info notes, folded into its hover rather than listed. */
function notesFor(skill: Skill): SkillDiagnostic[] {
  return loaded.diagnostics.filter((d) => isInfo(d) && d.path === skill.path);
}

/**
 * What to call a skill that never loaded.
 *
 * Its DIRECTORY name, because that is the only name a failed skill reliably
 * has: `parse_failed` and `missing_description` fire precisely when the
 * frontmatter could not be trusted, so reading a `name:` out of it is not an
 * option. The full reason — which does quote the frontmatter name when there
 * was one — is in the hover.
 */
function skillNameFor(d: SkillDiagnostic): string {
  const base = basename(d.path);
  return base.toLowerCase().endsWith(".md") ? basename(dirname(d.path)) : base;
}

/**
 * The one word of grey text a row carries (gate-review round).
 *
 * `user` reads **global** rather than "yours" and `project` reads **this
 * project** rather than "this paper": the view is now "Skills" rather than
 * "Writing Skills", because the set is not going to stay writing-only, and
 * `~/.lemmaria/skills` is global in the literal sense — it is the same set in
 * every workspace, which is exactly why the disabled selection is `globalState`.
 */
const SOURCE_LABEL: Record<SkillSource, { en: string; zh: string }> = {
  project: { en: "this project", zh: "本项目" },
  user: { en: "global", zh: "全局" },
  venue: { en: "venue", zh: "会议模板" },
  bundled: { en: "built in", zh: "内置" },
};

/**
 * Which diagnostics are INFO rather than failures (E1, ADRs 0045–0046).
 *
 * The distinction is load-bearing in the view: a failure row means *this skill
 * is not there*, and an info row means *it loaded, with something you should
 * know*. Rendering the second as the first would tell a user their pack is
 * broken when 19 of 19 skills are working — which is worse than saying nothing,
 * because it trains them to ignore the row that does matter.
 *
 * **The answer comes from the harness and is not decided here.** This used to
 * be a local set of codes, and it silently went stale the moment a third Info
 * code was added to the union — see `SKILL_DIAGNOSTIC_LEVEL`, which is now the
 * one home for the question and makes the omission a compile error.
 */
const isInfo = (d: SkillDiagnostic): boolean =>
  SKILL_DIAGNOSTIC_LEVEL[d.code] === "info";

function rows(): SkillRow[] {
  // FAILURES first: a skill the user installed and cannot see is the one thing
  // this surface exists to prevent, and it is one row, not a banner sentence
  // plus a row. An INFO note produces no row at all — it belongs to a skill
  // that DID load, so it rides in that skill's hover.
  const unavailable = loaded.diagnostics
    .filter((d) => !isInfo(d))
    .map((diagnostic): SkillRow => ({ kind: "unavailable", diagnostic }));
  // DISABLED last, and it is the one group whose position is an argument: a
  // skill you switched off is the only one you are not looking for while
  // reading the list, and putting them in place would put 19 struck-through
  // rows through the middle of a list the last round existed to shorten.
  return [
    ...unavailable,
    ...loaded.skills.map((skill): SkillRow => ({ kind: "skill", skill })),
    ...loaded.disabled.map((skill): SkillRow => ({ kind: "disabled", skill })),
  ];
}

/**
 * DERIVED from the loaded definitions, never a hardcoded sentence — the U6
 * Glossary rule. **Counts, and nothing else** (gate-review round, 2026-08-24,
 * operator direction): the banner sits above every row in a narrow panel, so
 * prose there is charged to the reader on every glance forever.
 *
 * Three sentences went, and each has a home that costs nothing:
 * *"it reads a body only when it calls load_skill"* is documentation, not
 * state; *"N could not be loaded (below)"* is now the failed skill's own row;
 * and *"add one of your own at …"* is what the docs and the empty-set message
 * on `lemmaria.useSkill` say.
 *
 * **The disabled count stays**, because it is the one number no row can carry:
 * a disabled skill is filtered before the merge and has no row by
 * construction, so without it the toggle looks like a delete.
 */
function bannerFor(zh: boolean): string | undefined {
  const skills = loaded.skills;
  if (skills.length === 0 && loaded.diagnostics.length === 0) return undefined;
  const n = (source: SkillSource) =>
    skills.filter((s) => s.source === source).length;
  const stats = zh
    ? `${skills.length} 项技能：${n("project")} 项来自本项目、${n("user")} 项全局、${n("venue")} 项来自会议模板、${n("bundled")} 项内置。`
    : `${skills.length} skills: ${n("project")} from this project, ${n("user")} global, ${n("venue")} from venue, ${n("bundled")} built in.`;
  // Counted from the ROWS, not from the persisted selection: an entry whose
  // skill has since been deleted from disk produces no row, and a banner that
  // counted it would send the reader looking for something that is not there.
  const off = loaded.disabled.length;
  if (off === 0) return stats;
  return zh ? `${stats} 已停用 ${off} 项。` : `${stats} ${off} disabled.`;
}

class SkillsTree implements vscode.TreeDataProvider<SkillRow> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(element?: SkillRow): SkillRow[] {
    if (element !== undefined) return [];
    return rows();
  }

  getTreeItem(row: SkillRow): vscode.TreeItem {
    const zh = currentLocale() === "zh";
    if (row.kind === "unavailable") {
      const { diagnostic } = row;
      // Still a skill row — the name, the source, the warning icon — because
      // the user installed this thing and needs to find it by the name they
      // know it under. The reason it did not load is a sentence, so it goes
      // where sentences go: the hover.
      const item = new vscode.TreeItem(skillNameFor(diagnostic));
      item.iconPath = new vscode.ThemeIcon("warning");
      item.description = SOURCE_LABEL[diagnostic.source][zh ? "zh" : "en"];
      item.contextValue = "lemmariaSkillUnavailable";
      item.tooltip = new vscode.MarkdownString(
        `**${skillNameFor(diagnostic)}** — ${zh ? "未加载" : "not loaded"}\n\n${diagnostic.message}\n\n\`${diagnostic.path}\``,
      );
      // Clicking a broken skill opens the file that broke — the one action a
      // user wants next, and the reason `lemmaria.useSkill` would be wrong
      // here: there is nothing to invoke.
      item.command = {
        command: "lemmaria.skills.open",
        title: zh ? "打开技能文件" : "Open skill file",
        arguments: [row],
      };
      return item;
    }
    if (row.kind === "disabled") {
      // Still a row, and that is the whole point: a switch you can turn off
      // and then not find again is not a switch. Greyed rather than hidden —
      // the `circle-slash` is the toggle's own icon, so the row says what
      // turned it off and what will turn it back on.
      const item = new vscode.TreeItem(row.skill.name);
      item.iconPath = new vscode.ThemeIcon(
        "circle-slash",
        new vscode.ThemeColor("disabledForeground"),
      );
      // The STATE, not the source: these rows sit in their own group at the
      // bottom, so what a reader needs from the grey column is which of them
      // is off rather than where it came from. The source is in the hover with
      // the path, which is also what tells two copies of one name apart.
      item.description = zh ? "已停用" : "disabled";
      item.contextValue = "lemmariaSkillDisabled";
      const offSource = SOURCE_LABEL[row.skill.source][zh ? "zh" : "en"];
      item.tooltip = new vscode.MarkdownString(
        `**${row.skill.name}** — ${offSource} · ${zh ? "已停用" : "disabled"}\n\n${row.skill.description}\n\n\`${row.skill.path}\``,
      );
      item.command = {
        command: "lemmaria.skills.toggle",
        title: zh ? "重新启用此技能" : "Enable this skill again",
        arguments: [row],
      };
      return item;
    }
    const { skill } = row;
    const item = new vscode.TreeItem(skill.name);
    const source = SOURCE_LABEL[skill.source][zh ? "zh" : "en"];
    // The SOURCE alone. The description used to ride here too and ran the full
    // width of the panel on every row (gate-review round); it is in the hover,
    // where it can be read whole instead of clipped.
    item.description = source;
    item.iconPath = new vscode.ThemeIcon("book");
    // `contextValue` is what puts the toggle and the open action on the row's
    // inline menu, and the row carries the PATH so a name that resolves from
    // two sources can be disabled one copy at a time.
    item.contextValue = "lemmariaSkill";
    const refs =
      skill.references.length > 0
        ? zh
          ? `\n\n附加参考：${skill.references.join("、")}`
          : `\n\nReferences: ${skill.references.join(", ")}`
        : "";
    // The info notes, folded in. This is what keeps ADR 0045 §3 honest now
    // that a note has no row: a truncation still names itself where the user
    // is already looking to read the description it truncated.
    const notes = notesFor(skill);
    const noteBlock =
      notes.length === 0
        ? ""
        : `\n\n${zh ? "说明" : "Notes"}\n${notes.map((d) => `- ${d.message}`).join("\n")}`;
    item.tooltip = new vscode.MarkdownString(
      `**${skill.name}** — ${source}\n\n${skill.description}${refs}${noteBlock}\n\n\`${skill.path}\``,
    );
    // Explicit invocation (ADR 0028 §D6): the row prefills the composer with
    // the `/skill:` prefix rather than sending — the user sees what will go.
    item.command = {
      command: "lemmaria.useSkill",
      title: zh ? "使用此技能" : "Use this skill",
      arguments: [skill.name],
    };
    return item;
  }
}

let view: vscode.TreeView<SkillRow> | undefined;
let provider: SkillsTree | undefined;

function refreshView(): void {
  provider?.refresh();
  if (!view) return;
  const zh = currentLocale() === "zh";
  const banner = bannerFor(zh);
  // `view.message` must be undefined when there is nothing, or it suppresses
  // `viewsWelcome` (the hazard recorded in sessions-view.ts).
  view.message = banner;
  view.badge =
    loaded.skills.length > 0
      ? {
          value: loaded.skills.length,
          tooltip: zh
            ? `${loaded.skills.length} 项技能`
            : `${loaded.skills.length} skills`,
        }
      : undefined;
}

/** Test seam: force a reload (the glossary precedent). */
export async function refreshSkillsForTests(
  context: vscode.ExtensionContext,
): Promise<void> {
  await refreshSkills(context);
}

/** Test seam: the user's disabled selection, as persisted. */
export function disabledSkillsForTests(
  context: vscode.ExtensionContext,
): DisabledSkill[] {
  return disabledSkills(context);
}

/** Test seam: what the LIVE provider hands out and renders. */
export function skillsTreeForTests(): {
  children: SkillRow[];
  items: vscode.TreeItem[];
  message: string | undefined;
  badge: number | undefined;
} {
  const p = provider ?? new SkillsTree();
  const children = p.getChildren();
  return {
    children,
    items: children.map((row) => p.getTreeItem(row)),
    message: view?.message,
    badge: view?.badge?.value,
  };
}

export function registerSkills(context: vscode.ExtensionContext): void {
  provider = new SkillsTree();
  view = vscode.window.createTreeView("lemmariaSkills", {
    treeDataProvider: provider,
  });
  context.subscriptions.push(view);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "lemmaria.useSkill",
      async (preselected?: string) => {
        const zh = currentLocale() === "zh";
        if (loaded.skills.length === 0) {
          void vscode.window.showInformationMessage(
            zh
              ? "Lemmaria：还没有写作技能。在 .lemmaria/skills/<名称>/SKILL.md 中创建一个。"
              : "Lemmaria: no writing skills yet. Create one at .lemmaria/skills/<name>/SKILL.md.",
          );
          return;
        }
        let name = preselected;
        if (name === undefined) {
          const picked = await vscode.window.showQuickPick(
            loaded.skills.map((s) => ({
              label: s.name,
              description: SOURCE_LABEL[s.source][zh ? "zh" : "en"],
              detail: s.description,
            })),
            {
              placeHolder: zh
                ? "选择要应用的写作技能"
                : "Pick a writing skill to apply",
            },
          );
          if (!picked) return;
          name = picked.label;
        }
        await vscode.commands.executeCommand("lemmariaAssistant.focus");
        prefillComposer?.(`/skill:${name} `);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "lemmaria.skills.toggle",
      async (target?: SkillRow | string) => {
        const zh = currentLocale() === "zh";
        const disabled = disabledSkills(context);

        // Invoked from a row's context menu with the row itself, from the
        // palette with nothing, or programmatically with a name.
        let chosen: DisabledSkill | undefined;
        if (typeof target === "string") {
          // **A NAME addresses the name as a whole**, and that is a decision
          // rather than a shortcut (second review round). A name can resolve
          // from two sources, and the two UI routes disambiguate for
          // themselves — the row carries its own path, and the quick pick
          // returns the exact stored entry. A bare name carries no such
          // information, so the only predictable reading is the one a user
          // would give it: *if any copy of this is off, turn it back on;
          // otherwise turn off the one currently in effect.* Addressing "the
          // loaded copy" instead would ping-pong — re-enabling one copy makes
          // it the merge winner, so the next call would disable it again and
          // the pair would never both come back on.
          const off = disabled.filter((d) => d.name === target);
          if (off.length > 0) {
            const next = disabled.filter((d) => d.name !== target);
            await setDisabledSkills(context, next);
            await refreshSkills(context);
            return;
          }
          const on = loaded.skills.find((s) => s.name === target);
          chosen = on
            ? { name: on.name, selector: { path: on.path } }
            : { name: target, selector: { name: target } };
        } else if (target?.kind === "skill" || target?.kind === "disabled") {
          // Both directions from a row, and the SAME shape for each: the
          // disabled row carries the path its stored entry was written with, so
          // `refersToSame` finds that entry and removes it rather than adding a
          // second one.
          chosen = {
            name: target.skill.name,
            selector: { path: target.skill.path },
          };
        }

        if (chosen === undefined) {
          const enabled = loaded.skills.map((s) => ({
            label: s.name,
            description: SOURCE_LABEL[s.source][zh ? "zh" : "en"],
            detail: zh ? "停用此技能" : "Disable this skill",
            entry: {
              name: s.name,
              selector: { path: s.path },
            } as DisabledSkill,
          }));
          // The disabled ones have to be listed too, or a user who turns one
          // off has no way back: they are absent from `loaded.skills` by
          // construction, so nothing else in the view can offer them.
          const off = disabled.map((d) => ({
            label: d.name,
            description: zh ? "已停用" : "disabled",
            // The PATH, when there is one: two copies of the same name can
            // both be disabled, and two rows reading only "tone / disabled"
            // give the user no way to tell which is which (second review
            // round).
            detail:
              "path" in d.selector
                ? d.selector.path
                : zh
                  ? "重新启用此技能"
                  : "Enable this skill again",
            entry: d,
          }));
          const picked = await vscode.window.showQuickPick(
            [...enabled, ...off],
            {
              placeHolder: zh
                ? "选择要启用或停用的写作技能"
                : "Pick a writing skill to enable or disable",
            },
          );
          if (!picked) return;
          chosen = picked.entry;
        }

        // A toggle undoes itself however it was reached — from the row, from
        // the palette, or by name — and never removes an entry for a DIFFERENT
        // copy of the same name. See `refersToSame`.
        const next = disabled.filter((d) => !refersToSame(d, chosen));
        if (next.length === disabled.length) next.push(chosen);
        await setDisabledSkills(context, next);
        await refreshSkills(context);
      },
    ),
  );

  context.subscriptions.push(
    previewChanged,
    vscode.workspace.registerTextDocumentContentProvider(SKILL_SCHEME, {
      onDidChange: previewChanged.event,
      provideTextDocumentContent: async (uri) => {
        const path = uri.query;
        if (!previewablePaths().has(path)) return "";
        try {
          const bytes = await vscode.workspace.fs.readFile(
            vscode.Uri.file(path),
          );
          return new TextDecoder().decode(bytes);
        } catch {
          // A skill deleted between the click and the read. An empty buffer is
          // the honest answer; throwing would surface a modal for a file the
          // user is merely browsing.
          return "";
        }
      },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "lemmaria.skills.open",
      async (target?: SkillRow | string) => {
        const zh = currentLocale() === "zh";
        let chosen: { name: string; path: string } | undefined;
        if (typeof target === "string") {
          const found = loaded.skills.find((s) => s.name === target);
          if (found) chosen = { name: found.name, path: found.path };
        } else if (target?.kind === "skill" || target?.kind === "disabled") {
          chosen = { name: target.skill.name, path: target.skill.path };
        } else if (target?.kind === "unavailable") {
          chosen = {
            name: skillNameFor(target.diagnostic),
            path: target.diagnostic.path,
          };
        }

        if (chosen === undefined) {
          // The palette route. The skills that did NOT load are offered too:
          // a file that failed to parse is the one a user most wants to read.
          const choices = [
            ...loaded.skills.map((s) => ({
              label: s.name,
              description: SOURCE_LABEL[s.source][zh ? "zh" : "en"],
              detail: s.path,
              file: { name: s.name, path: s.path },
            })),
            ...loaded.diagnostics
              .filter((d) => !isInfo(d))
              .map((d) => ({
                label: skillNameFor(d),
                description: zh ? "未加载" : "not loaded",
                detail: d.path,
                file: { name: skillNameFor(d), path: d.path },
              })),
          ];
          if (choices.length === 0) {
            void vscode.window.showInformationMessage(
              zh
                ? "Lemmaria：还没有技能。在 .lemmaria/skills/<名称>/SKILL.md 中创建一个。"
                : "Lemmaria: no skills yet. Create one at .lemmaria/skills/<name>/SKILL.md.",
            );
            return;
          }
          const picked = await vscode.window.showQuickPick(choices, {
            placeHolder: zh
              ? "选择要查看的技能文件"
              : "Pick a skill file to open",
          });
          if (!picked) return;
          chosen = picked.file;
        }

        const doc = await vscode.workspace.openTextDocument(
          previewUri(chosen.name, chosen.path),
        );
        await vscode.window.showTextDocument(doc, { preview: true });
      },
    ),
  );

  // A skill the user adds must show up without a reload — a feature that looks
  // dead on first use is one nobody tries twice.
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, ".lemmaria/skills/**"),
    );
    const reload = () => void refreshSkills(context);
    watcher.onDidCreate(reload);
    watcher.onDidChange(reload);
    watcher.onDidDelete(reload);
    context.subscriptions.push(watcher);
  }
  context.subscriptions.push(
    // The venue follows the paper, so focusing a DIFFERENT paper can change
    // what loads. Narrowed to paper files: a reload costs a venue match
    // (`loadAdapterFor` + `listVenues`) plus three directory reads, and
    // focusing a diff, a settings tab or the webview can never change the
    // answer. `paperInContext` is sticky for exactly the same reason.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const uri = editor?.document.uri;
      if (!uri || uri.scheme !== "file" || !/\.(tex|md)$/i.test(uri.fsPath)) {
        return;
      }
      void refreshSkills(context);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("lemmaria.language")) {
        void refreshSkills(context);
      }
    }),
  );

  // The catalogue budget is 2 % of the BOUND MODEL's window (ADR 0048), so
  // binding a different model changes how much of each description fits and
  // which skills the budget can afford at all. Without this the view — and the
  // prompt it feeds — would keep the fit computed for whatever was bound when
  // the skills were last read, which on a fresh window is nothing. Safe here
  // because `registerModels` runs before `registerSkills` at activation.
  const models = modelStore();
  if (models !== undefined) {
    context.subscriptions.push(
      models.onDidChange(() => void refreshSkills(context)),
    );
  }

  void refreshSkills(context);
}

/**
 * How the command reaches the composer. Set by the webview provider at
 * registration, so this module never imports it (the U5 cycle lesson).
 */
let prefillComposer: ((text: string) => void) | undefined;

export function setComposerPrefill(fn: (text: string) => void): void {
  prefillComposer = fn;
}

/**
 * How a change to the loaded set reaches the composer's `/` menu (E2).
 *
 * A second injected sink beside {@link setComposerPrefill} rather than an
 * `EventEmitter`, on the same reasoning and for the same cycle: `webview-view`
 * already imports this module, and an emitter here would be a second lifetime
 * to own for one call site.
 */
let skillsChanged: ((skills: readonly Skill[]) => void) | undefined;

export function setSkillsChanged(fn: (skills: readonly Skill[]) => void): void {
  skillsChanged = fn;
}
