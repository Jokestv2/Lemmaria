# Changelog

All notable changes to Lemmaria are recorded here. This file follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html) and is pre-1.0, so minor versions may
change behaviour.

## [0.3.1] — 2026-10-22

### Reviewing

- **Review the compiled PDF.** A PDF reviewer looks at the rendered pages of your paper — layout,
  figures, page limits — beside the text reviewers, or on its own: **Review the PDF** in the Review
  tab, or `/review-pdf` in the composer. Its concerns point at the source where the fix belongs, and
  can cite the page it saw.
- **Facts about the PDF, before any model runs** — page count and size, where the references begin
  and the main-text pages that leaves against the venue's limit, an author left in a double-blind
  PDF's metadata, overfull boxes, and the smallest text size.
- **Verification.** Before the cross-review, one more model re-reads each concern against the
  manuscript and withdraws one the text already answers, quoting the passage that does. Withdrawn
  concerns stay visible under *Withdrawn by verification*. Pick its model, or turn it Off, under
  **Verification** in the Models tab.
- **A scorecard** at the top of the Review tab: a readiness word, then one row per dimension — a
  level from Blocking to Strong, its issues and strengths, each reviewer's view — computed from the
  concerns the panel located. Click a row to see its concerns. Reviewers' 1–10 impressions are shown
  faintly and marked uncalibrated; nothing predicts acceptance. Changes since your last comparable
  review are shown.
- **Prior work, located.** An originality concern must cite a paper the reviewer's own search
  returned, shown with its title and link; reviewers' searches leave out your own paper. New
  dimensions: originality, significance and presentation.
- **A panel that reports itself honestly** — how many reviewers and distinct models ran, which seat
  failed and why, consensus between same-model reviewers marked, and "raised no concern" only when
  nothing was raised.

### Models

- **gpt-6-luna** and **Claude Haiku 5.5** are priced and supported.
- Lemmaria knows which models accept images; override it per model with **Image input** in the
  Models tab.

### Settings

- `lemmaria.paperPdf` — a compiled PDF of your paper, relative to the workspace root. Leave it empty
  to use the PDF beside the entry file, or to compile one when a review needs it.

### Fixed

- On a multi-file paper, concerns quoted from a file other than the entry are anchored, not dropped.
- One malformed concern no longer discards a reviewer's whole ledger.
- Papers with PDF figures compile in Compile Check.
- A project inside a folder named `out`, `dist`, `node_modules`, `.git` or `.vscode-test` compiles.

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
