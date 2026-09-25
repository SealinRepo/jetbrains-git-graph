import type { HunkInfo } from "../../../shared/types/changelists";
import type { GitContext } from "./context";

interface RawHunk {
  startLine: number;
  endLine: number;
  oldStart: number;
  oldCount: number;
  contextBefore: string[];
  contextAfter: string[];
  patchText: string;
}

/**
 * 解析 `git diff HEAD -- <filePath>` 输出，提取每个 hunk 的工作区行号区间。
 * 起始 / 结束行基于 hunk 头 `@@ -a,b +c,d @@` 的 c（newStart）+ hunk 体中
 * 第一个 +/- 行到最后一个 +/空格 行。
 */
export async function getFileHunks(
  ctx: GitContext,
  filePath: string,
): Promise<HunkInfo[]> {
  const output = await ctx.execGit([
    "diff",
    "--no-color",
    "HEAD",
    "--",
    filePath,
  ]);
  if (!output.trim()) return [];

  const lines = output.split("\n");
  const hunks: RawHunk[] = [];
  let current: RawHunk | null = null;
  let inHunk = false;
  let contextBuffer: string[] = [];

  for (const line of lines) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      if (current) hunks.push(current);
      current = null;
      inHunk = false;
      continue;
    }
    const hunkHeader = line.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
    );
    if (hunkHeader) {
      if (current) hunks.push(current);
      const newStart = Number.parseInt(hunkHeader[3], 10);
      const newCount = hunkHeader[4] ? Number.parseInt(hunkHeader[4], 10) : 1;
      current = {
        startLine: newStart,
        endLine: newStart + Math.max(newCount - 1, 0),
        oldStart: Number.parseInt(hunkHeader[1], 10),
        oldCount: hunkHeader[2] ? Number.parseInt(hunkHeader[2], 10) : 1,
        contextBefore: contextBuffer.slice(-3),
        contextAfter: [],
        patchText: line,
      };
      contextBuffer = [];
      inHunk = true;
      continue;
    }
    if (!inHunk || !current) continue;
    if (line.startsWith("+")) {
      current.patchText += `\n${line}`;
      // 标记起始（首个 +/- 行）
      continue;
    }
    if (line.startsWith("-")) {
      current.patchText += `\n${line}`;
      continue;
    }
    if (line.startsWith(" ")) {
      current.patchText += `\n${line}`;
      current.contextAfter.push(line.slice(1));
      if (current.contextAfter.length > 3) current.contextAfter.shift();
    } else {
      // 空行 / 文件尾
      current.patchText += `\n${line}`;
    }
  }
  if (current) hunks.push(current);

  return hunks;
}
