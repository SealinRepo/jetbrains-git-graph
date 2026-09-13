import type { EventType } from "../../shared/protocol";

/**
 * git 状态的分域。
 *
 * 域是按「下游要重新拉什么」倒推出来的，不是按 git 自己的概念划的。每个域对应
 * 一个广播事件（见 DOMAIN_EVENT），订阅方只重拉自己关心的那部分数据。
 *
 * 调用 notify() 时按「这次操作实际改了什么」挑域，宁可多给一个也不要漏——漏了
 * 是界面不刷新，多给只是多跑一次查询。
 *
 * | 域 | 数据范围（订阅方会重拉什么） | 变更源 | 消费者 | 代价 |
 * | --- | --- | --- | --- | --- |
 * | `refs` | 分支列表、tag 列表、提交图：getBranches + getTags + getGraphData（200 条）+ 车道布局重算 | HEAD、refs/**、packed-refs、config，以及任何产生新提交的操作 | panel-store（Git Log 面板的图 / 分支树 / tag） | **最重** |
 * | `worktree` | 工作区改动列表：getWorkingTreeChanges（一次 git status） | 工作区文件增删改、暂存区（.git/index） | commit-store 的 Changes / Unversioned 列表；活动栏图标角标 | 轻 |
 * | `stash` | shelf 与 IDEA shelf 列表：getShelves + getIdeaShelves | git stash、shelf 增删、导入 patch | commit-store 的 Shelf / IDEA Shelf 两个标签页 | 轻 |
 * | `operation` | 进行中操作状态：getMergeState + getRebaseState + getCherryPickState | MERGE_HEAD、CHERRY_PICK_HEAD、REVERT_HEAD、rebase-merge/** 等 | Commit 面板顶部的 Rebase / CherryPick / Merge 三个 Banner | 轻 |
 *
 * 几条容易搞错的边界：
 * - **纯工作区文件改动只给 `worktree`，绝不给 `refs`**。否则保存一次文件就要重算
 *   整张提交图——这是分域最主要的收益所在。
 * - **`.git/index` 变化只算 `worktree`**。git status 自己会回写 index 刷新 stat
 *   缓存，若把它算进 refs，就会变成 status → 写 index → 重拉 → 又跑 status 的回路。
 * - **会产生新提交的操作**（commit / amend / revert / cherry-pick）要带上 `refs`。
 * - **可能停在冲突里的操作**（merge / rebase / cherry-pick / revert）要带上 `operation`。
 * - 拿不准变了什么的场景（面板刚打开、用户点手动刷新）用 notifyAll()。
 *
 * 域这个概念只属于扩展主机侧：webview 按事件名订阅，不需要知道域的存在，所以
 * GitDomain 不出现在 shared/protocol.ts 里。
 */
export const GitDomain = {
  /**
   * 分支列表、tag 列表、提交图。
   *
   * 订阅方会重拉 getBranches + getTags + getGraphData（200 条）并重算车道布局，
   * 是四个域里代价最高的一个，别顺手带上。
   * 消费者：panel-store（Git Log 面板）。
   */
  Refs: "refs",

  /**
   * 工作区改动列表（含未跟踪文件）与暂存区。
   *
   * 订阅方会重拉 getWorkingTreeChanges（一次 git status）。
   * 消费者：Commit 面板的 Changes / Unversioned 列表、活动栏图标角标。
   */
  Worktree: "worktree",

  /**
   * shelf 与 IDEA shelf 列表。
   *
   * 订阅方会重拉 getShelves + getIdeaShelves。
   * 消费者：Commit 面板的 Shelf / IDEA Shelf 两个标签页。
   */
  Stash: "stash",

  /**
   * merge / rebase / cherry-pick 的「进行中」状态。
   *
   * 订阅方会重拉 getMergeState + getRebaseState + getCherryPickState。
   * 消费者：Commit 面板顶部那三个 Banner。
   */
  Operation: "operation",
} as const;

export type GitDomain = (typeof GitDomain)[keyof typeof GitDomain];

/** 全部域。用 Object.values 派生，加新域时不会漏在这里。 */
export const ALL_DOMAINS: readonly GitDomain[] = Object.values(GitDomain);

/**
 * 域 → 事件名的唯一映射来源。`satisfies` 保证这里键是齐的。
 */
export const DOMAIN_EVENT = {
  [GitDomain.Refs]: "refsChanged",
  [GitDomain.Worktree]: "worktreeChanged",
  [GitDomain.Stash]: "stashChanged",
  [GitDomain.Operation]: "operationChanged",
} as const satisfies Record<GitDomain, EventType>;

/**
 * git 状态变更的出口。
 *
 * 由使用方（GitWatcher、各个命令 handler）定义，实现在 src/state/gitStateNotifier.ts。
 * watcher 只依赖这个接口而不依赖具体实现，一是保持依赖指向更稳定的一侧，
 * 二是让 watcher 的分类/防抖逻辑可以脱离 MessageRouter 单独测。
 *
 * 实现必须是幂等的：同一次 git 操作会被 handler 和 watcher 各通知一次。
 */
export interface GitStateSink {
  /** 声明这些域发生了变化。怎么挑域见 {@link GitDomain} 上的对照表。 */
  notify(...domains: GitDomain[]): void;
  /** 全域刷新，用于面板打开、手动刷新这类拿不准具体变了什么的场景 */
  notifyAll(): void;
}
