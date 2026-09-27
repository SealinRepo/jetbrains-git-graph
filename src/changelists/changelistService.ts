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
      // hunk 分配：被删列表的 hunks → 默认列表；其它列表的 hunks 保留
      if (assignment.hunks) {
        for (const h of assignment.hunks) {
          if (h.changelistId === id) {
            h.changelistId = this.state.defaultChangelistId;
          }
        }
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

  /**
   * 把一个文件"移入"目标变更列表。
   *
   * 语义是**快照当前改动**，而不是永久绑定整个文件：
   * - 调用方传入 `currentHunks`（该文件此刻 `git diff HEAD` 的每个实际 hunk，
   *   并且 `changelistId` 字段是它**当前的归属列表**）时，只有**源列表持有的那些
   *   行**会被搬到 targetId；属于其它列表的行原地不动，targetId 原有的行也保留
   *   —— 这就是"把源列表里这个文件的所有修改行累加到目标列表"。
   * - 传空/未传 `currentHunks`（未跟踪文件、或无 diff 可快照）时退化为整文件归属，
   *   因为这类文件没有行级信息可切分。
   * - `sourceChangelistId` 是这次移动的**发起列表**（用户在该列表里点了"移入…"）。
   *   缺省按默认列表处理。
   *
   * 不变式：一个行区间同一时刻只属于一个列表，所以这里永远不会把某一行同时挂到
   * 两个列表上。
   */
  async moveFileToChangelist(
    filePath: string,
    targetId: string,
    currentHunks?: HunkAssignment[],
    sourceChangelistId?: string,
  ): Promise<void> {
    this.requireChangelist(targetId);
    const defaultId = this.state.defaultChangelistId;
    const sourceId = sourceChangelistId ?? defaultId;

    if (targetId === defaultId) {
      // 移回默认列表：把源列表持有的行交还给默认（默认归属是隐式的，不需要登记），
      // 其它列表的行必须原样保留——否则"从列表 1 移回 Changes"会顺手把列表 2 的
      // 行也一起清掉。
      const existing = this.state.assignments[filePath];
      if (sourceId === defaultId || !existing?.hunks) {
        // 没有别的列表参与 → 整文件复位成隐式默认归属
        delete this.state.assignments[filePath];
      } else {
        const remaining = existing.hunks.filter(
          (h) => h.changelistId !== sourceId,
        );
        if (remaining.length === 0) delete this.state.assignments[filePath];
        else
          this.state.assignments[filePath] = {
            changelistId: defaultId,
            hunks: remaining,
          };
      }
    } else if (currentHunks && currentHunks.length > 0) {
      // 行级快照：整文件归属留默认，目标列表只拿走源列表当前持有的这批 hunk
      const existingHunks = this.state.assignments[filePath]?.hunks ?? [];
      const next: HunkAssignment[] = [];

      // 1) 其它列表的行原地保留
      for (const h of existingHunks) {
        if (h.changelistId !== sourceId && h.changelistId !== targetId) {
          next.push(h);
        }
      }
      // 2) 源列表（含隐式默认）当前持有的行 → 目标列表
      for (const h of currentHunks) {
        if (h.changelistId !== sourceId) continue;
        next.push({ ...h, changelistId: targetId });
      }
      // 3) 目标列表原有的行保留（累加，而不是覆盖）
      for (const h of existingHunks) {
        if (h.changelistId === targetId) next.push(h);
      }

      if (next.length === 0) delete this.state.assignments[filePath];
      else
        this.state.assignments[filePath] = {
          changelistId: defaultId,
          hunks: next,
        };
    } else {
      // 无行级信息可切分（未跟踪文件 / 无 diff）→ 整文件归属
      this.state.assignments[filePath] = {
        changelistId: targetId,
        hunks: undefined,
      };
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
