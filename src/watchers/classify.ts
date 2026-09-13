import { GitDomain as D, type GitDomain } from "../state/domains";

// 预先建好，避免每个文件事件都分配一次数组
const NONE: readonly GitDomain[] = [];
const WORKTREE: readonly GitDomain[] = [D.Worktree];
const REFS: readonly GitDomain[] = [D.Refs];
const REFS_WORKTREE: readonly GitDomain[] = [D.Refs, D.Worktree];
const STASH_WORKTREE: readonly GitDomain[] = [D.Stash, D.Worktree];
const OP_WORKTREE: readonly GitDomain[] = [D.Operation, D.Worktree];
const OP_REFS_WORKTREE: readonly GitDomain[] = [
  D.Operation,
  D.Refs,
  D.Worktree,
];

/**
 * 把 .git 目录内的一个相对路径映射到受影响的域。返回空数组表示这个事件该丢弃。
 *
 * 之所以做成不依赖 vscode 的纯函数：这张表是整个 watcher 里变化最频繁的部分
 * （每发现一个没覆盖到的 git 文件就要加一行），单独拎出来才好改、好测。
 *
 * @param relPath 相对 .git 目录的路径，`/` 分隔（传 uri.path 的后半段，
 *                不要传 fsPath——Windows 上那个是反斜杠）
 */
export function classifyGitPath(relPath: string): readonly GitDomain[] {
  // 先挡噪声。objects/ 在 fetch 时能刷出成千上万个事件，而这个 watcher 是
  // 绕开 files.watcherExclude 建的，默认那条 **/.git/objects/** 排除保护不到它。
  if (
    relPath.startsWith("objects/") ||
    relPath.startsWith("lfs/") ||
    relPath.startsWith("hooks/") ||
    relPath.startsWith("info/") ||
    // index.lock 等：每次 git 操作都会建了又删
    relPath.endsWith(".lock")
  ) {
    return NONE;
  }

  // stash 与它的 reflog。必须排在下面的 refs/ 和 logs/ 前缀判断之前
  if (relPath === "refs/stash" || relPath === "logs/refs/stash") {
    return STASH_WORKTREE;
  }

  // 进行中的操作
  if (
    relPath === "MERGE_HEAD" ||
    relPath === "MERGE_MSG" ||
    relPath === "CHERRY_PICK_HEAD" ||
    relPath === "REVERT_HEAD"
  ) {
    return OP_WORKTREE;
  }
  // rebase 三个域都动：它会一边搬 ref 一边改工作区
  if (
    relPath === "REBASE_HEAD" ||
    relPath.startsWith("rebase-merge/") ||
    relPath.startsWith("rebase-apply/")
  ) {
    return OP_REFS_WORKTREE;
  }

  // 暂存区。只算 worktree，理由见 GitDomain 上的边界说明（避免 status 回写
  // index 触发重拉、重拉又跑 status 的回路）
  if (relPath === "index") {
    return WORKTREE;
  }

  // 切分支会同时改 ref 和工作区文件；COMMIT_EDITMSG 意味着刚产生了一个提交
  if (relPath === "HEAD" || relPath === "COMMIT_EDITMSG") {
    return REFS_WORKTREE;
  }

  if (
    // packed-refs 容易被忘：git gc / pack-refs 之后 ref 就从 refs/* 搬进这里了，
    // 此后对已打包 ref 的更新只写这个文件
    relPath === "packed-refs" ||
    relPath === "FETCH_HEAD" ||
    relPath === "ORIG_HEAD" ||
    // remote 增删、upstream 跟踪关系的变化都写在 config 里
    relPath === "config" ||
    relPath.startsWith("refs/") ||
    relPath.startsWith("logs/")
  ) {
    return REFS;
  }

  // worktree / submodule
  if (relPath.startsWith("worktrees/") || relPath.startsWith("modules/")) {
    return REFS_WORKTREE;
  }

  // 没见过的文件：宁可多刷一次也别漏——上面已经把真正的噪声大头挡掉了，
  // 剩下的未知文件都是低频的。
  return REFS_WORKTREE;
}

/**
 * 判断一个路径是否落在某个 .git 目录内部。
 *
 * 工作区 watcher 用它把 .git 内的事件让给专门的 .git watcher，避免同一次变化
 * 被两边各记一次。
 *
 * @param posixPath `/` 分隔的路径（uri.path）
 */
export function isInsideGitDir(posixPath: string): boolean {
  return posixPath.includes("/.git/") || posixPath.endsWith("/.git");
}
