import { defineConfig } from "vitest/config";

// The live tier. Real models, real spend, no network stubs. Never part of
// `pnpm test`; run once per gate via `pnpm test:live`.
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.test.ts"],
    // A live turn is slow, and a retry doubles it.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // Serial: parallel live runs invite rate limits, and a rate-limit failure
    // is indistinguishable from the behaviour failure the test is looking for.
    fileParallelism: false,
    retry: 1,
  },
});
