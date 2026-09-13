import type { BranchInfo, TagInfo } from "../types";
import { FIELD_SEP, REF_FMT_FIELD_SEP } from "./constants";
import type { GitContext } from "./context";
import { parseTrack } from "./parsers";

/** 获取本地和远程分支列表（含当前分支、上游追踪、ahead/behind 信息），结果带缓存。 */
export async function getBranches(ctx: GitContext): Promise<BranchInfo[]> {
  const cacheKey = "branches";
  const cached = ctx.cache.get<BranchInfo[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const localFormat = [
    "%(refname:short)",
    "%(HEAD)",
    "%(upstream:short)",
    "%(upstream:track,nobracket)",
    "%(objectname:short)",
  ].join(REF_FMT_FIELD_SEP);

  const localOutput = await ctx.execGit(["branch", `--format=${localFormat}`]);

  // %(symref) is non-empty only for symbolic refs like refs/remotes/<remote>/HEAD
  // (which %(refname:short) shortens down to just "<remote>", not "<remote>/HEAD"),
  // so checking it directly is the reliable way to exclude those pointer entries.
  const remoteFormat = `${localFormat}${REF_FMT_FIELD_SEP}%(symref)`;

  const remoteOutput = await ctx
    .execGit(["branch", "-r", `--format=${remoteFormat}`])
    .catch(() => "");

  const branches: BranchInfo[] = [];

  for (const line of localOutput.trim().split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const fields = line.split(FIELD_SEP);
    const name = fields[0]?.trim() ?? "";
    const isCurrent = fields[1]?.trim() === "*";
    const upstream = fields[2]?.trim() || undefined;
    const track = fields[3]?.trim() ?? "";
    const lastCommitHash = fields[4]?.trim() ?? "";

    const { ahead, behind } = parseTrack(track);

    branches.push({
      name,
      isRemote: false,
      isCurrent,
      upstream,
      ahead,
      behind,
      lastCommitHash,
    });
  }

  for (const line of remoteOutput.trim().split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const fields = line.split(FIELD_SEP);
    const name = fields[0]?.trim() ?? "";
    const lastCommitHash = fields[4]?.trim() ?? "";
    const symref = fields[5]?.trim() ?? "";

    // Skip symbolic refs like origin/HEAD -> origin/main
    if (symref) {
      continue;
    }

    branches.push({
      name,
      isRemote: true,
      isCurrent: false,
      ahead: 0,
      behind: 0,
      lastCommitHash,
    });
  }

  ctx.cache.set(cacheKey, branches);
  return branches;
}

/** 按远程仓库分组获取远程分支列表，只保留仍然配置着的远程（即使该远程还没有追踪分支）。 */
export async function getRemoteBranches(
  ctx: GitContext,
): Promise<{ remote: string; branches: string[] }[]> {
  // Get the actual configured remotes (not inferred from tracking branches)
  const remoteOutput = await ctx.execGit(["remote"]).catch(() => "");
  const configuredRemotes = new Set(
    remoteOutput
      .trim()
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean),
  );

  if (configuredRemotes.size === 0) {
    return [];
  }

  const allBranches = await getBranches(ctx);
  const remoteBranches = allBranches.filter((b) => b.isRemote);

  const groups = new Map<string, string[]>();
  for (const branch of remoteBranches) {
    const slashIdx = branch.name.indexOf("/");
    if (slashIdx === -1) continue;
    const remote = branch.name.substring(0, slashIdx);
    // Only include branches for remotes that still exist
    if (!configuredRemotes.has(remote)) continue;
    const branchName = branch.name.substring(slashIdx + 1);
    if (!groups.has(remote)) {
      groups.set(remote, []);
    }
    groups.get(remote)?.push(branchName);
  }

  // Ensure all configured remotes appear even if they have no tracking branches yet
  for (const remote of configuredRemotes) {
    if (!groups.has(remote)) {
      groups.set(remote, []);
    }
  }

  // Sort branches alphabetically within each group (case-insensitive)
  const result: { remote: string; branches: string[] }[] = [];
  for (const [remote, branchList] of groups) {
    branchList.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    result.push({ remote, branches: branchList });
  }

  return result;
}

/** 获取标签列表（含轻量/附注类型、附注信息），结果带缓存。 */
export async function getTags(ctx: GitContext): Promise<TagInfo[]> {
  const cacheKey = "tags";
  const cached = ctx.cache.get<TagInfo[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const tagFormat = [
    "%(refname:short)",
    "%(objectname:short)",
    "%(objecttype)",
    "%(contents:subject)",
  ].join(REF_FMT_FIELD_SEP);

  const output = await ctx
    .execGit(["tag", "-l", `--format=${tagFormat}`])
    .catch(() => "");

  const tags: TagInfo[] = [];
  for (const line of output.trim().split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const fields = line.split(FIELD_SEP);
    tags.push({
      name: fields[0]?.trim() ?? "",
      hash: fields[1]?.trim() ?? "",
      isAnnotated: fields[2]?.trim() === "tag",
      message: fields[3]?.trim() || undefined,
    });
  }

  ctx.cache.set(cacheKey, tags);
  return tags;
}

/** 切换到指定分支（`git checkout`）。 */
export async function checkout(
  ctx: GitContext,
  branchName: string,
): Promise<void> {
  await ctx.execGit(["checkout", branchName]);
  ctx.invalidateCache();
}

/** 基于起点创建新分支，`force` 为 true 时覆盖同名分支。 */
export async function createBranch(
  ctx: GitContext,
  newBranchName: string,
  startPoint: string,
  force = false,
): Promise<void> {
  const args = force
    ? ["branch", "-f", newBranchName, startPoint]
    : ["branch", newBranchName, startPoint];
  await ctx.execGit(args);
  ctx.invalidateCache();
}

/** 删除本地分支，`force` 为 true 时使用 `-D` 强制删除未合并分支。 */
export async function deleteBranch(
  ctx: GitContext,
  branchName: string,
  force = false,
): Promise<void> {
  const flag = force ? "-D" : "-d";
  await ctx.execGit(["branch", flag, branchName]);
  ctx.invalidateCache();
}

/** 删除远程分支（如 `origin/feature`），通过 `git push --delete` 实现。 */
export async function deleteRemoteBranch(
  ctx: GitContext,
  remoteBranch: string,
): Promise<void> {
  // remoteBranch is like "origin/feature" → push --delete origin feature
  const slashIdx = remoteBranch.indexOf("/");
  const remote = remoteBranch.substring(0, slashIdx);
  const branch = remoteBranch.substring(slashIdx + 1);
  await ctx.execGit(["push", remote, "--delete", branch]);
  ctx.invalidateCache();
}

/** 重命名本地分支。 */
export async function renameBranch(
  ctx: GitContext,
  oldName: string,
  newName: string,
): Promise<void> {
  await ctx.execGit(["branch", "-m", oldName, newName]);
  ctx.invalidateCache();
}

/** 从指定提交创建新分支（用于 Graph 面板右键"从此提交创建分支"）。 */
export async function createBranchFromCommit(
  ctx: GitContext,
  branchName: string,
  hash: string,
  force = false,
): Promise<void> {
  const args = force
    ? ["branch", "-f", branchName, hash]
    : ["branch", branchName, hash];
  await ctx.execGit(args);
  ctx.invalidateCache();
}

/** 在指定提交上创建标签，`message` 存在时创建附注标签，否则创建轻量标签。 */
export async function createTag(
  ctx: GitContext,
  tagName: string,
  hash: string,
  message?: string,
): Promise<void> {
  if (message) {
    await ctx.execGit(["tag", "-a", tagName, hash, "-m", message]);
  } else {
    await ctx.execGit(["tag", tagName, hash]);
  }
  ctx.invalidateCache();
}

/** 获取当前检出的分支名，处于 detached HEAD 状态时返回 null。 */
export async function getCurrentBranch(
  ctx: GitContext,
): Promise<string | null> {
  try {
    const output = await ctx.execGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = output.trim();
    return branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

/**
 * 读取分支已配置的上游，未配置时返回 null。
 *
 * 用 `%(upstream)` 而不是 `rev-parse <branch>@{upstream}`：远程分支被删除、本地远程跟踪
 * ref 被 prune 之后，`rev-parse` 会失败，但 `branch.<name>.remote/merge` 配置其实还在，
 * 按"无上游"处理会导致下次推送把跟踪关系改掉。也不直接读 `branch.<name>.merge` 配置：
 * 只有 remote/merge 两项都在 git 才认作上游，单读一项会误判半截配置。
 */
export async function getUpstream(
  ctx: GitContext,
  branch: string,
): Promise<{ ref: string; remote: string } | null> {
  const format = ["%(upstream:short)", "%(upstream:remotename)"].join(
    REF_FMT_FIELD_SEP,
  );
  const output = await ctx.execGit([
    "for-each-ref",
    `--format=${format}`,
    `refs/heads/${branch}`,
  ]);
  const [ref, remote] = output.trim().split(FIELD_SEP);
  return ref && remote ? { ref, remote } : null;
}

/**
 * 获取当前分支的默认远程仓库名。
 * 优先取上游追踪的远程，取不到时回退到第一个已配置的远程（优先 origin）。
 */
export async function getDefaultRemote(
  ctx: GitContext,
  branch?: string,
): Promise<string> {
  // Try to get the upstream remote for the given branch
  if (branch) {
    const upstream = await getUpstream(ctx, branch);
    if (upstream) return upstream.remote;
  }

  // Fall back to first configured remote
  try {
    const output = await ctx.execGit(["remote"]);
    const remotes = output
      .trim()
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
    if (remotes.length > 0) {
      // Prefer "origin" if it exists, otherwise first remote
      return remotes.includes("origin") ? "origin" : remotes[0];
    }
  } catch {
    // ignore
  }

  return "origin";
}
