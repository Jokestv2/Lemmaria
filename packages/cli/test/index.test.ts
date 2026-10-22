import { describe, expect, it } from "vitest";
import { CLI_PACKAGE_NAME } from "../src/index.js";

describe("@lemmaria/cli", () => {
  it("exports its package name", () => {
    expect(CLI_PACKAGE_NAME).toBe("@lemmaria/cli");
  });
});
