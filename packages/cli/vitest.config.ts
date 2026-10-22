import { defineConfig } from "vitest/config";

// `test/live/**` is deliberately excluded: those tests call real models, cost
// money, and need keys. They run only via `pnpm test:live`
// (vitest.live.config.ts). Excluding by CONFIG, not by a runtime guard alone,
// is what keeps `pnpm test` free and offline even if a guard is forgotten.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Setting `exclude` REPLACES vitest's defaults, so the standard ignores
    // have to be restated — otherwise this starts scanning node_modules.
    exclude: ["**/node_modules/**", "**/dist/**", "test/live/**"],
  },
});
