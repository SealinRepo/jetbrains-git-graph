import type { CommitNode } from "../types";
import { getDefaultRemote, getUpstream } from "./branches";
import { FMT_RECORD_SEP, LOG_FORMAT } from "./constants";
import type { GitContext } from "./context";
import { BranchDivergedError } from "./errors";
import { parseLogOutput } from "./parsers";

/**
 * 将本地分支推送到远程，`force`, 为 true 时使用 `--force-with-lease`。
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
 * - 未在任何 worktree 检出的分支：通过 fetch 仅做 fast-forward。
 * - 已检出的分支：在对应 worktree 中按策略与上游同步，避免 fetch 直接改写检出中的分支。
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

  const worktrees = await ctx.execGit(["worktree", "list", "--porcelain"]);
  const branchWorktree = worktrees
    .split(/\r?\n\r?\n/)
    .find((worktree) =>
      worktree.split(/\r?\n/).includes(`branch refs/heads/${branchName}`),
    );
  const worktreePath = branchWorktree
    ?.split(/\r?\n/)
    .find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length);

  const runInWorktree = (args: string[]) =>
    ctx.execGit(worktreePath ? ["-C", worktreePath, ...args] : args);

  if (worktreePath) {
    await ctx.execGit([
      "fetch",
      remote,
      `refs/heads/${remoteBranch}:refs/remotes/${remote}/${remoteBranch}`,
    ]);
  } else {
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
  }
  ctx.invalidateCache();

  if (worktreePath) {
    if (strategy === "merge") {
      await runInWorktree([
        "merge",
        "--autostash",
        "--no-edit",
        `${remote}/${remoteBranch}`,
      ]);
    } else if (strategy === "rebase") {
      await runInWorktree([
        "rebase",
        "--autostash",
        `${remote}/${remoteBranch}`,
      ]);
    } else {
      try {
        await runInWorktree([
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
  }
}

/**
 * 拉取所有远程的更新并清理已失效的远程分支引用。
 *
 * 与原 `fetch --all --prune` 不同，本实现先枚举所有 remote、再对每个 remote
 * 单独起 `git fetch <remote> --prune` 并发跑（`Promise.allSettled`）。一个
 * 远程卡死 / SSH agent 僵死 / 局域网瞬时丢包时，不会拖累其他远程的拉取；
 * 同时每个子进程都受 `GitService` 的 timeout 保护（参见 `gitService.ts`
 * `spawnGit`），卡死的远程会在 120s 后被强杀而不是永远挂着。
 */
export async function fetch(ctx: GitContext): Promise<void> {
  const remotesRaw = await ctx.execGit(["remote"]);
  const remotes = remotesRaw
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter(Boolean);

  if (remotes.length === 0) {
    ctx.invalidateCache();
    return;
  }

  // 并行拉取每个 remote；allSettled 让单个失败不阻塞其它 remote 的成功。
  const results = await Promise.allSettled(
    remotes.map((remote) => ctx.execGit(["fetch", remote, "--prune"])),
  );

  ctx.invalidateCache();

  // 模拟原 `fetch --all --prune` 的容错：所有 remote 都失败才抛错（用户能在
  // toast 看到原因）；部分失败时，每个 ctx.execGit 已经把 stderr 写到 Git Graph
  // 输出通道，保持原有"静默但可见"的体验。
  if (results.some((r) => r.status === "fulfilled")) return;

  const detail = results
    .map((r, i) => {
      if (r.status !== "rejected") return null;
      const reason = r.reason;
      const text = reason instanceof Error ? reason.message : String(reason);
      return `${remotes[i]}: ${text}`;
    })
    .filter((s): s is string => s !== null)
    .join("\n");
  throw new Error(`All remotes failed to fetch:\n${detail}`);
}
