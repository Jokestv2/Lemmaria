# Provenance — `blind-reviewer`

**Adapted from:** [`nature-skills`](https://github.com/Yuan1z0825/nature-skills)
→ `skills/nature-reviewer/SKILL.md`.

**Licence:** Apache-2.0, declared at the repository level (`LICENSE`). There is
no per-skill licence file and no `NOTICE` file in that repository, so there is
nothing further to reproduce.

**Read at:** commit `ebd722e18808442688bd205917a3e774195c258f` (2026-09-01), the
checkout kept at the app root as `../nature-skills/` for prior-art study.

**Adapted on:** 2026-09-03, for milestone R3 ([ADR 0061](../../../../Lemmaria-design-doc/docs/adr/0061-the-blind-panel.md)).

**What was taken, and what was not.** Ideas and structure only: the separation
of a reviewer's lens from the concerns it may raise, the honesty clause, the
Major/Minor/Blocking tiering, and the *no quota* rule — that a reviewer with
nothing to say says nothing rather than padding. **No text was copied.** Every
sentence in `SKILL.md` and `SKILL.zh.md` is written for Lemmaria's own protocol,
and the parts that carry the most weight have no counterpart upstream at all:
the byte-exact single-line anchor rule and the `evidence` / `"missing"`
distinction come from `interpretLedger` (ADR 0060), which locates every concern
in the manuscript's own bytes, and the whole-line phrasing comes from R2's live
measurement that models join hard-wrapped lines unless told not to in so many
words. The output block is `interpretLedger`'s wire format, not the upstream
skill's — the interpreter is the authority and this file is its student.

**The upstream skill is not shipped, vendored, or redistributed.** What reaches
a user is the two files beside this one and this record itself — all three
Lemmaria's own text, under the licence the extension ships as
`LICENSE.txt`.

**2026-09-07 (R9, ADR 0069):** the protocol's second person changed from *one
seat of a review panel* to *one reviewer on a review panel*, in both locales, and
the Grounding block's heading from *for the seat whose lens is positioning* to
*for every reviewer*. **No rule changed** — R9 replaced three lens-partitioned
seats with N standalone reviewers, so a model told it was "one seat" of a panel
whose brief never mentions a seat would have been handed two vocabularies for
one role. The upstream relationship recorded above is unaffected.

**2026-09-17 (X5, [ADR 0074](../../../../Lemmaria-design-doc/docs/adr/0074-the-ledger-survives-a-real-paper.md)):
a rule CHANGED** — the contrast with the entry above is the point of recording
it. The Grounding block's fourth bullet was *"Name what did not answer, inside
the concern"*; it is now *"A source that did not answer is not a concern."* The
operator's gate-review round produced entries whose whole content was a
literature outage, offered to the author to *Resolve* — a problem the author
cannot fix, filed against their paper. The harness already records which sources
failed and already tells the author, so the old bullet asked for a duplicate in
the one place it does harm. Rule 9's last sentence moved with it, as a
consequence rather than a second decision: left as it was, it would have asked
for inside rule 9 exactly what the Grounding block now forbids.

Three additions in the same pass, both locales: rule 3 now asks for the `file`
every anchor was copied from unless the brief says the manuscript is one file
(the locator searches the whole manuscript from X5, and the named file is where
that search starts); rule 13's template says the same; and a closing paragraph
tells the reviewer that the harness checks its work and may come back once,
asking for **corrections only** — so a seat answers with what failed rather than
a fresh ledger that puts what already located back at risk.

The block still has exactly four bullets, so its own *"These four"* / *"下面四条"*
stays true, and the upstream relationship recorded above is unaffected. No text
was taken from anywhere for any of it.

**2026-09-20 (V2, [ADR 0078](../../../../Lemmaria-design-doc/docs/adr/0078-prior-work-is-located-too.md)):
three changes, both locales, and one of them changes what a reviewer may do.**
Rule 4 now names **three** kinds of evidence rather than two — the third is a
**paper**, cited by a title one of that reviewer's own searches returned, which
the harness checks against those recorded results and drops the whole concern
without. Rule 9 gains a requirement rather than an exhortation: a concern under
`originality` **must** carry a paper, and a suspicion that no search confirms
goes under `positioning` with the manuscript passage that makes the claim — the
redirection is part of the rule, because a reviewer told only what it may not do
files nothing at all. The Grounding block's second bullet gains one clause: the
manuscript itself is never among the results, because the harness withholds it.

**A new unnumbered block, *Experiments first*, sits after Grounding and before
rule 10** — unnumbered so that **no rule is renumbered**, since `SKILL.md`,
`SKILL.zh.md`, ADR 0074 §9, ADR 0078 and two test files all cite these numbers
and a renumbering would silently invalidate every citation. The Grounding block
still has exactly four bullets, so its own *"These four"* / *"下面四条"* stays
true, and the upstream relationship recorded above is unaffected.

The `originality` requirement has no counterpart upstream, and neither does the
*experiments first* block; both come from the stage's own study of what LLM
reviewers do badly — novelty asserted and never questioned, and experimental
gaps found least often of the four planted-defect categories. **No text was
taken from anywhere for any of it.**
