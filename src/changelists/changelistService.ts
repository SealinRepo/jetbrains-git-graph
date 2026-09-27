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
  ChangelistError,
  DEFAULT_CHANGELIST_SETTINGS,
} from "../../shared/types/changelists";

const FILE_REL = ".vscode/jetgit-changelists.json";
const DEFAULT_ID = "default";
const DEFAULT_NAME = "Changes";

export class ChangelistService {
  private state: ChangelistsFile = this.makeDefault();
  private filePath: string;
  private recentWriteAt = 0;

  constructor(
    gitRoot: string,
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

  async createChangelist(name: string, comment = ""): Promise<Changelist> {
    const trimmed = name.trim();
    if (!trimmed) throw new ChangelistError("Changelist name cannot be empty");
    const dup = this.state.changelists.find(
      (c) => c.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (dup)
      throw new ChangelistError(`Changelist "${trimmed}" already exists`);
    const list: Changelist = {
      id: crypto.randomUUID(),
      name: trimmed,
      comment,
      isDefault: false,
      createdAt: Date.now(),
    };
    this.state.changelists.push(list);
    await this.save();
    this.onChange();
    return list;
  }

  async renameChangelist(id: string, newName: string): Promise<void> {
    const trimmed = newName.trim();
    if (!trimmed) throw new ChangelistError("Changelist name cannot be empty");
    const target = this.requireChangelist(id);
    const dup = this.state.changelists.find(
      (c) => c.id !== id && c.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (dup)
      throw new ChangelistError(`Changelist "${trimmed}" already exists`);
    target.name = trimmed;
    await this.save();
    this.onChange();
  }

  async deleteChangelist(id: string): Promise<void> {
    const target = this.requireChangelist(id);
    if (target.isDefault)
      throw new ChangelistError("Cannot delete default changelist");
    // 整文件分配 → 移到默认列表
    for (const [filePath, assignment] of Object.entries(
      this.state.assignments,
    )) {
      if (assignment.changelistId === id) {
        assignment.changelistId = this.state.defaultChangelistId;
      }
      // hunk 分配：丢弃属于被删列表的项；其它项保留
      if (assignment.hunks) {
        assignment.hunks = assignment.hunks.filter(
          (h) => h.changelistId !== id,
        );
        if (assignment.hunks.length === 0) delete assignment.hunks;
      }
      if (
        assignment.changelistId === this.state.defaultChangelistId &&
        !assignment.hunks
      ) {
        // 整文件 + 无 hunks → 删除该条目（隐式归属默认）
        delete this.state.assignments[filePath];
      }
    }
    this.state.changelists = this.state.changelists.filter((c) => c.id !== id);
    if (this.state.activeChangelistId === id) {
      this.state.activeChangelistId = this.state.defaultChangelistId;
    }
    await this.save();
    this.onChange();
  }

  async setActiveChangelist(id: string): Promise<void> {
    this.requireChangelist(id);
    this.state.activeChangelistId = id;
    await this.save();
    this.onChange();
  }

  async setChangelistComment(id: string, comment: string): Promise<void> {
    const target = this.requireChangelist(id);
    target.comment = comment;
    await this.save();
    this.onChange();
  }

  async moveFileToChangelist(
    filePath: string,
    targetId: string,
  ): Promise<void> {
    this.requireChangelist(targetId);
    const existing = this.state.assignments[filePath];
    this.state.assignments[filePath] = {
      changelistId: targetId,
      hunks: undefined,
    };
    if (!existing) {
      // 首次显式移动，触发 flush
    }
    await this.save();
    this.onChange();
  }

  async removeFileFromChangelist(filePath: string): Promise<void> {
    delete this.state.assignments[filePath];
    await this.save();
    this.onChange();
  }

  async assignHunks(filePath: string, hunks: HunkAssignment[]): Promise<void> {
    // 取已有整文件分配作为"剩余非 hunk 部分"的归属
    const existing = this.state.assignments[filePath];
    const wholeChangelistId =
      existing?.changelistId ?? this.state.defaultChangelistId;
    if (hunks.length === 0) {
      delete this.state.assignments[filePath];
    } else {
      this.state.assignments[filePath] = {
        changelistId: wholeChangelistId,
        hunks,
      };
    }
    await this.save();
    this.onChange();
  }

  async clearHunksForFile(filePath: string): Promise<void> {
    const existing = this.state.assignments[filePath];
    if (!existing) return;
    if (existing.hunks) {
      delete existing.hunks;
      if (existing.changelistId === this.state.defaultChangelistId) {
        delete this.state.assignments[filePath];
      }
      await this.save();
      this.onChange();
    }
  }

  /** 计算 effective assignments：tracked 未分配文件不在此函数处理（由 commitChangelist 在 commit 时按 default 列表隐式归属）；untracked 仍归属到 activeChangelistId */
  getEffectiveAssignments(
    untracked: Set<string>,
  ): Record<string, FileAssignment> {
    const out: Record<string, FileAssignment> = {};
    for (const [path, a] of Object.entries(this.state.assignments)) {
      out[path] = { ...a, hunks: a.hunks ? [...a.hunks] : undefined };
    }
    for (const path of untracked) {
      if (!out[path]) {
        out[path] = { changelistId: this.state.activeChangelistId };
      }
    }
    return out;
  }

  getAssignment(filePath: string): FileAssignment | undefined {
    return this.state.assignments[filePath];
  }

  getChangelistById(id: string): Changelist | undefined {
    return this.state.changelists.find((c) => c.id === id);
  }

  private requireChangelist(id: string): Changelist {
    const c = this.getChangelistById(id);
    if (!c) throw new ChangelistError(`Changelist "${id}" not found`);
    return c;
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
