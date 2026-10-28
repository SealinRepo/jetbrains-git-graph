// 解决行尾编译错误字符
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

async function getUntrackedFileDiff(
  ctx: GitContext,
  filePath: string,
): Promise<string> {
  try {
    return await ctx.execGit([
      "diff",
      "--no-index",
      "--",
      "/dev/null",
      filePath,
    ]);
  } catch (error) {
    const result = error as {
      code?: number | string;
      stdout?: string | Buffer;
    };
    if (result.code === 1 || result.code === "1") {
      return result.stdout?.toString() ?? "";
    }
    throw error;
  }
}

/**
 * 获取工作区改动 diff（覆盖未暂存、已暂存和未跟踪文件）。
 * 在尚无首个提交时，分别比较 index、工作区和空文件，避免引用不存在的 HEAD。
 */
export async function getWorkingTreeDiff(
  ctx: GitContext,
  files?: string[],
): Promise<string> {
  const fileArgs = files && files.length > 0 ? ["--", ...files] : [];
  let hasHead = true;
  try {
    await ctx.execGit(["rev-parse", "--verify", "HEAD"]);
  } catch {
    hasHead = false;
  }

  const diffs = hasHead
    ? [await ctx.execGit(["diff", "HEAD", ...fileArgs])]
    : [
        await ctx.execGit(["diff", "--cached", ...fileArgs]),
        await ctx.execGit(["diff", ...fileArgs]),
      ];

  const untrackedOutput = await ctx.execGit([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const requestedFiles = files && files.length > 0 ? new Set(files) : undefined;
  const untrackedFiles = untrackedOutput
    .split("\0")
    .filter(
      (filePath) =>
        filePath && (!requestedFiles || requestedFiles.has(filePath)),
    );

  for (const filePath of untrackedFiles) {
    diffs.push(await getUntrackedFileDiff(ctx, filePath));
  }

  return diffs.filter(Boolean).join("\n");
}
