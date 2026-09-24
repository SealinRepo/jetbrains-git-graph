import type { CommitNode } from "../types";
import { getCurrentBranch, getDefaultRemote, getUpstream } from "./branches";
import { FMT_RECORD_SEP, LOG_FORMAT } from "./constants";
import type { GitContext } from "./context";
import { BranchDivergedError } from "./errors";
import { parseLogOutput } from "./parsers";

/**
 * 将本地分支推送到远程，`force` 为 true 时使用 `--force-with-lease`。
 * 仅在分支尚未配置 upstream 时补 `--set-upstream`，让首次推送的新分支建立跟踪关系；
 * 已有 upstream 的分支保持原配置，避免推送到别的目标分支时静默改掉已有跟踪关系。
 */
export async function push(
  ctx: GitContext,
  branchName: string,
  force = false,
  remote = "origin",
  targetBranch?: string,
): Promise<string> {
  const args = ["push"];
  if (!(await getUpstream(ctx, branchName))) args.push("--set-upstream");
  if (force) args.push("--force-with-lease");
  args.push(remote, `${branchName}:${targetBranch || branchName}`);
  const output = await ctx.execGit(args);
  ctx.invalidateCache();
  return output;
}

/**
 * 获取领先于远程追踪分支的提交列表（按由新到旧排序）。
 * 若尚未设置上游，则认为本地全部提交都是"领先"的。
 */
export async function getAheadCommits(
  ctx: GitContext,
  branchName: string,
  remote?: string,
): Promise<CommitNode[]> {
  const remoteName = remote || (await getDefaultRemote(ctx, branchName));
  const upstream = `${remoteName}/${branchName}`;
  // Check if upstream exists
  try {
    await ctx.execGit(["rev-parse", "--verify", upstream]);
  } catch {
    // No upstream — all local commits are "ahead"
    const args = [
      "log",
      `--format=${LOG_FORMAT}${FMT_RECORD_SEP}`,
      branchName,
      "--max-count=50",
    ];
    const output = await ctx.execGit(args);
    return parseLogOutput(output);
  }
  const args = [
    "log",
    `--format=${LOG_FORMAT}${FMT_RECORD_SEP}`,
    `${upstream}..${branchName}`,
  ];
  const output = await ctx.execGit(args);
  return parseLogOutput(output);
}

/**
 * 从上游更新本地分支。
 *
 * - 非当前检出分支：仅做 fast-forward（`git fetch <remote> <remoteBranch>:<branch>`），
 *   不会触碰工作区或当前检出分支；无法快进时抛出错误。
 * - 当前检出分支且未指定策略：先尝试 fast-forward 合并；不行的话抛出 BranchDivergedError，
 *   由调用方询问用户选择策略后再次调用。
 * - 当前检出分支且指定了策略：按 `merge` 或 `rebase` 策略与上游同步。
 */
export async function updateBranch(
  ctx: GitContext,
  branchName: string,
  strategy?: "merge" | "rebase",
): Promise<void> {
  const isLocalBranch = await ctx
    .execGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`])
    .then(() => true)
    .catch(() => false);
  if (!isLocalBranch) {
    throw new Error(`"${branchName}" is not a local branch`);
  }

  let upstream: string;
  try {
    upstream = (
      await ctx.execGit([
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        `${branchName}@{upstream}`,
      ])
    ).trim();
  } catch {
    throw new Error(`Branch "${branchName}" has no upstream configured`);
  }
  const slashIdx = upstream.indexOf("/");
  const remote = upstream.substring(0, slashIdx);
  const remoteBranch = upstream.substring(slashIdx + 1);

  const currentBranch = await getCurrentBranch(ctx);
  const isCurrent = branchName === currentBranch;

  try {
    await ctx.execGit(["fetch", remote, `${remoteBranch}:${branchName}`]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("non-fast-forward")) {
      throw new Error(
        `Branch "${branchName}" has diverged from ${remote}/${remoteBranch}. Check it out to resolve manually.`,
      );
    }
    throw err;
  }
  ctx.invalidateCache();

  // 当前分支才执行合并/变基；非当前分支只更新远程引用（已通过 fetch 完成）
  if (isCurrent) {
    // Checked-out branch: refresh the remote-tracking ref first.
    await ctx.execGit(["fetch", remote, remoteBranch]);

    if (strategy === "merge") {
      await ctx.execGit([
        "merge",
        "--autostash",
        "--no-edit",
        `${remote}/${remoteBranch}`,
      ]);
    } else if (strategy === "rebase") {
      await ctx.execGit(["rebase", "--autostash", `${remote}/${remoteBranch}`]);
    } else {
      try {
        await ctx.execGit([
          "merge",
          "--ff-only",
          "--autostash",
          `${remote}/${remoteBranch}`,
        ]);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("Not possible to fast-forward")) {
          throw new BranchDivergedError(branchName, remote, remoteBranch);
        }
        throw err;
      }
    }
    ctx.invalidateCache();
  } else {
    // 非当前分支：只通过 fetch 更新远程引用（已在上面执行），不做合并/变基
    ctx.invalidateCache();
  }
}

/** 拉取所有远程的更新并清理已失效的远程分支引用（`fetch --all --prune`）。 */
export async function fetch(ctx: GitContext): Promise<void> {
  await ctx.execGit(["fetch", "--all", "--prune"]);
  ctx.invalidateCache();
}
