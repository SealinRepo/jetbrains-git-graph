/**
 * 扩展主机（src/）与 webview（webview/src/）共用的通信协议。
 * 两边都直接导入这个文件（见 tsconfig.json / webview/tsconfig.json 的 include），
 * 命令名、事件名等定义只有这一份来源。
 */

export interface RequestMessage {
  type: "request";
  id: string;
  command: CommandType;
  params: Record<string, unknown>;
}

export interface ResponseMessage {
  type: "response";
  id: string;
  success: boolean;
  data?: unknown;
  error?: {
    message: string;
  };
}

export interface EventMessage<E extends EventType = EventType> {
  type: "event";
  event: E;
  data: EventPayloads[E];
}

/**
 * 广播出去的事件消息的精确类型：是各个具体事件消息的联合，而不是
 * `EventMessage<EventType>`。订阅方按 `event` 字段判别之后，`data` 会自动
 * 收窄到对应的 payload 类型，不需要再 `as`。
 */
export type AnyEventMessage = {
  [E in EventType]: EventMessage<E>;
}[EventType];

export type Message = RequestMessage | ResponseMessage | AnyEventMessage;

export type CommandType =
  | "getLog"
  | "getGraphData"
  | "loadMoreLog"
  | "getBranches"
  | "getTags"
  | "getDiff"
  | "getFileContent"
  | "getCommitFiles"
  | "getStatus"
  | "openDiffEditor"
  | "openMergeEditor"
  | "getMergeState"
  | "getCherryPickState"
  | "getConflictFiles"
  | "getFileVersions"
  | "saveMergedContent"
  | "stageFile"
  | "compareFileWithRevision"
  | "annotateFile"
  | "showFileHistory"
  | "acceptOurs"
  | "acceptTheirs"
  | "confirmCancelMerge"
  | "closeMergeEditor"
  | "openFile"
  | "checkoutBranch"
  | "createBranch"
  | "createBranchFromCommit"
  | "deleteBranch"
  | "renameBranch"
  | "mergeBranch"
  | "rebaseBranch"
  | "checkoutAndRebase"
  | "pushBranch"
  | "updateBranch"
  | "fetchBranch"
  | "commitChanges"
  | "amendCommit"
  | "rollbackFile"
  | "rollbackFiles"
  | "getWorkingTreeChanges"
  | "getShelves"
  | "shelveChanges"
  | "unshelveChanges"
  | "deleteShelve"
  | "showDiffForWorkingFile"
  | "getAmendMessage"
  | "getIdeaShelves"
  | "ideaShelveChanges"
  | "ideaUnshelveChanges"
  | "deleteIdeaShelf"
  | "showIdeaShelfFileDiff"
  | "createPatchFromShelf"
  | "importPatches"
  | "deleteFiles"
  | "revealInSystemExplorer"
  | "getRecentCommitMessages"
  | "getRebaseState"
  | "rebaseAction"
  | "mergeAction"
  | "cherryPickAction"
  | "showErrorNotification"
  | "showInfoNotification"
  | "openConflictsPanel"
  | "createBranchPrompt"
  | "compareWithCurrent"
  | "showMyBranches"
  | "fetchAll"
  | "navigateToHead"
  | "getAheadCommits"
  | "getCommitRangeFiles"
  | "executePush"
  | "openPushPanel"
  | "getRemoteBranches"
  | "dropCommit"
  | "closePushPanel"
  | "openRollbackPanel"
  | "executeRollback"
  | "closeRollbackPanel"
  | "aiGetConfig"
  | "aiSetConfig"
  | "aiGenerateCommitMessage";

/**
 * 事件名 → payload 形状的映射，事件类型的唯一来源。
 *
 * 这里只描述「线上传的是什么形状」，不描述「为什么这么分」：git 状态的分域
 * 规则（GitDomain）属于扩展主机侧，见 src/state/domains.ts。webview 只按事件
 * 名订阅，不需要知道「域」这个概念。
 */
export interface EventPayloads {
  // ── git 状态：一个域一个事件 ──
  /** HEAD / 分支 / tag / 远程 ref / commit 图 */
  refsChanged: void;
  /** 工作区文件状态 + 暂存区 */
  worktreeChanged: void;
  /** stash / shelf 列表 */
  stashChanged: void;
  /** merge / rebase / cherry-pick 进行中状态 */
  operationChanged: void;

  // ── UI 事件：与 git 状态无关 ──
  /** 在 Git Log 面板中按文件过滤历史 */
  showFileHistory: { file: string };
  /** Rollback 面板被复用时重新投递文件列表 */
  rollbackPanelInit: { files: RollbackFileInfo[] };
  /** 扩展开始了一次耗时操作（顶部进度条）。与 git 的「进行中操作」无关 */
  busyStart: void;
  /** 耗时操作结束 */
  busyEnd: void;
}

export type EventType = keyof EventPayloads;

export interface RollbackFileInfo {
  path: string;
  status: string;
}

export interface RemoteBranchGroup {
  remote: string;
  branches: string[];
}

// ─── AI commit-message generation ─────────────────────────────────────────

export type AiProvider = "vscode" | "anthropic" | "openai";

/**
 * Public AI configuration exposed to the webview.
 * Note: the actual API key never leaves the extension host (kept in
 * SecretStorage); only `hasApiKey` is reported so the UI can show whether
 * one is configured.
 */
export interface AiConfig {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  /** 生成长度限制，默认 200；生成时截断到此长度 */
  maxLength?: number;
  /** AI 请求语言：en / zh，默认 en */
  language?: "en" | "zh";
}

export interface AiGenerateRequest {
  /** Files to include in the diff. Empty array = all working-tree changes. */
  files: string[];
  /** Existing textarea content, treated as a hint the AI can refine/extend. */
  prefix: string;
}

export interface AiGenerateResponse {
  /** Final commit message text (subject + optional body, separated by \n\n). */
  message: string;
}
