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

export interface EventMessage {
  type: "event";
  event: EventType;
  data: unknown;
}

export type Message = RequestMessage | ResponseMessage | EventMessage;

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
  | "refreshGitState"
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
  | "closeRollbackPanel";

export type EventType =
  | "gitStateChanged"
  | "mergeStateChanged"
  | "themeChanged"
  | "showFileHistory"
  | "operationStart"
  | "operationEnd"
  | "commitStateChanged"
  | "rollbackPanelInit";

export interface RollbackFileInfo {
  path: string;
  status: string;
}

export interface RemoteBranchGroup {
  remote: string;
  branches: string[];
}
