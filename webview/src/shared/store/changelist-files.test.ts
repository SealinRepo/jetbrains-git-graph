// 解决行尾编译错误字符
import { describe, expect, it } from "vitest";
import {
  computeChangelistFiles,
  resolveChangelistSelection,
} from "./changelist-files";

describe("computeChangelistFiles", () => {
  const file = { path: "src/example.ts", status: "modified" as const };
  const assignments = {
    [file.path]: {
      changelistId: "default",
      hunks: [{ startLine: 10, endLine: 14, changelistId: "custom" }],
    },
  };

  it("does not keep stale hunk ranges when the current diff is empty", () => {
    const entries = computeChangelistFiles({
      changelistId: "custom",
      changes: [file],
      assignments,
      activeChangelistId: "default",
      defaultChangelistId: "default",
      fileHunks: { [file.path]: [] },
    });

    expect(entries).toEqual([]);
  });

  it("uses stored hunk ranges while the current diff is not loaded yet", () => {
    const entries = computeChangelistFiles({
      changelistId: "custom",
      changes: [file],
      assignments,
      activeChangelistId: "default",
      defaultChangelistId: "default",
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].hunkRanges).toEqual([{ startLine: 10, endLine: 14 }]);
  });
});

describe("resolveChangelistSelection", () => {
  it("starts with no files selected when a list has no saved selection", () => {
    expect(resolveChangelistSelection(undefined)).toEqual(new Set());
  });

  it("keeps an explicit selection", () => {
    const selection = new Set(["src/example.ts"]);
    expect(resolveChangelistSelection(selection)).toBe(selection);
  });
});
