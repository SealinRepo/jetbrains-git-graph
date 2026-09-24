import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitCache } from "./cache";
import * as branchOps from "./gitService/branches";
import type { GitContext } from "./gitService/context";
import * as diffOps from "./gitService/diff";
import { BranchDivergedError } from "./gitService/errors";
import * as ideaShelfOps from "./gitService/ideaShelf";
import * as logOps from "./gitService/log";
import * as mergeOps from "./gitService/mergeRebase";
import * as remoteOps from "./gitService/remote";
import * as stashOps from "./gitService/stash";
import * as statusOps from "./gitService/status";
import type {
  BranchInfo,
  CherryPickState,
  CommitNode,
  DiffFile,
  FileStatus,
  GitLogger,
  GraphLayoutResult,
  IdeaShelfEntry,
  LaneSnapshot,
  LogOptions,
  MergeState,
  ShelveEntry,
  TagInfo,
  WorkingTreeFile,
} from "./types";

export { BranchDivergedError };

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

/**
 * 本地 git CLI 的门面类。方法体委托给 `./gitService/*` 下的领域模块实现，
 * 这个类本身只负责进程执行、缓存，以及对外暴露的公共接口。
 */
export class GitService {
  readonly cache = new GitCache();
  private readonly ctx: GitContext;

  constructor(
    private readonly cwd: string,
    private readonly logger?: GitLogger,
  ) {
    this.ctx = {
      cwd: this.cwd,
      logger: this.logger,
      cache: this.cache,
      execGit: (args, maxBuffer) => this.execGit(args, maxBuffer),
      execGitBuffer: (args, maxBuffer) => this.execGitBuffer(args, maxBuffer),
      invalidateCache: (pattern) => this.invalidateCache(pattern),
    };
  }

  /** 执行一次 git 调用，向 `this.logger` 记录命令行、耗时、stderr 和失败信息。 */
  private async runGit<T extends string | Buffer>(
    args: string[],
    exec: () => Promise<{ stdout: T; stderr: T }>,
  ): Promise<T> {
    const start = Date.now();
    const commandLine = `> git ${args.join(" ")}`;
    try {
      const { stdout, stderr } = await exec();
      this.logger?.log("info", `${commandLine} [${Date.now() - start}ms]`);
      const stderrText = stderr.toString().trim();
      if (stderrText) {
        this.logger?.log("warning", stderrText);
      }
      return stdout;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.log("error", `${commandLine} [${Date.now() - start}ms]`);
      this.logger?.log("error", message.trim());
      if (/index\.lock/i.test(message)) {
        throw new Error(
          "Another Git process seems to be running (e.g. a command in a terminal). Please wait for it to finish and try again.",
        );
      }
      throw err;
    }
  }

  /** 执行 git 命令并返回文本输出（固定 `LC_ALL=C` 保证输出格式稳定，禁用终端交互式提示）。 */
  private async execGit(
    args: string[],
    maxBuffer = MAX_BUFFER,
  ): Promise<string> {
    return this.runGit(args, () =>
      execFileAsync("git", args, {
        cwd: this.cwd,
        maxBuffer,
        env: {
          ...process.env,
          LC_ALL: "C",
          GIT_TERMINAL_PROMPT: "0",
        },
      }),
    );
  }

  /** 执行 git 命令并返回二进制输出，用于读取图片等非文本文件内容。 */
  private async execGitBuffer(
    args: string[],
    maxBuffer = MAX_BUFFER,
  ): Promise<Buffer> {
    return this.runGit(args, () =>
      execFileAsync("git", args, {
        cwd: this.cwd,
        maxBuffer,
        encoding: "buffer",
        env: {
          ...process.env,
          LC_ALL: "C",
          GIT_TERMINAL_PROMPT: "0",
        },
      }),
    );
  }

  /**
   * 解析这个仓库真正的 .git 目录（绝对路径）。
   *
   * 多数情况下就是 <cwd>/.git，但在 git worktree 和 submodule 里，.git 是一个
   * 写着 "gitdir: ..." 的**文件**、真正的目录在别处——文件监听必须盯真正那个，
   * 否则整个 .git 的变化都收不到。
   */
  async getGitDir(): Promise<string | null> {
    try {
      const out = await this.execGit(["rev-parse", "--absolute-git-dir"]);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  /** 检测当前目录是否位于一个 git 工作树内。 */
  async checkGitAvailable(): Promise<boolean> {
    try {
      await this.execGit(["rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Log / History ──────────────────────────────────────────────────

  /** 按筛选条件获取提交列表。 */
  getLog(options?: LogOptions): Promise<CommitNode[]> {
    return logOps.getLog(this.ctx, options);
  }

  /** 获取提交列表并计算图形布局（车道分配 + 连线），供 Git Graph 面板渲染。 */
  getGraphTopology(
    options?: LogOptions,
    prevSnapshot?: LaneSnapshot,
  ): Promise<GraphLayoutResult> {
    return logOps.getGraphTopology(this.ctx, options, prevSnapshot);
  }

  /** 获取指定提交的所有父提交哈希。 */
  getCommitParents(hash: string): Promise<string[]> {
    return logOps.getCommitParents(this.ctx, hash);
  }

  /** 获取 HEAD 最新一次提交的完整提交信息。 */
  getLastCommitMessage(): Promise<string> {
    return logOps.getLastCommitMessage(this.ctx);
  }

  /** 获取最近 N 条提交的标题，用于提交信息输入框的历史建议。 */
  getRecentCommitMessages(count?: number): Promise<string[]> {
    return logOps.getRecentCommitMessages(this.ctx, count);
  }

  // ─── Diff / File content ────────────────────────────────────────────

  /** 获取两个引用之间的原始 diff 文本，可选限定单个文件。 */
  getDiff(ref1: string, ref2: string, file?: string): Promise<string> {
    return diffOps.getDiff(this.ctx, ref1, ref2, file);
  }

  /** 获取某个引用下指定文件的文本内容。 */
  getFileContent(ref: string, filePath: string): Promise<string> {
    return diffOps.getFileContent(this.ctx, ref, filePath);
  }

  /** 获取某个引用下指定文件的二进制内容。 */
  getFileContentBuffer(ref: string, filePath: string): Promise<Buffer> {
    return diffOps.getFileContentBuffer(this.ctx, ref, filePath);
  }

  /** 获取单个提交改动的文件列表。 */
  getCommitFiles(hash: string): Promise<DiffFile[]> {
    return diffOps.getCommitFiles(this.ctx, hash);
  }

  /** 获取多个提交合并后涉及的文件列表。 */
  getCommitRangeFiles(hashes: string[]): Promise<DiffFile[]> {
    return diffOps.getCommitRangeFiles(this.ctx, hashes);
  }

  /** 在提交列表中找出触及某个文件的最新和最早提交。 */
  findFileRange(
    hashes: string[],
    filePath: string,
  ): Promise<{ oldest: string; newest: string } | null> {
    return diffOps.findFileRange(this.ctx, hashes, filePath);
  }

  /** 获取工作区对 HEAD 的 diff，可限定到指定路径。用于 AI commit message 生成。 */
  getWorkingTreeDiff(files?: string[]): Promise<string> {
    return diffOps.getWorkingTreeDiff(this.ctx, files);
  }

  // ─── Branches / Tags ────────────────────────────────────────────────

  /** 获取本地和远程分支列表。 */
  getBranches(): Promise<BranchInfo[]> {
    return branchOps.getBranches(this.ctx);
  }

  /** 按远程仓库分组获取远程分支列表。 */
  getRemoteBranches(): Promise<{ remote: string; branches: string[] }[]> {
    return branchOps.getRemoteBranches(this.ctx);
  }

  /** 获取标签列表。 */
  getTags(): Promise<TagInfo[]> {
    return branchOps.getTags(this.ctx);
  }

  /** 切换到指定分支。 */
  checkout(branchName: string): Promise<void> {
    return branchOps.checkout(this.ctx, branchName);
  }

  /** 基于起点创建新分支。 */
  createBranch(
    newBranchName: string,
    startPoint: string,
    force?: boolean,
  ): Promise<void> {
    return branchOps.createBranch(this.ctx, newBranchName, startPoint, force);
  }

  /** 删除本地分支。 */
  deleteBranch(branchName: string, force?: boolean): Promise<void> {
    return branchOps.deleteBranch(this.ctx, branchName, force);
  }

  /** 删除远程分支。 */
  deleteRemoteBranch(remoteBranch: string): Promise<void> {
    return branchOps.deleteRemoteBranch(this.ctx, remoteBranch);
  }

  /** 重命名本地分支。 */
  renameBranch(oldName: string, newName: string): Promise<void> {
    return branchOps.renameBranch(this.ctx, oldName, newName);
  }

  /** 从指定提交创建新分支。 */
  createBranchFromCommit(
    branchName: string,
    hash: string,
    force?: boolean,
  ): Promise<void> {
    return branchOps.createBranchFromCommit(this.ctx, branchName, hash, force);
  }

  /** 在指定提交上创建标签。 */
  createTag(tagName: string, hash: string, message?: string): Promise<void> {
    return branchOps.createTag(this.ctx, tagName, hash, message);
  }

  /** 获取当前检出的分支名，detached HEAD 时返回 null。 */
  getCurrentBranch(): Promise<string | null> {
    return branchOps.getCurrentBranch(this.ctx);
  }

  /** 获取当前分支的默认远程仓库名。 */
  getDefaultRemote(branch?: string): Promise<string> {
    return branchOps.getDefaultRemote(this.ctx, branch);
  }

  // ─── Merge / Rebase / Cherry-pick / Reset ───────────────────────────

  /** 判断当前是否处于合并中状态。 */
  getMergeState(): Promise<MergeState> {
    return mergeOps.getMergeState(this.ctx);
  }

  /** 判断当前是否处于 cherry-pick 中状态。 */
  getCherryPickState(): Promise<CherryPickState> {
    return mergeOps.getCherryPickState(this.ctx);
  }

  /** 继续/跳过/中止当前的 cherry-pick。 */
  cherryPickAction(action: "continue" | "abort" | "skip"): Promise<void> {
    return mergeOps.cherryPickAction(this.ctx, action);
  }

  /** 获取当前 rebase 的进度信息。 */
  getRebaseState(): Promise<{
    isRebasing: boolean;
    branchName?: string;
    step?: number;
    totalSteps?: number;
  }> {
    return mergeOps.getRebaseState(this.ctx);
  }

  /** 获取当前存在冲突的文件路径列表。 */
  getConflictFiles(): Promise<string[]> {
    return mergeOps.getConflictFiles(this.ctx);
  }

  /** 获取冲突文件的三方版本内容（base/ours/theirs）。 */
  getFileVersions(
    filePath: string,
  ): Promise<{ base: string; ours: string; theirs: string }> {
    return mergeOps.getFileVersions(this.ctx, filePath);
  }

  /** 将三方合并编辑器产出的最终内容写回工作区文件。 */
  saveMergedContent(filePath: string, content: string): Promise<void> {
    return mergeOps.saveMergedContent(this.ctx, filePath, content);
  }

  /** 将单个文件加入暂存区（冲突解决后标记为已处理）。 */
  stageFile(filePath: string): Promise<void> {
    return mergeOps.stageFile(this.ctx, filePath);
  }

  /** 冲突解决：采用"我方"版本并暂存。 */
  acceptOurs(filePath: string): Promise<void> {
    return mergeOps.acceptOurs(this.ctx, filePath);
  }

  /** 冲突解决：采用"对方"版本并暂存。 */
  acceptTheirs(filePath: string): Promise<void> {
    return mergeOps.acceptTheirs(this.ctx, filePath);
  }

  /** 将指定分支合并到当前分支。 */
  merge(branchName: string): Promise<void> {
    return mergeOps.merge(this.ctx, branchName);
  }

  /** 将当前分支 rebase 到指定目标之上。 */
  rebase(onto: string): Promise<void> {
    return mergeOps.rebase(this.ctx, onto);
  }

  /** 继续/跳过/中止当前的 rebase。 */
  rebaseAction(action: "continue" | "abort" | "skip"): Promise<void> {
    return mergeOps.rebaseAction(this.ctx, action);
  }

  /** 中止当前合并。 */
  mergeAbort(): Promise<void> {
    return mergeOps.mergeAbort(this.ctx);
  }

  /** 冲突全部解决后完成合并提交。 */
  mergeContinue(): Promise<void> {
    return mergeOps.mergeContinue(this.ctx);
  }

  /** 切换到目标分支后立即对其执行 rebase。 */
  checkoutAndRebase(
    branchToCheckout: string,
    rebaseOnto: string,
  ): Promise<void> {
    return mergeOps.checkoutAndRebase(this.ctx, branchToCheckout, rebaseOnto);
  }

  /** 将指定提交 cherry-pick 到当前分支。 */
  cherryPick(hash: string): Promise<void> {
    return mergeOps.cherryPick(this.ctx, hash);
  }

  /** 检出指定提交（进入 detached HEAD 状态）。 */
  checkoutCommit(hash: string): Promise<void> {
    return mergeOps.checkoutCommit(this.ctx, hash);
  }

  /** 将指定文件恢复为某个提交中的版本。 */
  checkoutFileFromCommit(hash: string, filePath: string): Promise<void> {
    return mergeOps.checkoutFileFromCommit(this.ctx, hash, filePath);
  }

  /** 撤销某个提交对单个文件的改动，恢复为其父提交中的状态。 */
  checkoutFileFromParent(
    hash: string,
    filePath: string,
    status?: string,
  ): Promise<void> {
    return mergeOps.checkoutFileFromParent(this.ctx, hash, filePath, status);
  }

  /** 将当前分支重置到指定提交。 */
  resetToCommit(hash: string, mode: "soft" | "mixed" | "hard"): Promise<void> {
    return mergeOps.resetToCommit(this.ctx, hash, mode);
  }

  /** 生成一个撤销指定提交改动的新提交。 */
  revertCommit(hash: string): Promise<void> {
    return mergeOps.revertCommit(this.ctx, hash);
  }

  /** 从历史中彻底删除指定提交。 */
  dropCommit(hash: string): Promise<void> {
    return mergeOps.dropCommit(this.ctx, hash);
  }

  // ─── Remote (fetch / push / update) ─────────────────────────────────

  /** 将本地分支推送到远程。 */
  push(
    branchName: string,
    force?: boolean,
    remote?: string,
    targetBranch?: string,
  ): Promise<string> {
    return remoteOps.push(this.ctx, branchName, force, remote, targetBranch);
  }

  /** 获取领先于远程追踪分支的提交列表。 */
  getAheadCommits(branchName: string, remote?: string): Promise<CommitNode[]> {
    return remoteOps.getAheadCommits(this.ctx, branchName, remote);
  }

  /** 从上游更新本地分支（非当前分支只做 fast-forward，当前分支按策略 merge/rebase）。 */
  updateBranch(
    branchName: string,
    strategy?: "merge" | "rebase",
  ): Promise<void> {
    return remoteOps.updateBranch(this.ctx, branchName, strategy);
  }

  /** 拉取所有远程的更新并清理已失效的远程分支引用。 */
  fetch(): Promise<void> {
    return remoteOps.fetch(this.ctx);
  }

  // ─── Working tree / Commit panel ────────────────────────────────────

  /** 获取工作区文件状态列表。 */
  getStatus(): Promise<FileStatus[]> {
    return statusOps.getStatus(this.ctx);
  }

  /** 获取提交面板所需的工作区改动列表。 */
  getWorkingTreeChanges(): Promise<WorkingTreeFile[]> {
    return statusOps.getWorkingTreeChanges(this.ctx);
  }

  /** 提交暂存区的改动。 */
  commit(message: string, amend?: boolean): Promise<void> {
    return statusOps.commit(this.ctx, message, amend);
  }

  /** 只提交指定路径的当前内容，不影响 index 里其他文件。 */
  commitFiles(
    message: string,
    filePaths: string[],
    amend?: boolean,
  ): Promise<void> {
    return statusOps.commitFiles(this.ctx, message, filePaths, amend);
  }

  /** 撤销单个文件的所有改动。 */
  rollbackFile(filePath: string): Promise<void> {
    return statusOps.rollbackFile(this.ctx, filePath);
  }

  // ─── Shelf (git stash based) ─────────────────────────────────────────

  /** 获取原生 git stash 列表。 */
  getShelves(): Promise<ShelveEntry[]> {
    return stashOps.getShelves(this.ctx);
  }

  /** 将改动存入 git stash。 */
  shelveChanges(message: string, filePaths?: string[]): Promise<void> {
    return stashOps.shelveChanges(this.ctx, message, filePaths);
  }

  /** 恢复指定 stash 的改动。 */
  unshelveChanges(stashId: string, drop?: boolean): Promise<void> {
    return stashOps.unshelveChanges(this.ctx, stashId, drop);
  }

  /** 删除指定 stash。 */
  deleteShelve(stashId: string): Promise<void> {
    return stashOps.deleteShelve(this.ctx, stashId);
  }

  // ─── IDEA Shelf (patch-file based) ──────────────────────────────────

  /** 获取 IDEA 风格 shelf 列表。 */
  getIdeaShelves(): Promise<IdeaShelfEntry[]> {
    return ideaShelfOps.getIdeaShelves(this.ctx);
  }

  /** 创建一个 IDEA 风格 shelf。 */
  ideaShelveChanges(message: string, filePaths?: string[]): Promise<void> {
    return ideaShelfOps.ideaShelveChanges(this.ctx, message, filePaths);
  }

  /** 应用指定 IDEA shelf 的改动到工作区。 */
  ideaUnshelveChanges(shelfName: string, drop?: boolean): Promise<void> {
    return ideaShelfOps.ideaUnshelveChanges(this.ctx, shelfName, drop);
  }

  /** 删除指定 IDEA shelf。 */
  deleteIdeaShelf(shelfName: string): Promise<void> {
    return ideaShelfOps.deleteIdeaShelf(this.ctx, shelfName);
  }

  /** 将外部 patch 内容导入为一个新的 IDEA shelf。 */
  importPatchAsShelf(name: string, patchContent: string): Promise<void> {
    return ideaShelfOps.importPatchAsShelf(this.ctx, name, patchContent);
  }

  /** 清空缓存，或按 pattern 清除匹配的缓存项。 */
  invalidateCache(pattern?: string): void {
    this.cache.invalidate(pattern);
  }
}
