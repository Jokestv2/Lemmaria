/**
 * CM1 layered memory (M8): merge the user-global `~/.lemmaria/MEMORY.md`, the
 * project `PAPER.md`, and the nearest directory-level `PAPER.md` into one
 * PaperMd. All three layers share the PAPER.md format (architecture "PAPER.md
 * Format"); injection order is global → project → directory with the
 * NEAREST scope winning on conflict. Hosts load the layer FILES and pass
 * strings — the harness never reads the home directory itself.
 *
 * Merge semantics (recorded in progress.md at the M8 gate): each profile text
 * field takes the nearest non-empty value; glossary entries merge per
 * `term.toLowerCase()` and symbols per `symbol`, the nearest layer winning per
 * key while farther-scope entries survive.
 */

import type { SessionLocale } from "../contracts/sessions.js";
import type { OutlineNode } from "../contracts/tools.js";
import { type PaperMd, parsePaperMd } from "./paper.js";

/** Raw file contents per layer; an absent property means the layer is missing. */
export interface MemoryInput {
  global?: string;
  project?: string;
  directory?: string;
}

export function resolveMemory(input: MemoryInput): PaperMd {
  // Farthest scope first; later (nearer) layers overwrite.
  const layers = [input.global, input.project, input.directory].map((raw) =>
    parsePaperMd(raw ?? ""),
  );

  const merged: PaperMd = {
    profile: {
      contribution: "",
      audience: "",
      claims: "",
      outline: "",
      style: "",
      venue: "",
    },
    glossary: [],
    symbols: [],
  };
  const glossary = new Map<string, PaperMd["glossary"][number]>();
  const symbols = new Map<string, PaperMd["symbols"][number]>();

  for (const layer of layers) {
    for (const key of [
      "contribution",
      "audience",
      "claims",
      "outline",
      "style",
      "venue",
    ] as const) {
      if (layer.profile[key] !== "") merged.profile[key] = layer.profile[key];
    }
    for (const entry of layer.glossary) {
      glossary.set(entry.term.toLowerCase(), entry);
    }
    for (const entry of layer.symbols) {
      symbols.set(entry.symbol, entry);
    }
  }
  merged.glossary = [...glossary.values()];
  merged.symbols = [...symbols.values()];
  return merged;
}

function outlineBullets(nodes: OutlineNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [
    `${"  ".repeat(depth)}- ${n.title}`,
    ...outlineBullets(n.children, depth + 1),
  ]);
}

/**
 * The CM1 auto-draft: a PAPER.md skeleton the harness generates on first use,
 * seeded from the CM2 structure tree, for the USER to refine. Every section of
 * the PAPER.md format is present so the user sees what the file can hold.
 *
 * **Its placeholders render in ONE language** (invariant 6 rule 2, ADR 0034).
 * This file is the one place where a mixed string reached a user's repository
 * rather than only their screen, and ADR 0034 §*Consequences* 3 is why it takes
 * a locale rather than being Englished: the text is written into a file the
 * user owns and then edits, so it follows the locale at scaffold time and is
 * theirs from that moment. Round-trips through parsePaperMd (empty tables,
 * outline preserved) in both locales.
 */
export function draftPaperMd(opts: {
  title: string;
  outline: OutlineNode[];
  /** Venue constraints seeded into "## Venue" — the PAPER.md format marks
   *  these lines auto-seedable from venue.yaml (M10 scaffolder, ADR 0010). */
  venue?: { pageLimit?: string; anonymity?: string; bibstyle?: string };
  /** D4 (ADR 0034): the language the placeholders are drafted in. */
  locale?: SessionLocale;
}): string {
  const zh = opts.locale === "zh";
  const bullets = outlineBullets(opts.outline);
  const venueLine = (key: string, value?: string): string =>
    value !== undefined && value !== "" ? `${key}: ${value}` : `${key}:`;
  const en = [
    "<!-- Lemmaria reads this file on every action that declares a section.",
    "     A section earns its place only if it changes what Lemmaria writes AND",
    "     is stable across sessions — anything task-specific belongs in the",
    "     composer, and anything long or conditional belongs in a Writing Skill",
    "     under .lemmaria/skills/, which costs nothing until it is loaded. -->",
    "",
    "## Contribution",
    "<!-- One or two sentences: what is new? -->",
    "",
    "## Audience",
    "<!-- Who is this written for — which venue's reviewers, how much shared",
    "     background can be assumed? This sets the register every rewrite uses. -->",
    "",
    "## Claims",
    "<!-- The headline claims and results, one per line, with the numbers.",
    "     Lemmaria must not weaken, strengthen or invent any of them. -->",
    "",
    "## Outline",
    "## Glossary",
    "## Symbols",
    "## Venue",
    "## Style",
    "<!-- Only rules that must shape EVERY edit to this paper and are short to",
    "     state (voice, tense, \\citet vs \\citep). Anything longer, conditional,",
    "     or specific to one section belongs in a Writing Skill instead: Lemmaria",
    "     loads a skill when its description matches the work in hand, whereas",
    "     these lines are sent on every run that declares them.",
    "",
    "     e.g.  - Prefer the active voice.",
    "           - citet for a subject citation, citep otherwise. -->",
    "",
  ];
  const zhLines = [
    "<!-- Lemmaria 会在声明了相应小节的每次操作中读取本文件。",
    "     一个小节只有同时满足「会改变 Lemmaria 的写作结果」和「跨会话稳定」",
    "     才值得保留：只与当前任务有关的内容请写在对话框里；篇幅较长或分情况",
    "     的规则请写成 .lemmaria/skills/ 下的写作技能（Writing Skill），",
    "     未被加载时它不占用任何开销。 -->",
    "",
    "## 贡献",
    "<!-- 一两句话：这项工作新在哪里？ -->",
    "",
    "## 读者",
    "<!-- 这篇论文写给谁看——投给哪个会议或期刊的审稿人？可以假定读者具备多少",
    "     背景知识？它决定了每次改写的语域。 -->",
    "",
    "## 主张",
    "<!-- 核心论点与主要结果，每行一条，并写清数字。",
    "     Lemmaria 不得削弱、夸大或凭空添加其中任何一条。 -->",
    "",
    "## 大纲",
    "## 术语",
    "## 符号",
    "## 投稿",
    "## 风格",
    "<!-- 只写那些必须影响本文每一处修改、且能一句话说清的规则（语态、时态、",
    "     \\citet 与 \\citep 的用法）。篇幅更长、分情况或只针对某一节的规则，",
    "     请改写成写作技能（Writing Skill）：技能只在描述与当前工作匹配时才被",
    "     加载，而这里的每一行都会随每次声明它的运行一起发送。",
    "",
    "     例如  - 多用主动语态。",
    "           - 作主语时用 citet，其余情况用 citep。 -->",
    "",
  ];

  const outlineBody =
    bullets.length > 0
      ? bullets
      : [zh ? "- （在此填写计划结构）" : "- (add your intended structure)"];
  const tables = {
    outline: outlineBody,
    glossary: ["| Term | 中文 | Abbrev |", "|------|------|--------|"],
    symbols: ["| Symbol | Meaning |", "|--------|---------|"],
    venue: [
      venueLine("page_limit", opts.venue?.pageLimit),
      venueLine("anonymity", opts.venue?.anonymity),
      venueLine("bibstyle", opts.venue?.bibstyle),
    ],
  };
  const headingBody: Record<string, string[]> = {
    "## Outline": tables.outline,
    "## 大纲": tables.outline,
    "## Glossary": tables.glossary,
    "## 术语": tables.glossary,
    "## Symbols": tables.symbols,
    "## 符号": tables.symbols,
    "## Venue": tables.venue,
    "## 投稿": tables.venue,
  };

  const out: string[] = [`# ${opts.title}`, ""];
  for (const line of zh ? zhLines : en) {
    out.push(line);
    const body = headingBody[line];
    if (body) out.push(...body, "");
  }
  return out.join("\n");
}

/**
 * Directory-level PAPER.md candidates for an entry file, nearest first,
 * EXCLUDING the root "PAPER.md" (that is the project layer). Pure string
 * logic over posix-style workspace-relative paths, shared by both hosts.
 */
export function directoryPaperCandidates(entryFile: string): string[] {
  const parts = entryFile.split("/").slice(0, -1); // drop the filename
  const out: string[] = [];
  while (parts.length > 0) {
    out.push(`${parts.join("/")}/PAPER.md`);
    parts.pop();
  }
  return out;
}
