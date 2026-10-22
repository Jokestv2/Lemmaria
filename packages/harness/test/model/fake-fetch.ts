export interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  // biome-ignore lint/suspicious/noExplicitAny: raw protocol JSON under test
  body: any;
}

export interface FakeResponseSpec {
  status?: number;
  body: string;
  contentType?: string;
}

/**
 * Sequential offline responses (the last repeats): JSON errors and SSE stream
 * bodies alike. Captures every SDK request like `fakeFetch`.
 */
export function fakeFetchSequence(responses: FakeResponseSpec[]) {
  const captured: CapturedRequest[] = [];
  let call = 0;
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    captured.push({
      url: String(input),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const spec =
      responses[Math.min(call, responses.length - 1)] ??
      ({ body: "" } as FakeResponseSpec);
    call += 1;
    return new Response(spec.body, {
      status: spec.status ?? 200,
      headers: {
        "content-type":
          spec.contentType ??
          (spec.status && spec.status >= 400
            ? "application/json"
            : "text/event-stream"),
      },
    });
  };
  return { fetchImpl, captured };
}

/** One Anthropic-style SSE frame. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Offline stand-in for the network: captures SDK requests, returns a canned body. */
export function fakeFetch(responseBody: unknown) {
  const captured: CapturedRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    captured.push({
      url: String(input),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, captured };
}
