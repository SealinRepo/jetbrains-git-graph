import type { HunkAssignment } from "../../shared/types/changelists";

/**
 * 从完整 `git diff` 输出中过滤出落在目标行号区间内的 hunk。
 * 保留 `diff --git` / `--- a/` / `+++ b/` 头；hunk 体只保留目标区间内的行。
 * 返回的 patch 可直接喂给 `git apply --cached`。
 */
export function filterPatchByHunks(
  fullPatch: string,
  hunks: HunkAssignment[],
): string {
  if (!fullPatch.trim()) return "";
  if (hunks.length === 0) return "";

  const lines = fullPatch.split("\n");
  const out: string[] = [];
  let fileHeader: string[] = [];
  let inHunk = false;
  let keepHunk = false;
  let hunkLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (out.length > 0 && fileHeader.length > 0) {
        out.push(...fileHeader);
        out.push(...hunkLines);
      }
      fileHeader = [line];
      inHunk = false;
      keepHunk = false;
      hunkLines = [];
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      fileHeader.push(line);
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      const newStart = Number.parseInt(hunkMatch[1], 10);
      const newCount = hunkMatch[2] ? Number.parseInt(hunkMatch[2], 10) : 1;
      const newEnd = newStart + Math.max(newCount - 1, 0);
      keepHunk = hunks.some(
        (h) => !(h.endLine < newStart || h.startLine > newEnd),
      );
      inHunk = true;
      hunkLines = [];
      if (keepHunk) hunkLines.push(line);
      continue;
    }
    if (!inHunk) continue;
    if (keepHunk) hunkLines.push(line);
  }
  // 收尾
  if (fileHeader.length > 0) {
    out.push(...fileHeader);
    out.push(...hunkLines);
  }
  return out.join("\n").trim();
}
