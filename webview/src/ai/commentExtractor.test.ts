import { describe, expect, it } from "vitest";
import { extractCommitCommentFromDiff } from "../../../src/ai/commentExtractor";

describe("extractCommitCommentFromDiff", () => {
  it.each([
    ["// BUG-217: avoid duplicate refresh", "BUG-217: avoid duplicate refresh"],
    ["// FIX #42: handle empty response", "FIX #42: handle empty response"],
    ["// 功能-8：添加快速提交", "功能-8：添加快速提交"],
  ])("extracts numbered comment %s", (source, expected) => {
    const diff = `@@ -1 +1 @@\n-${source}\n+${source}`;

    expect(extractCommitCommentFromDiff(diff)).toBe(expected);
  });

  it("extracts a marker from a multiline block comment", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      "-/*",
      "- * old note",
      "- */",
      "+/**",
      "+ * Feature #123: add quick commit",
      "+ */",
    ].join("\n");

    expect(extractCommitCommentFromDiff(diff)).toBe(
      "Feature #123: add quick commit",
    );
  });

  it("does not use removed comments or ordinary code as a commit message", () => {
    const diff = [
      "@@ -1 +1 @@",
      "-// BUG-217: old note",
      '+const message = "FIX-42";',
    ].join("\n");

    expect(extractCommitCommentFromDiff(diff)).toBeNull();
  });
});
