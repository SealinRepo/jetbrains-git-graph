import type { DiffFile } from "../types";
import type { GitContext } from "./context";
import { parseDiffNameStatus } from "./parsers";

/** 获取两个引用（提交/分支/tag）之间的原始 diff 文本，可选限定单个文件。 */
export async function getDiff(
  ctx: GitContext,
  ref1: string,
  ref2: string,
  file?: string,
): Promise<string> {
  const args = ["diff", ref1, ref2];
  if (file) {
    args.push("--", file);
  }
  return ctx.execGit(args);
}

/** 获取某个引用下指定文件的文本内容（`git show ref:path`），失败时返回空字符串。 */
export async function getFileContent(
  ctx: GitContext,
  ref: string,
  filePath: string,
): Promise<string> {
  if (!ref) {
    return "";
  }
  try {
    return await ctx.execGit(["show", `${ref}:${filePath}`]);
  } catch {
    return "";
  }
}

/** 获取某个引用下指定文件的二进制内容，用于图片等非文本文件的预览。 */
export async function getFileContentBuffer(
  ctx: GitContext,
  ref: string,
  filePath: string,
): Promise<Buffer> {
  if (!ref) {
    return Buffer.alloc(0);
  }
  try {
    return await ctx.execGitBuffer(["show", `${ref}:${filePath}`]);
  } catch {
    return Buffer.alloc(0);
  }
}

/** 获取单个提交改动的文件列表（含重命名/复制识别）。 */
export async function getCommitFiles(
  ctx: GitContext,
  hash: string,
): Promise<DiffFile[]> {
  const output = await ctx.execGit([
    "diff-tree",
    "--root",
    "--no-commit-id",
    "-r",
    "--name-status",
    "-M",
    hash,
  ]);
  return parseDiffNameStatus(output);
}

/** 获取多个提交（如 cherry-pick 范围）合并后涉及的文件列表，按文件路径去重。 */
export async function getCommitRangeFiles(
  ctx: GitContext,
  hashes: string[],
): Promise<DiffFile[]> {
  if (hashes.length === 0) return [];
  if (hashes.length === 1) return getCommitFiles(ctx, hashes[0]);

  // Cherry-pick style: get diff-tree for each commit individually, then merge
  const perCommitFiles = await Promise.all(
    hashes.map((h) => getCommitFiles(ctx, h)),
  );

  const merged = new Map<string, DiffFile>();
  for (const files of perCommitFiles) {
    for (const f of files) {
      const key = f.newPath || f.oldPath;
      if (!merged.has(key)) {
        merged.set(key, f);
      }
    }
  }
  return Array.from(merged.values());
}

/** 在给定的提交列表（由新到旧）中，找出触及某个文件的最新和最早提交。 */
export async function findFileRange(
  ctx: GitContext,
  hashes: string[],
  filePath: string,
): Promise<{ oldest: string; newest: string } | null> {
  // From hashes (newest first), find commits that touch this file
  const touching: string[] = [];
  for (const h of hashes) {
    const files = await getCommitFiles(ctx, h);
    if (files.some((f) => f.newPath === filePath || f.oldPath === filePath)) {
      touching.push(h);
    }
  }
  if (touching.length === 0) return null;
  return { newest: touching[0], oldest: touching[touching.length - 1] };
}

/**
 * 获取工作区对 HEAD 的 diff 文本（覆盖未暂存 + 已暂存）。
 * 如果传 `files`，则用 `git diff HEAD -- <files...>` 把 diff 限定到选定文件；
 * 否则等价于 `git diff HEAD`。用于把改动喂给 AI 模型生成 commit message。
 */
export async function getWorkingTreeDiff(
  ctx: GitContext,
  files?: string[],
): Promise<string> {
  const args = ["diff", "HEAD"];
  if (files && files.length > 0) {
    args.push("--", ...files);
  }
  return ctx.execGit(args);
}
