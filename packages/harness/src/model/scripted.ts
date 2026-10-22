import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelStreamEvent,
  Protocol,
  ToolCall,
  Usage,
} from "../contracts/adapters.js";

/** One scripted turn. Everything is optional: `{}` is a silent `stop`. */
export interface ScriptedTurn {
  text?: string;
  toolCalls?: ToolCall[];
  stopReason?: GenerateResult["stopReason"];
  usage?: Partial<Usage>;
  /** Opaque reasoning blocks to echo back into history (ADR 0006). */
  reasoning?: unknown;
  /**
   * Scripted failure: the call throws this (an Error with `status` attached)
   * `times` times (default 1) before serving the turn — on the streamed path
   * after the first delta, on the unary path immediately. The turn itself
   * stays scripted, so a retry re-serves it, which is what makes a retry
   * policy testable end to end.
   */
  failure?: { message: string; status?: number; times?: number };
  /**
   * Abort partway through the turn: emit this many delta events, then the
   * `aborted` terminal, without consuming the turn. Streamed path only — the
   * unary path has no deltas to stop between. Before B0 a mid-turn abort
   * could only be produced by racing an event handler from the test.
   *
   * Must be < the turn's delta count, else the abort could never fire and the
   * test would pass on a `completed` it did not ask for; that is a throw, not
   * a silent no-op. Combining it with `failure` is legal — the failure wins on
   * the first attempt and the abort happens on the retry.
   */
  abortAfterDeltas?: number;
}

/**
 * The script ran out of turns. A distinct class (and a message naming the
 * script's length) because the alternative — a bare `Error` — is caught by the
 * loop and rendered as a model failure, so an over-run script reads like a
 * flaky provider instead of a broken test. `classifyStreamFailure` returns
 * `fatal` for it (B2), so it is never retried into silence.
 */
export class ScriptExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptExhaustedError";
  }
}

/** Split a string into two roughly-even fragments (one when too short). */
function fragments(s: string): string[] {
  if (s.length < 2) return s.length === 0 ? [] : [s];
  const mid = Math.ceil(s.length / 2);
  return [s.slice(0, mid), s.slice(mid)];
}

/**
 * Deterministic ModelAdapter for tests (the ModelAdapterFactory seam): serves
 * scripted turns in order and records every request for assertions. Keeps all
 * suites offline (architecture Testing Strategy).
 *
 * Adapted from Pi's faux provider (`registerFauxProvider` /
 * `FauxModelDefinition` / `FauxResponseStep`, MIT). **Deliberate divergence:**
 * the script is POSITIONAL rather than matched against the request. The order
 * of turns is usually the thing under test in this loop (compaction fires
 * between them, retries re-serve them), and a positional script keeps a failing
 * assertion local — a matcher that silently stops matching sends you looking in
 * the wrong file. A responder form is a small addition if one is ever needed.
 */
export class ScriptedModelAdapter implements ModelAdapter {
  readonly requests: GenerateRequest[] = [];
  private next = 0;
  /** Remaining scripted failure throws, by turn index. */
  private readonly failuresLeft = new Map<number, number>();

  constructor(
    private readonly turns: ScriptedTurn[],
    readonly protocol: Protocol = "anthropic",
  ) {}

  get requestCount(): number {
    return this.requests.length;
  }

  lastRequest(): GenerateRequest | undefined {
    return this.requests.at(-1);
  }

  /** The scripted turn at `index`, or a loud exhaustion failure. */
  private turnAt(index: number): ScriptedTurn {
    const turn = this.turns[index];
    if (!turn) {
      throw new ScriptExhaustedError(
        `ScriptedModelAdapter: the script ran out — asked for turn ${index + 1} of ${this.turns.length}`,
      );
    }
    return turn;
  }

  /** Consume one scripted `failure`, if this turn still owes one. */
  private takeFailure(index: number, turn: ScriptedTurn): void {
    if (!turn.failure) return;
    const left = this.failuresLeft.get(index) ?? turn.failure.times ?? 1;
    if (left <= 0) return;
    this.failuresLeft.set(index, left - 1);
    throw Object.assign(new Error(turn.failure.message), {
      ...(turn.failure.status !== undefined
        ? { status: turn.failure.status }
        : {}),
    });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    // Honor an aborted signal like a real adapter does (timeout or caller abort).
    if (req.signal?.aborted) {
      return {
        text: "",
        toolCalls: [],
        stopReason: "aborted",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    const turn = this.turnAt(this.next);
    // The turn is NOT consumed by a scripted failure, so a retry re-serves it.
    this.takeFailure(this.next, turn);
    this.next += 1;
    const toolCalls = turn.toolCalls ?? [];
    return {
      text: turn.text ?? "",
      toolCalls,
      stopReason:
        turn.stopReason ?? (toolCalls.length > 0 ? "tool_use" : "stop"),
      ...(turn.reasoning !== undefined ? { reasoning: turn.reasoning } : {}),
      usage: { inputTokens: 10, outputTokens: 5, ...turn.usage },
    };
  }

  /**
   * Scripted streaming (ADR 0015): the scripted turn split into ≥2 text /
   * tool-arg fragments, then the exact unary `GenerateResult` as the
   * `completed` terminal. The signal is checked between every yield so tests
   * can abort deterministically from an event handler, and `abortAfterDeltas`
   * scripts the same thing declaratively. A `failure` turn throws after the
   * first delta without consuming the turn (a retry re-serves it).
   */
  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(req);
    if (req.signal?.aborted) {
      yield { type: "aborted" };
      return;
    }
    const index = this.next;
    const turn = this.turnAt(index);

    const events: ModelStreamEvent[] = [];
    for (const piece of fragments(turn.text ?? "")) {
      events.push({ type: "text_delta", text: piece });
    }
    (turn.toolCalls ?? []).forEach((call, callIndex) => {
      const argPieces = fragments(JSON.stringify(call.args));
      argPieces.forEach((piece, i) => {
        events.push({
          type: "tool_call_delta",
          index: callIndex,
          ...(i === 0 ? { id: call.id, name: call.name } : {}),
          argsDelta: piece,
        });
      });
    });

    if (turn.failure) {
      // Streamed failures arrive mid-turn: emit the first delta, then throw.
      const left = this.failuresLeft.get(index) ?? turn.failure.times ?? 1;
      if (left > 0 && events[0]) yield events[0];
      this.takeFailure(index, turn);
    }

    if (
      turn.abortAfterDeltas !== undefined &&
      turn.abortAfterDeltas >= events.length
    ) {
      // A scripted abort that can never fire would let a mis-sized test pass on
      // a `completed` it never asked for. Fail loudly instead (review, Minor).
      throw new Error(
        `ScriptedModelAdapter: abortAfterDeltas ${turn.abortAfterDeltas} is not below this turn's ${events.length} delta event(s) — the abort could never fire`,
      );
    }

    let emitted = 0;
    for (const event of events) {
      if (
        turn.abortAfterDeltas !== undefined &&
        emitted >= turn.abortAfterDeltas
      ) {
        // Scripted mid-stream abort: the turn is not consumed, exactly as a
        // real adapter leaves nothing behind when the signal wins the race.
        yield { type: "aborted" };
        return;
      }
      if (req.signal?.aborted) {
        yield { type: "aborted" };
        return;
      }
      yield event;
      emitted += 1;
    }
    if (req.signal?.aborted) {
      yield { type: "aborted" };
      return;
    }
    this.next += 1;
    const toolCalls = turn.toolCalls ?? [];
    yield {
      type: "completed",
      result: {
        text: turn.text ?? "",
        toolCalls,
        stopReason:
          turn.stopReason ?? (toolCalls.length > 0 ? "tool_use" : "stop"),
        ...(turn.reasoning !== undefined ? { reasoning: turn.reasoning } : {}),
        usage: { inputTokens: 10, outputTokens: 5, ...turn.usage },
      },
    };
  }
}

/**
 * A scripted adapter that dispatches on the exact text of the LAST user
 * message, so one adapter drives a parent task and every child it spawns —
 * children are separate sessions whose only user message is their goal.
 *
 * Each key gets its own `ScriptedModelAdapter`, so per-key cursors stay
 * independent when children run in parallel. An unscripted key answers
 * `"unscripted"` once rather than throwing, so a test asserts on what it
 * scripted instead of on the shape of everything it did not.
 *
 * Lifted out of `run.test.ts` at R3: the review panel's driver tests need the
 * same dispatch, and two copies of a test helper drift exactly as two copies
 * of anything else do.
 */
export function scriptedByKey(
  scripts: Record<string, ScriptedTurn[]>,
): ModelAdapter {
  const adapters = new Map<string, ScriptedModelAdapter>();
  const get = (key: string): ScriptedModelAdapter => {
    let a = adapters.get(key);
    if (!a) {
      a = new ScriptedModelAdapter(scripts[key] ?? [{ text: "unscripted" }]);
      adapters.set(key, a);
    }
    return a;
  };
  const keyFor = (req: GenerateRequest): string => {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    return typeof lastUser?.content === "string" ? lastUser.content : "";
  };
  return {
    protocol: "anthropic",
    generate(req) {
      return get(keyFor(req)).generate(req);
    },
    async *generateStream(req) {
      yield* get(keyFor(req)).generateStream(req);
    },
  } as ModelAdapter;
}
