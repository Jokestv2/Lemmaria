# Lemmaria

**An AI writing agent for academics.** Lemmaria works on LaTeX and Markdown papers the way a coding
agent works on code — it reads your manuscript, proposes edits you approve one at a time, compiles
and checks what it changed, and reviews your draft the way a program committee would.

Bring your own model key — Anthropic-protocol or any OpenAI-compatible endpoint,
including a local one.

---

## Nothing is written without your approval

This is the rule the whole extension is built around, not a setting.

- Quick actions (**Polish**, **Proofread**, **Expand By**, **Shrink By**, **Translate**) land in an
  **inline diff** you Accept or Reject.
- The agent's own edits arrive as proposals, per file, with a **checkpoint you can restore from in
  one step**.
- Every accepted edit is listed in the **Edits** view and can be rolled back individually.
- `run_script` never runs without your explicit approval, and only the interpreters you list.
- The review panel **never writes at all**.

There is no general shell and no arbitrary network access. Every capability the agent has is a
named, bounded tool, and folder access outside your workspace is granted per session by you.

## What it does

**Write with an agent that knows the document.** An agentic Assistant panel with sessions you can
resume, fork, and rewind; conversation compaction when a session grows long; `@` references to pull
files and selections into context; and a command menu in the composer.

**Review your draft before a reviewer does.** `Lemmaria: Review Selection` runs a **blind panel** of
independent reviewers over your manuscript and returns a ledger of concerns, each one anchored to a
byte-exact quote in your text — so every point it raises, you can jump straight to. Reviewers cannot
see each other's findings, which is what keeps a panel from converging on one opinion.

**Check what you cite.** `Lemmaria: Check Citations` verifies your keys against your `.bib` and
flags what it cannot ground. Literature search reaches Crossref and arXiv through a paced, polite
client — with your contact e-mail if you choose to supply one.

**Compile, and read the log.** `Lemmaria: Compile Check` runs your TeX engine (`latexmk`,
`tectonic`, `xelatex`, `lualatex`, `pdflatex`, or auto-detected), parses the log into findings you
can navigate, and offers a fix for each.

**Start from a venue.** `Lemmaria: New from Venue` scaffolds a paper from a bundled venue template,
carrying that venue's own writing conventions with it.

**Teach it your conventions.** **Writing Skills** are Markdown files — bundled, per-venue, or your
own under `~/.lemmaria/skills` — that Lemmaria loads as instructions when they are relevant. A
`## Glossary` table in `PAPER.md` becomes prompt context and is *enforced* on Translate.

**See what it costs.** Cumulative spend for this run, today, and in total, in the status bar or its
own panel.

## Your model, your key

Configure one or more models in the **Models** tab — Anthropic-protocol or any OpenAI-compatible
endpoint, including a local one. Keys are stored in VS Code's secret storage, never in settings.
Per-task ceilings on output tokens, tool calls, turns, and subagent fan-out are yours to raise or
lower.

## English or 中文

Every string Lemmaria writes renders in **one** language, chosen by your VS Code display language —
Chinese for a Chinese editor, English for everything else. Your document text passes through
untouched in whatever language you wrote it, and word counting picks its unit by script. If you read
an English UI but write a Chinese paper, `lemmaria.language` pins the model's output language
separately from the interface.

## Getting started

1. Open a folder containing a `.tex` or `.md` paper.
2. Open the **Lemmaria** Assistant panel (`Lemmaria: Open Assistant`) and add a model in the
   **Models** tab.
3. Select a paragraph and try `Lemmaria: Polish` — you will get a diff, not a write.
4. Run `Lemmaria: Create PAPER.md` to give Lemmaria the standing context for your paper.

## Requirements

- VS Code 1.106 or later.
- An API key for an Anthropic-protocol or OpenAI-compatible model.
- For compile checks: a local TeX distribution, or `tectonic`.

## Status

Lemmaria is under active development and this is its first published release. It has no persisted
format it owes backward compatibility to; when a design proves wrong it is replaced rather than
shimmed. Questions and bug reports go to the project's
[GitHub Issues](https://github.com/Jokestv2/Lemmaria/issues).

## Licence

Lemmaria is licensed under the PolyForm Strict License 1.0.0: you may use it for any noncommercial
purpose — your own research and study, or work at a university, a public research organisation, a
charity or a government institution. The full terms are in `LICENSE.txt`, and third-party
attributions are in `THIRD-PARTY-NOTICES.md`.
