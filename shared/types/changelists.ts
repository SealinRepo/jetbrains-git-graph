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