# Laundering audit: the scorecard's laundered twin

Date: 2026-09-27

`laundered/main.tex` is `planted/main.tex` with its prose rephrased and
nothing else changed. It carries the same sixteen planted defects and the same
six traps. If a panel's reading differs between `planted/` and
`laundered/`, the panel reacted to wording, not to substance. This file sits
outside `laundered/` so that no reviewer reads it.

## The rule followed

- **Rephrased:** every prose line of the document body. That covers the
  abstract, every paragraph, the lemma, proposition and proof bodies, and the
  text that follows each `\paragraph{...}` title. Sentences were re-ordered
  and restructured within their paragraph, not just given new words, and every
  paragraph was re-wrapped at 80 columns or fewer. Some paragraphs gained or
  lost a line.
- **Kept byte for byte:**
  - The preamble. Everything up to and including `\begin{document}` was
    copied from planted by a script.
  - All nine verbatim environments, copied by the same script: equations
    `eq:dense`, `eq:support`, `eq:summary`, `eq:score`, `eq:cost` and
    `eq:crossover`, and tables `tab:main`, `tab:needle` and `tab:ablation`.
  - Every `\section`/`\subsection` line, with its `\label`.
  - The `\paragraph{...}` titles.
  - The lemma, proposition and proof `\begin`/`\end` lines, with their titles and labels.
  - Every `\ref`/`\eqref` target.
  - The `\bibliography` lines.
- **Kept as a multiset:**
  - Every citation key: the same keys, the same number of times, and the same
    `\citep`/`\citet` choice.
  - Every numeric literal in the file (`32k`, `4-billion`, `98\%`,
    `$i = 1$`, `$\pm 0.1$`, `0.30`, `(780 ms)` and so on).
  - Every number written as a word that carries meaning: "six blocks", "five
    seeds", "three seeds", "two perplexity points".
- **Not done:** no defect was repaired, sharpened or softened. No hedge,
  emphasis or explanatory clause was added. No clean-twin (`original`)
  wording was re-introduced. A grep of the laundered file finds no `\notin`,
  "normaliser", "twice", "four million", "same optimiser", "report the mean",
  `0.03` or `88`. `M_S` does not appear in the lemma statement. The
  Discussion's "by construction" became "inherently", with the same meaning;
  that sentence carries no defect.
- **The prose-line rule** is the one in
  `packages/cli/test/eval/scorecard-fixture.test.ts`. A prose line is a
  body line that is not blank, not a `%` comment, not inside a verbatim
  environment, and does not open with a structural command. A prose line is
  *rewritten* when its trimmed text equals no trimmed line of
  `planted/main.tex`.
  - **Measured: 287 of 287 prose lines rewritten (100%).** The planted twin
    has 269 prose lines; the paraphrase runs slightly longer.
  - A stricter measure counts a line as merely re-wrapped when all its words,
    or all but one word at either end, occur as one contiguous run in the
    planted body. By that measure 268 of 287 lines (93%) are rewritten. The
    other 19 are short paragraph tails (such as `$b = 32$.`) or lines dense
    with math that had to survive intact (such as the Setup's
    `$w = 112$, $g = 16$ ... $r = 384$`).
- The laundered file has 475 lines against planted's 457, so the `line`
  anchors in `planted-defects/defects.json` do not apply to it. The line
  numbers below are the laundered file's own.

## The sixteen defects, as they stand in the laundered twin

**S1** (surface / operator-sign). The crossover denominator is `2 b^2 + 1`,
where solving the cost equation gives `2 b^2 - 1`. The stated
`n* ~ 512.06` does not follow from it. The equation is unchanged, and the
prose still quotes 512.06 from it:

```
271:   n^{*} = \frac{2 k b^{2}}{2 b^{2} + 1} ,
273: beyond which Corridor Attention is the cheaper layer. With $k = 512$ and
274: $b = 64$, this comes to $n^{*} \approx 512.06$, so the corridor starts paying
275: off once the context exceeds the bandwidth. At $n = 32$k the scorer's term is
```

**S2** (surface / index-subscript). The block summary sums `K_j` over `t`, so
the "mean of its keys" is the single key `K_j`. The equation is unchanged,
and the prose still calls it the mean of the block's keys:

```
195:   s_j = \frac{1}{b} \sum_{t=(j-1)b+1}^{jb} K_j ,
192: sequence is divided into $m = \lceil n/b \rceil$ blocks, each of $b$
193: consecutive positions, and block $j$ is summarised by the mean of its keys,
```

**S3** (surface / numeric). The support bound reads `w + g + 2r = k`, while
Background defines `k = w + g + r`. The equation is unchanged, and the
definition is kept:

```
181:   S_i = W_i \cup G \cup R_i, \qquad |S_i| \le w + g + 2r = k,
133: $g$ global summary tokens. Everywhere below, \emph{bandwidth} means
134: $k = w + g + r$, with $r$ denoting the routed bandwidth.
```

**S4** (surface / computation). `112 + 16 + 384` is stated as `522`; it is
512, and the cost model uses `k = 512`. Both are kept:

```
302: tokens and a routed bandwidth of $r = 384$ (six blocks of $b = 64$), so the
303: bandwidth is $k = w + g + r = 112 + 16 + 384 = 522$.
273: beyond which Corridor Attention is the cheaper layer. With $k = 512$ and
```

**C1** (claim / false theoretical claim, dropped restriction). The lemma
equates Corridor Attention with plain `Equation~\eqref{eq:dense}`, the
dense layer, not with that equation under `M_S`. The proof does not show
this, and Table 1 contradicts it (12.1 against 11.9). The statement is
rephrased, and the bare reference is kept:

```
238: Let $i$ be any query with $S_i \ne \emptyset$. The output Corridor Attention
239: produces for $i$ equals the output of Equation~\eqref{eq:dense}.
344:     Dense attention           & 12.4 & 11.9 & 1840 \\
351:     Corridor Attention (ours) & 12.6 & 12.1 &  660 \\
```

**C2** (claim / false empirical claim). The paper says Corridor Attention
recovers "98%" of the window-to-dense gap. Table 1 gives
(13.5 - 12.1)/(13.5 - 11.9) = 87.5%. Kept:

```
327: single training step at 32k. At 32k, Corridor Attention attains 12.1, against
328: 11.9 for dense attention and 13.5 for the sliding window: at a matched
329: training budget it recovers 98\% of the gap between the window and dense
330: attention, while using 36\% of the dense step time. Linformer and Performer
```

**C3** (claim / false theoretical claim). The Conclusion calls the cost
"constant in the sequence length". The abstract (linear, with a constant the
practitioner sets) and `eq:cost` contradict it. Kept, together with the
abstract's contradicting sentence:

```
468: through a learned, block-scored selection. Under it, the cost of long-context
469: attention stays constant in the sequence length, and on the long-context
33: What results is an attention layer whose cost grows linearly with sequence
34: length, with a constant the practitioner chooses directly. We present the
```

**C4** (claim / false empirical claim, inverted). The Ablations say that
removing the routed corridor costs more than removing the local window.
Table 3 says the opposite (+2.8 for the window, +1.3 for the corridor), and
so does the Introduction's third commitment. The sentence, the table and the
opposing commitment are all kept:

```
391: In Table~\ref{tab:ablation}, each row removes or freezes a single component
392: of the 350M model at 32k. Removing the entire routed corridor raises
393: perplexity by more than removing the dense local window does, and this is the
394: observation on which the third design commitment of Section~\ref{sec:intro}
395: rests. A router frozen at its initialisation costs 1.1, which shows that the
410:     No local window ($w = 0$)     & 14.9 & $+2.8$ \\
411:     No routed corridor ($r = 0$)  & 13.4 & $+1.3$ \\
91: \paragraph{The local window is not negotiable.} Removing the dense local
92: window hurts perplexity far more than removing any equal amount of routed
93: bandwidth. For that reason the window is part of the architecture, not one
```

**R1** (reasoning / circular). The proof of the proposition "Cost is
independent of routing" takes that independence as its premise in order to
derive `|R_i| = r`. The premise is reworded and is still the proposition's
own conclusion. As in planted, the proof does not bring in the scorer
section's construction (`rho = r/b` blocks):

```
248: \begin{proposition}[Cost is independent of routing]\label{prop:cost}
249: Suppose $r$ is a multiple of $b$. Then, whatever the scorer chooses, no query
250: attends to more than $k$ key positions.
251: \end{proposition}
252: \begin{proof}
253: Which blocks the scorer picks has no effect on the cost of the layer, so each
254: query attends to an equal number of routed positions, giving $|R_i| = r$ for
255: all $i$. Together with $|W_i| \le w$ and $|G| = g$,
256: Equation~\eqref{eq:support} then yields $|S_i| \le k$.
```

**R2** (reasoning / invalid implication). A comparison at one `n` (32k) is
used to conclude that the cost is linear in `n`. The single data point and
the "hence" are kept. No range bound was added, and neither was any
"for all n":

```
275: off once the context exceeds the bandwidth. At $n = 32$k the scorer's term is
276: below the attention term, and hence the cost of the layer is linear in $n$.
```

**R3** (reasoning / missing case). The exactness proof treats only
`j in S_i` and jumps from agreeing logits to agreeing distributions. Nothing
about `j notin S_i`, `-infinity`, zero exponentials or the normaliser was
added:

```
241: \begin{proof}
242: Let $\ell_{ij} = q_i \cdot k_j / \sqrt{d_h}$. Whenever $j \in S_i$, the masked
243: logit $\ell_{ij} + (M_S)_{ij}$ is simply $\ell_{ij}$. The two softmaxes
244: therefore agree on every term of $S_i$, and so the two distributions are the
245: same.
246: \end{proof}
```

**R4** (reasoning / induction error). The base case claims that block 1's
positions are all at most 1, which is false for `b > 1`. The step argues
about block indices, not positions. The causal mask `M` is still not
mentioned:

```
221: We argue by induction on $i$ that a selected key never lies in the future of
222: its query. In the base case $i = 1$, block $1$ is the only admissible block,
223: and every position in it is at most $1$. For the step, if the claim holds for
224: $i$ then it holds for $i + 1$ as well, since
225: $\lceil (i+1)/b \rceil \ge \lceil i/b \rceil$, which admits no earlier block.
```

**E1** (experimental / reversed causality). The paper says the high accuracy
at 28k is what lets the corridor carry the signal. The `r = 0` ablation
shows the reverse. The direction, accuracy enabling the corridor, is kept:

```
367: outside its window. Corridor Attention declines gracefully, from 98\% at 4k
368: to 91\% at 28k. It is the high accuracy at 28k that enables the routed
369: corridor to carry a long-distance signal: setting $r = 0$ drops it from 91\%
370: to 4\%.
381:     Corridor, $r = 0$         & 97 & 11 &  4 \\
```

**E2** (experimental / misinterpretation of results). The paper calls
`p = 0.30` "strong evidence" that the gap is real. Kept, "strong evidence"
included:

```
334: which takes 1.5 times our step time. For the difference between Corridor and
335: BigBird at 32k, the paired test gives $p = 0.30$, strong evidence that the
336: 0.6-point gap is real.
```

**E3** (experimental / p-hacking). The paper reports the best of five seeds,
calls any difference above 0.2 "real", and runs a t-test "over the three
seeds". Table 1's caption still says "mean of three seeds". Nothing reconciles
five with three:

```
318: configuration we train five seeds and report whichever run reaches the lowest
319: perplexity. Across seeds the spread is $\pm 0.1$, so any difference above
320: $0.2$ is treated as real; where a comparison is close, we report a paired
321: $t$-test over the three seeds.
355:     the wall-clock time of one training step at 32k context; mean of three
356:     seeds.}
```

**E4** (experimental / flawed design, unequal baseline). The baselines are
trained for 50k steps, half the budget, with their published
hyperparameters. The results still claim "a matched training budget". Both
are kept:

```
311: clusters \citep{roy2021efficient}. Each baseline runs for 50k steps, half our
312: budget, under its published hyperparameters, and every sparse baseline is
313: configured so that no query sees more than 512 keys, matching $k$.
328: 11.9 for dense attention and 13.5 for the sliding window: at a matched
329: training budget it recovers 98\% of the gap between the window and dense
```

## The six traps

Each trap's answer is still present in the laundered twin:

- **T1:** the cost model is validated against measured time, at lines 425–429.
- **T2:** the frozen-router ablation (+1.1) separates learned routing from
  extra bandwidth, at lines 395–397.
- **T3:** the negative result is at lines 439–442 and the limitations
  paragraph at lines 456–462.
- **T4:** block sizes 32 and 128 are ablated and 64 is justified, at lines
  398–401.
- **T5:** the global summaries are ablated (0.3), at lines 397–398.
- **T6:** "nothing above 350M" is acknowledged, at lines 442–445.

## Borderline cases, and how each was kept equivalent

- **C4 and E1.** Here the planted wording is itself the defect: an inverted
  comparison, and a reversed causal direction. A natural paraphrase drifts
  back to the clean reading ("the corridor carries the signal"; "the window
  costs more"). Both sentences were checked clause by clause. C4 still
  compares the two ablations with no numbers in the sentence and still names
  the third commitment as resting on it. E1 still makes the 28k accuracy the
  subject that "enables" the corridor. E1's cleft ("It is the high accuracy
  at 28k that...") matches the planted pseudo-cleft ("The high accuracy at
  28k is what lets..."). It is not more emphatic.
- **R3.** The defect is an omission, so the only risk was adding something.
  The laundered proof has the same two steps (logits agree on `S_i`,
  therefore the distributions agree) and nothing more.
- **R1.** The premise changed from "Since the cost of the layer does not
  depend on which blocks the scorer chooses" to "Which blocks the scorer
  picks has no effect on the cost of the layer". It is the same premise, and
  it is still the proposition's conclusion.
- **C1.** The lemma's grammar changed from "For every query ... the output of
  Corridor Attention equals ..." to "Let `i` be any query ... The output
  Corridor Attention produces for `i` equals ...". The quantifier, the
  non-empty condition and the unqualified `Equation~\eqref{eq:dense}` are
  unchanged. No word such as "dense", "masked" or "restricted" was added to
  it.
- **S1, S2, S3.** The defect lives in an equation that is byte-identical, so
  only the prose partner could drift. Each partner was checked: `512.06`
  from `k = 512, b = 64`; "the mean of its keys"; and "bandwidth means
  `k = w + g + r`".
