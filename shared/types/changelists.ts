export interface Changelist {
  id: string;
  name: string;
  comment: string;
  isDefault: boolean;
  createdAt: number;
}

export interface HunkAssignment {
  startLine: number;
  endLine: number;
  changelistId: string;
  /**
   * 该 hunk 变动内容的指纹（见 `shared/hunkFingerprint.ts`）。文件被编辑导致
   * 行号漂移时，靠它把分配重新锚定到新的行区间，而不是直接判定失效。
   * 旧数据没有这个字段，缺失时退回纯行号匹配。
   */
  contentHash?: string;
}

export interface FileAssignment {
  changelistId: string;
  hunks?: HunkAssignment[];
}

export interface ChangelistsFile {
  version: 2;
  changelists: Changelist[];
  activeChangelistId: string;
  defaultChangelistId: string;
  assignments: Record<string, FileAssignment>;
}

export interface HunkInfo {
  startLine: number;
  endLine: number;
  oldStart: number;
  oldCount: number;
  contextBefore: string[];
  contextAfter: string[];
  patchText: string;
}

export interface ChangelistSettings {
  allowMultiChangelistPerFile: boolean;
  highlightInactiveFiles: boolean;
  conflictBehavior: "prompt" | "move" | "switch" | "ignore";
  removeEmptyChangelists: "doNothing" | "silent" | "confirm";
  showEmptyChangelists: boolean;
}

export const DEFAULT_CHANGELIST_SETTINGS: ChangelistSettings = {
  allowMultiChangelistPerFile: false,
  highlightInactiveFiles: true,
  conflictBehavior: "prompt",
  removeEmptyChangelists: "silent",
  showEmptyChangelists: true,
};

export class ChangelistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangelistError";
  }
}