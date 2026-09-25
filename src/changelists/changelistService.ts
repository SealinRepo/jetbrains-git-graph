import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type {
  Changelist,
  ChangelistSettings,
  ChangelistsFile,
  FileAssignment,
  HunkAssignment,
} from "../../shared/types/changelists";
import {
  DEFAULT_CHANGELIST_SETTINGS,
  ChangelistError,
} from "../../shared/types/changelists";

const FILE_REL = ".vscode/jetgit-changelists.json";
const DEFAULT_ID = "default";
const DEFAULT_NAME = "Changes";

export class ChangelistService {
  private state: ChangelistsFile = this.makeDefault();
  private filePath: string;
  private recentWriteAt = 0;

  constructor(
    private readonly gitRoot: string,
    private readonly onChange: () => void,
  ) {
    this.filePath = path.join(gitRoot, FILE_REL);
  }

  /** 异步加载磁盘文件；如不存在保留默认状态 */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as ChangelistsFile;
      if (parsed.version !== 2) {
        throw new ChangelistError(`Unsupported version: ${parsed.version}`);
      }
      this.state = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  /** 原子写入磁盘；写入后 100ms 内的 reload 事件被忽略 */
  async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    this.recentWriteAt = Date.now();
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), "utf-8");
    await fs.rename(tmp, this.filePath);
  }

  /** 若上次写入 < 150ms 前则返回 true（自写保护） */
  isRecentSelfWrite(): boolean {
    return Date.now() - this.recentWriteAt < 150;
  }

  getState(): ChangelistsFile {
    return this.state;
  }

  getSettings(): ChangelistSettings {
    const cfg = vscode.workspace.getConfiguration("changelists");
    return {
      allowMultiChangelistPerFile: cfg.get(
        "allowMultiChangelistPerFile",
        DEFAULT_CHANGELIST_SETTINGS.allowMultiChangelistPerFile,
      ),
      highlightInactiveFiles: cfg.get(
        "highlightInactiveFiles",
        DEFAULT_CHANGELIST_SETTINGS.highlightInactiveFiles,
      ),
      conflictBehavior: cfg.get(
        "conflictBehavior",
        DEFAULT_CHANGELIST_SETTINGS.conflictBehavior,
      ),
      removeEmptyChangelists: cfg.get(
        "removeEmptyChangelists",
        DEFAULT_CHANGELIST_SETTINGS.removeEmptyChangelists,
      ),
      showEmptyChangelists: cfg.get(
        "showEmptyChangelists",
        DEFAULT_CHANGELIST_SETTINGS.showEmptyChangelists,
      ),
    };
  }

  getFilePath(): string {
    return this.filePath;
  }

  private makeDefault(): ChangelistsFile {
    const now = Date.now();
    const def: Changelist = {
      id: DEFAULT_ID,
      name: DEFAULT_NAME,
      comment: "",
      isDefault: true,
      createdAt: now,
    };
    return {
      version: 2,
      changelists: [def],
      activeChangelistId: DEFAULT_ID,
      defaultChangelistId: DEFAULT_ID,
      assignments: {},
    };
  }
}
