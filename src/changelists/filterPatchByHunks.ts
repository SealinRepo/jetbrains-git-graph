import type { HunkAssignment } from "../../shared/types/changelists";

/**
 * 从完整 `git diff` 输出中过滤出落在目标行号区间内的 hunk。
 * 保留完整的文件头（`diff --git` / `index` / `--- a/` / `+++ b/` / mode 行），
 * hunk 体只保留目标区间内的 hunk。返回的 patch 可直接喂给 `git apply --cached`。
 *
 * 两条不能省的规则：
 *  1. 扩展头里的 `index <old>..<new>` 必须原样保留。丢掉它 `git apply` 会直接
 *     报 "git diff header lacks filename information"。
 *  2. 同一文件里可能有多个 hunk 命中目标区间。旧实现在遇到下一个 `@@` 时把
 *     上一个 hunk 的缓冲直接覆盖掉，而只在遇到**下一个** `diff --git` 时才落盘
 *     —— 于是单文件 patch 只会输出最后一个 hunk，前面的静默丢失。这里在每个
 *     `@@` 边界和文件结尾都落盘。
 */
export function filterPatchByHunks(
  fullPatch: string,
  hunks: HunkAssignment[],
): string {
  if (!fullPatch.trim()) return "";
  if (hunks.length === 0) return "";

  const lines = fullPatch.split("\n");
  const out: string[] = [];
  let header: string[] = [];
  let keptHunks: string[][] = [];
  let current: string[] | null = null;

  // split 在输出以换行结尾时会产生一个空的尾元素，它不是 diff 的一行。
  const closeHunk = () => {
    if (!current) return;
    if (current.length > 0 && current[current.length - 1] === "") {
      current.pop();
    }
    if (current.length > 0) keptHunks.push(current);
    current = null;
  };

  const flushFile = () => {
    if (header.length > 0 && keptHunks.length > 0) {
      out.push(...header);
      for (const h of keptHunks) out.push(...h);
    }
    header = [];
    keptHunks = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      closeHunk();
      flushFile();
      header = [line];
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      closeHunk();
      const newStart = Number.parseInt(hunkMatch[1], 10);
      const newCount = hunkMatch[2] ? Number.parseInt(hunkMatch[2], 10) : 1;
      const newEnd = newStart + Math.max(newCount - 1, 0);
      const keep = hunks.some(
        (h) => !(h.endLine < newStart || h.startLine > newEnd),
      );
      if (keep) current = [line];
      continue;
    }

    // hunk 体优先：被删除的行可能以 "-- " 开头，不能被误判成文件头。
    if (current) {
      current.push(line);
      continue;
    }

    if (isFileHeaderLine(line)) {
      header.push(line);
    }
  }

  closeHunk();
  flushFile();
  if (out.length === 0) return "";
  // 必须以换行结尾：`git apply` 会把"hunk 还没读完就到 EOF"报成
  // "corrupt patch at line N"。注意不能对整体做 trim()——hunk 体的上下文行以
  // 一个空格开头，trim 会把它连同结尾换行一起吃掉。
  return `${out.join("\n")}\n`;
}

/** `git diff` 的扩展头行：丢了会让 `git apply` 无法解析 patch。 */
function isFileHeaderLine(line: string): boolean {
  return (
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("index ") ||
    /^(old|new) mode /.test(line) ||
    /^(new file|deleted file) mode /.test(line) ||
    line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ") ||
    /^(rename|copy) (from|to) /.test(line) ||
    line.startsWith("Binary files ") ||
    line.startsWith("GIT binary patch")
  );
}
