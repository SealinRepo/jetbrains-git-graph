import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CherryPickState, MergeState } from "../types";
import type { GitContext } from "./context";
import { getFileContent } from "./diff";
import { getCommitParents } from "./log";

/** 读取 `.git/MERGE_HEAD`、`.git/MERGE_MSG`，判断当前是否处于合并中状态。 */
export async function getMergeState(ctx: GitContext): Promise<MergeState> {
  try {
    const mergeHead = (
      await fs.readFile(path.join(ctx.cwd, ".git", "MERGE_HEAD"), "utf-8")
    ).trim();
    let mergeMsg = "";
    try {
      mergeMsg = (
        await fs.readFile(path.join(ctx.cwd, ".git", "MERGE_MSG"), "utf-8")
      ).trim();
    } catch {}
    return { isMerging: true, mergeHead, mergeMsg };
  } catch {
    return { isMerging: false };
  }
}

/** 读取 `.git/CHERRY_PICK_HEAD`，判断当前是否处于 cherry-pick 中状态。 */
export async function getCherryPickState(
  ctx: GitContext,
): Promise<CherryPickState> {
  try {
    const cherryPickHead = (
      await fs.readFile(path.join(ctx.cwd, ".git", "CHERRY_PICK_HEAD"), "utf-8")
    ).trim();
    return { isCherryPicking: true, cherryPickHead };
  } catch {
    return { isCherryPicking: false };
  }
}

/** 继续/跳过/中止当前的 cherry-pick；continue 时会先暂存已解决的冲突文件。 */
export async function cherryPickAction(
  ctx: GitContext,
  action: "continue" | "abort" | "skip",
): Promise<void> {
  if (action === "continue") {
    // Stage all resolved files before continuing (like IntelliJ IDEA behavior)
    await ctx.execGit(["add", "-u"]);
    // Use --allow-empty to handle the case where cherry-pick becomes empty after conflict resolution
    try {
      await ctx.execGit(["cherry-pick", "--continue"]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("allow-empty")) {
        await ctx.execGit(["commit", "--allow-empty"]);
      } else {
        throw err;
      }
    }
  } else if (action === "skip") {
    await ctx.execGit(["cherry-pick", "--skip"]);
  } else {
    await ctx.execGit(["cherry-pick", "--abort"]);
  }
  ctx.invalidateCache();
}

/** 读取 `.git/rebase-merge` 或 `.git/rebase-apply` 目录，获取当前 rebase 的进度信息。 */
export async function getRebaseState(ctx: GitContext): Promise<{
  isRebasing: boolean;
  branchName?: string;
  step?: number;
  totalSteps?: number;
}> {
  const rebaseMergePath = path.join(ctx.cwd, ".git", "rebase-merge");
  const rebaseApplyPath = path.join(ctx.cwd, ".git", "rebase-apply");
  try {
    await fs.access(rebaseMergePath);
    let branchName = "";
    let step = 0;
    let totalSteps = 0;
    try {
      const headName = await fs.readFile(
        path.join(rebaseMergePath, "head-name"),
        "utf-8",
      );
      branchName = headName.trim().replace("refs/heads/", "");
    } catch {}
    try {
      const msgnum = await fs.readFile(
        path.join(rebaseMergePath, "msgnum"),
        "utf-8",
      );
      step = Number.parseInt(msgnum.trim(), 10);
    } catch {}
    try {
      const end = await fs.readFile(path.join(rebaseMergePath, "end"), "utf-8");
      totalSteps = Number.parseInt(end.trim(), 10);
    } catch {}
    return { isRebasing: true, branchName, step, totalSteps };
  } catch {}
  try {
    await fs.access(rebaseApplyPath);
    let branchName = "";
    let step = 0;
    let totalSteps = 0;
    try {
      const headName = await fs.readFile(
        path.join(rebaseApplyPath, "head-name"),
        "utf-8",
      );
      branchName = headName.trim().replace("refs/heads/", "");
    } catch {}
    try {
      const next = await fs.readFile(
        path.join(rebaseApplyPath, "next"),
        "utf-8",
      );
      step = Number.parseInt(next.trim(), 10);
    } catch {}
    try {
      const last = await fs.readFile(
        path.join(rebaseApplyPath, "last"),
        "utf-8",
      );
      totalSteps = Number.parseInt(last.trim(), 10);
    } catch {}
    return { isRebasing: true, branchName, step, totalSteps };
  } catch {}
  return { isRebasing: false };
}

/** 获取当前存在冲突（unmerged）的文件路径列表。 */
export async function getConflictFiles(ctx: GitContext): Promise<string[]> {
  const output = await ctx.execGit(["diff", "--name-only", "--diff-filter=U"]);
  return output
    .trim()
    .split("\n")
    .filter((s) => s.length > 0);
}

/** 获取冲突文件的三方版本内容（base/ours/theirs），供三方合并编辑器展示。 */
export async function getFileVersions(
  ctx: GitContext,
  filePath: string,
): Promise<{ base: string; ours: string; theirs: string }> {
  const [base, ours, theirs] = await Promise.all([
    getFileContent(ctx, ":1", filePath),
    getFileContent(ctx, ":2", filePath),
    getFileContent(ctx, ":3", filePath),
  ]);
  return { base, ours, theirs };
}

/** 将三方合并编辑器产出的最终内容写回工作区文件。 */
export async function saveMergedContent(
  ctx: GitContext,
  filePath: string,
  content: string,
): Promise<void> {
  await fs.writeFile(path.join(ctx.cwd, filePath), content, "utf-8");
}

/** 将单个文件加入暂存区（用于冲突解决后标记为已处理）。 */
export async function stageFile(
  ctx: GitContext,
  filePath: string,
  force = false,
): Promise<void> {
  await ctx.execGit(force ? ["add", "-f", filePath] : ["add", filePath]);
}

/** 冲突解决：采用"我方"（ours）版本并暂存。 */
export async function acceptOurs(
  ctx: GitContext,
  filePath: string,
): Promise<void> {
  await ctx.execGit(["checkout", "--ours", filePath]);
  await ctx.execGit(["add", filePath]);
}

/** 冲突解决：采用"对方"（theirs）版本并暂存。 */
export async function acceptTheirs(
  ctx: GitContext,
  filePath: string,
): Promise<void> {
  await ctx.execGit(["checkout", "--theirs", filePath]);
  await ctx.execGit(["add", filePath]);
}

/** 将指定分支合并到当前分支。 */
export async function merge(
  ctx: GitContext,
  branchName: string,
): Promise<void> {
  await ctx.execGit(["merge", branchName]);
  ctx.invalidateCache();
}

/**
 * 将当前分支 rebase 到指定目标之上。
 * 带 `--autostash`：工作区有未提交改动时自动 stash，rebase 成功后自动还原；
 * `git rebase --autostash` 自 Git 2.6（2015）起就支持，不存在版本兼容问题
 * （不同于 `merge --autostash` 需要 Git 2.27，见 updateBranch）。
 */
export async function rebase(ctx: GitContext, onto: string): Promise<void> {
  await ctx.execGit(["rebase", "--autostash", onto]);
  ctx.invalidateCache();
}

/** 继续/跳过/中止当前的 rebase；continue 时会先暂存已解决的冲突文件。 */
export async function rebaseAction(
  ctx: GitContext,
  action: "continue" | "abort" | "skip",
): Promise<void> {
  if (action === "continue") {
    // Stage all resolved files before continuing
    await ctx.execGit(["add", "-u"]);
  }
  await ctx.execGit(["rebase", `--${action}`]);
  ctx.invalidateCache();
}

/** 中止当前合并，回到合并前的状态。 */
export async function mergeAbort(ctx: GitContext): Promise<void> {
  await ctx.execGit(["merge", "--abort"]);
  ctx.invalidateCache();
}

/** 冲突全部解决后完成合并提交（暂存已解决文件 + `commit --no-edit`）。 */
export async function mergeContinue(ctx: GitContext): Promise<void> {
  // Stage all resolved files before committing
  await ctx.execGit(["add", "-u"]);
  await ctx.execGit(["commit", "--no-edit"]);
  ctx.invalidateCache();
}

/** 切换到目标分支后立即对其执行 rebase（如"检出并变基"操作）。 */
export async function checkoutAndRebase(
  ctx: GitContext,
  branchToCheckout: string,
  rebaseOnto: string,
): Promise<void> {
  await ctx.execGit(["checkout", branchToCheckout]);
  await ctx.execGit(["rebase", "--autostash", rebaseOnto]);
  ctx.invalidateCache();
}

/** 将指定提交 cherry-pick 到当前分支。 */
export async function cherryPick(ctx: GitContext, hash: string): Promise<void> {
  await ctx.execGit(["cherry-pick", hash]);
  ctx.invalidateCache();
}

/** 检出指定提交（进入 detached HEAD 状态）。 */
export async function checkoutCommit(
  ctx: GitContext,
  hash: string,
): Promise<void> {
  await ctx.execGit(["checkout", hash]);
  ctx.invalidateCache();
}

/** 将指定文件恢复为某个提交中的版本（`git checkout <hash> -- <file>`）。 */
export async function checkoutFileFromCommit(
  ctx: GitContext,
  hash: string,
  filePath: string,
): Promise<void> {
  await ctx.execGit(["checkout", hash, "--", filePath]);
  ctx.invalidateCache();
}

/** 撤销某个提交对单个文件的改动，恢复为其父提交中的状态（新增文件则删除）。 */
export async function checkoutFileFromParent(
  ctx: GitContext,
  hash: string,
  filePath: string,
  status?: string,
): Promise<void> {
  if (status === "added") {
    // File was newly added in this commit, revert means removing it
    // Use --cached to handle case where file may not exist on disk
    try {
      await ctx.execGit(["rm", "-f", "--", filePath]);
    } catch {
      // File might not exist in working tree or index, try removing from index only
      try {
        await ctx.execGit(["rm", "-f", "--cached", "--", filePath]);
      } catch {
        // File doesn't exist at all - nothing to revert
      }
      // Also try to remove the physical file if it exists
      try {
        await fs.unlink(path.join(ctx.cwd, filePath));
      } catch {
        // File already doesn't exist on disk
      }
    }
  } else if (status === "deleted") {
    // File was deleted in this commit, revert means restoring it from parent
    await ctx.execGit(["checkout", `${hash}~1`, "--", filePath]);
  } else {
    // File was modified/renamed/copied, revert to parent state
    await ctx.execGit(["checkout", `${hash}~1`, "--", filePath]);
  }
  ctx.invalidateCache();
}

/** 将当前分支重置到指定提交，`mode` 对应 `--soft`/`--mixed`/`--hard`。 */
export async function resetToCommit(
  ctx: GitContext,
  hash: string,
  mode: "soft" | "mixed" | "hard",
): Promise<void> {
  await ctx.execGit(["reset", `--${mode}`, hash]);
  ctx.invalidateCache();
}

/** 生成一个撤销指定提交改动的新提交（`git revert`）。 */
export async function revertCommit(
  ctx: GitContext,
  hash: string,
): Promise<void> {
  await ctx.execGit(["revert", "--no-edit", hash]);
  ctx.invalidateCache();
}

/** 从历史中彻底删除指定提交：HEAD 提交走 reset，非 HEAD 提交走 rebase --onto。 */
export async function dropCommit(ctx: GitContext, hash: string): Promise<void> {
  const headHash = (await ctx.execGit(["rev-parse", "HEAD"])).trim();
  const isHead = hash === headHash;

  if (isHead) {
    await dropHeadCommit(ctx, hash);
  } else {
    await dropNonHeadCommit(ctx, hash);
  }
  ctx.invalidateCache();
}

/** 删除 HEAD 提交：`reset --mixed HEAD~1`，改动回退到工作区。 */
async function dropHeadCommit(ctx: GitContext, hash: string): Promise<void> {
  // Verify commit has a parent
  const parents = await getCommitParents(ctx, hash);
  if (parents.length === 0) {
    throw new Error("Cannot drop the initial commit (no parent)");
  }
  await ctx.execGit(["reset", "--mixed", "HEAD~1"]);
}

/**
 * 删除非 HEAD 提交：先记录该提交的 diff，再用 `rebase --onto` 将其从历史中摘除，
 * 失败时中止 rebase 并还原现场，成功后把摘除提交的改动重新应用到工作区。
 */
async function dropNonHeadCommit(ctx: GitContext, hash: string): Promise<void> {
  // 1. Capture the target commit's diff BEFORE rebase
  const diff = await ctx.execGit(["diff-tree", "-p", hash]);

  // 2. Check working directory status
  const status = await ctx.execGit(["status", "--porcelain"]);
  const isDirty = status.trim().length > 0;

  // 3. Stash if dirty
  if (isDirty) {
    await ctx.execGit(["stash", "push", "-u", "-m", "drop-commit-autostash"]);
  }

  // 4. Execute rebase to remove the commit
  try {
    await ctx.execGit(["rebase", "--onto", `${hash}^`, hash]);
  } catch (rebaseErr) {
    // Abort rebase on failure
    try {
      await ctx.execGit(["rebase", "--abort"]);
    } catch {
      // ignore abort errors
    }

    // Restore stash if it was used
    if (isDirty) {
      try {
        await ctx.execGit(["stash", "pop"]);
      } catch {
        // stash pop failure is secondary
      }
    }

    throw rebaseErr;
  }

  // 5. Restore stashed changes on success
  if (isDirty) {
    await ctx.execGit(["stash", "pop"]);
  }

  // 6. Apply dropped commit's diff to working directory via temp file
  if (diff.trim()) {
    const tmpFile = path.join(os.tmpdir(), `drop-commit-${hash}.patch`);
    try {
      await fs.writeFile(tmpFile, diff, "utf-8");
      await ctx.execGit(["apply", "--3way", tmpFile]);
    } catch {
      throw new Error(
        "Commit was removed from history but its changes could not be applied to the working directory",
      );
    } finally {
      try {
        await fs.unlink(tmpFile);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
