import { describe, expect, it } from "vitest";
import { HARNESS_PACKAGE_NAME } from "../src/index.js";

describe("@lemmaria/harness", () => {
  it("exports its package name", () => {
    expect(HARNESS_PACKAGE_NAME).toBe("@lemmaria/harness");
  });
});
