import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FileStatus, WorkingTreeFile } from "../types";
import type { GitContext } from "./context";
import { parsePorcelainV1Z } from "./statusParser";

/** 获取工作区文件状态列表（`git status --porcelain=v1 -z`），含重命名识别。 */
export async function getStatus(ctx: GitContext): Promise<FileStatus[]> {
  const output = await ctx.execGit(["status", "--porcelain=v1", "-z"]);
  return parsePorcelainV1Z(output).map(
    ({ indexStatus, workTreeStatus, path, oldPath }) => ({
      path,
      ...(oldPath !== undefined ? { oldPath } : {}),
      indexStatus,
      workTreeStatus,
    }),
  );
}

/**
 * 获取提交面板所需的工作区改动列表（含未跟踪文件），归类为
 * added/modified/deleted/renamed/untracked/conflicted 等状态。不区分
 * 暂存区/工作区：一个路径无论是否被 add 过、add 了多少，只出现一条记录，
 * status 取的是 index 状态和工作区状态合并后的结果。
 */
export async function getWorkingTreeChanges(
  ctx: GitContext,
): Promise<WorkingTreeFile[]> {
  const output = await ctx.execGit(["status", "--porcelain=v1", "-z", "-uall"]);
  const files: WorkingTreeFile[] = [];

  for (const {
    indexStatus,
    workTreeStatus,
    path,
    oldPath,
  } of parsePorcelainV1Z(output)) {
    // Skip ignored files
    if (indexStatus === "!" && workTreeStatus === "!") continue;

    // Determine status
    let status: WorkingTreeFile["status"];
    if (indexStatus === "?" && workTreeStatus === "?") {
      status = "untracked";
    } else if (
      indexStatus === "U" ||
      workTreeStatus === "U" ||
      (indexStatus === "A" && workTreeStatus === "A") ||
      (indexStatus === "D" && workTreeStatus === "D")
    ) {
      status = "conflicted";
    } else if (indexStatus === "A" || workTreeStatus === "A") {
      status = "added";
    } else if (indexStatus === "D" || workTreeStatus === "D") {
      status = "deleted";
    } else if (indexStatus === "R" || workTreeStatus === "R") {
      status = "renamed";
    } else {
      status = "modified";
    }

    files.push({ path, oldPath, status });
  }
  return files;
}

/** 提交暂存区的改动，`amend` 为 true 时修补上一次提交。 */
export async function commit(
  ctx: GitContext,
  message: string,
  amend = false,
): Promise<void> {
  const args = ["commit", "-m", message];
  if (amend) args.push("--amend");
  await ctx.execGit(args);
  ctx.invalidateCache();
}

/**
 * 只提交指定路径的当前工作区内容（`amend` 为 true 时修补上一次提交），
 * 不管这些路径之前处于未暂存/已暂存/部分暂存哪种中间状态，也不管 index
 * 里还有没有别的、不在 filePaths 里的文件——那些文件不受影响、不会被
 * 一并提交。`git add` 先同步这几个路径的当前内容进 index（新文件也靠这
 * 一步被跟踪），commit 命令自己再带上同样的路径参数（pathspec），保证
 * 最终提交只包含这几个路径。
 */
export async function commitFiles(
  ctx: GitContext,
  message: string,
  filePaths: string[],
  amend = false,
): Promise<void> {
  if (filePaths.length === 0) return;
  await ctx.execGit(["add", "--", ...filePaths]);
  const args = ["commit", "-m", message];
  if (amend) args.push("--amend");
  args.push("--", ...filePaths);
  await ctx.execGit(args);
  ctx.invalidateCache();
}

/** 撤销单个文件的所有改动：HEAD 中存在则恢复为 HEAD 版本，否则视为新文件直接删除。 */
export async function rollbackFile(
  ctx: GitContext,
  filePath: string,
): Promise<void> {
  // Check if file exists in HEAD (i.e., was previously committed)
  let existsInHead = false;
  try {
    await ctx.execGit(["cat-file", "-e", `HEAD:${filePath}`]);
    existsInHead = true;
  } catch {
    existsInHead = false;
  }

  if (existsInHead) {
    // File exists in HEAD - restore to HEAD version (handles both staged and unstaged changes)
    await ctx.execGit(["checkout", "HEAD", "--", filePath]);
  } else {
    // File is new (not in HEAD) - remove from index and delete from disk
    try {
      await ctx.execGit(["rm", "-f", "--cached", "--", filePath]);
    } catch {
      // Not in index either, nothing to unstage
    }
    const fullPath = path.join(ctx.cwd, filePath);
    try {
      await fs.unlink(fullPath);
    } catch {
      // File already doesn't exist on disk
    }
  }
}
