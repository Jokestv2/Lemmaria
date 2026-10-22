# Changelog

All notable changes to Lemmaria are recorded here. This file follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html) and is pre-1.0, so minor versions may
change behaviour.

## [Unreleased]

### Changed

- **Licence.** Lemmaria is now licensed under the
  [PolyForm Strict License 1.0.0](https://polyformproject.org/licenses/strict/1.0.0): free to use
  for any noncommercial purpose. Versions up to and including 0.3.0 remain under the licence they
  shipped with.

## [0.3.0] — first published release

The first release published to the Marketplace. It carries everything the build has shipped so far;
the entries below group it by what a user can do rather than by the milestone that built it.

### Writing and editing

- **Quick actions** on a selection — Polish, Proofread, Expand By, Shrink By, Translate — each
  returning an **inline diff** you Accept or Reject. Nothing is written without that Accept.
- An **agentic Assistant panel**: multi-turn sessions with a composer, `@` references to files and
  selections, a command menu, streamed answers, and tool activity shown as it happens.
- **Sessions** you can resume, **fork**, and **rewind** from any message, with conversation
  **compaction** when a session grows long.
- **Verified edits** — every accepted edit listed, each individually rollbackable, with a per-turn
  checkpoint you can restore from in one step.
- **Writing Skills**: Markdown instruction files, bundled or your own under `~/.lemmaria/skills`,
  loaded when relevant and governed by a catalogue budget.

### Reviewing

- **Blind review panel** — independent reviewers over your manuscript, each concern anchored to a
  byte-exact quote in your text. Reviewers cannot see each other's findings.
- A **concern ledger** with dimensions, severities, and navigation straight to the anchored span.
- **Review never writes.** It is read-only by construction, not by policy.

### Citations and literature

- **Citation checking** against your `.bib`, flagging keys it cannot ground.
- **Literature search** over Crossref and arXiv through a paced client that honours each host's own
  backoff signal, with an optional contact e-mail for Crossref's polite pool.

### LaTeX

- **Compile check** with `latexmk`, `tectonic`, `xelatex`, `lualatex`, `pdflatex`, or auto-detection.
- The compile log parsed into navigable **findings**, each with an offered fix.
- **Venue library** — scaffold a paper from a bundled venue template, carrying its conventions.
- `PAPER.md` as standing context, including a `## Glossary` table that is enforced on Translate.

### Models, cost, and capability

- **Multi-model configuration** — Anthropic-protocol and any OpenAI-compatible endpoint, including
  local ones. Keys live in VS Code's secret storage.
- **Cost tracking** for this run, today, and in total, in the status bar or its own panel.
- **Capability grants** — read access to a folder outside the workspace, granted per session by you
  and revocable.
- **Script execution** (`run_script`) gated on your explicit approval, limited to interpreters you
  list.
- Per-task ceilings on output tokens, tool calls, turns, retrieval, and subagent fan-out.

### Interface

- The **Lemmaria visual identity** throughout: the three-pebble mark in the Activity Bar, the
  secondary sidebar, the panel container, and the editor title bar, with the listing icon and banner.
- A **motion indicator** on the "thinking" row, built as DOM nodes under the webview's strict
  content-security policy and honouring `prefers-reduced-motion`.
- A **welcome state** in an empty Assistant panel.
- **One language per reader** — Chinese for a Chinese VS Code, English for every other display
  language, with the model's output language settable separately.
