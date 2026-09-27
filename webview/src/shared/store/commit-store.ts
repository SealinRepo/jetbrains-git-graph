import { create } from "zustand";
import { hunkFingerprint } from "../../../../shared/hunkFingerprint";
import type { AiConfig, AiProvider } from "../../../../shared/protocol";
import type {
  Changelist,
  ChangelistSettings,
  ChangelistsFile,
  FileAssignment,
  HunkAssignment,
  HunkInfo,
} from "../../../../shared/types/changelists";
import { bridge } from "../bridge";
import {
  computeDefaultChangelistEntries,
  hasCrossListHunks,
  resolveChangelistSelection,
} from "./changelist-files";

export interface WorkingTreeFile {
  path: string;
  oldPath?: string;
  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "untracked"
    | "conflicted";
}

export interface ShelveEntry {
  id: string;
  message: string;
  date: string;
  branch: string;
  files: string[];
}

export interface IdeaShelfEntry {
  name: string;
  description: string;
  date: string;
  patchPath: string;
  files: string[];
}

type TabType = "commit" | "shelf" | "stash";

interface CommitStore {
  // File changes
  changes: WorkingTreeFile[];
  selectedFiles: Set<string>;
  /**
   * Per-changelist file selection. Independent of `selectedFiles` (which is
   * driven by the main toolbar Commit button). Each changelist has its own
   * Set<filePath>, with an explicit tri-state:
   * - key absent  → 用户没动过这个列表，渲染出来的文件全部视为已勾选
   * - empty Set   → 用户把勾选全取消了，提交时不 stage 任何文件
   * - non-empty   → 精确的已勾选集合
   *
   * Mutating a changelist's selection only touches that one changelist's Set,
   * so the same file can be checked in list 1 but unchecked in list 2 — and
   * committing one changelist only stages the files actually checked there.
   * Resolve the tri-state through `resolveChangelistSelection`.
   */
  selectedByChangelist: Record<string, Set<string>>;
  /** Files highlighted via click/Cmd+click (for context menu operations) */
  highlightedFiles: Set<string>;

  // Commit state
  commitMessage: string;
  amend: boolean;

  // Shelf
  shelves: ShelveEntry[];

  // IDEA Shelf
  ideaShelves: IdeaShelfEntry[];

  // UI state
  activeTab: TabType;
  loading: boolean;
  expandedGroups: Set<string>;
  groupByDirectory: boolean;
  showUnversioned: boolean;
  /** Collapsed directory paths in tree view */
  collapsedDirs: Set<string>;

  // AI state
  aiConfig: AiConfig | null;
  aiLoading: boolean;

  // Changelist state
  changelists: Changelist[];
  activeChangelistId: string | null;
  defaultChangelistId: string | null;
  assignments: Record<string, FileAssignment>;
  changelistSettings: ChangelistSettings | null;
  /**
   * `git diff HEAD` 的实际 hunk 缓存（path → hunks），只缓存"存在跨列表
   * hunk 分配"的文件。默认列表要按行渲染就需要它：存储的 HunkAssignment 只是
   * 移入那一刻的行号快照，文件一改就漂移，只有真实 diff 才能回答"哪些行现在
   * 还属于这个列表"。工作区一变就整体作废（见 worktreeChanged 监听）。
   */
  fileHunks: Record<string, HunkInfo[]>;
  hunkDialogFile: string | null;
  loadingChangelist: boolean;
  /** Spec §7.6: one-shot toast shown when stored hunk ranges drift away from current diff hunks. */
  hunkInvalidationToast: string | null;
  /** When non-null, the matching changelist's header label is replaced by an
   *  inline <input> so the user can rename it without going through a prompt.
   *  Cleared by Enter / blur / Escape handlers in ChangelistFileGroup. */
  renamingChangelistId: string | null;

  // Actions
  fetchChanges: () => Promise<void>;
  fetchShelves: () => Promise<void>;
  setCommitMessage: (msg: string) => void;
  setAmend: (amend: boolean) => void;
  toggleFileSelection: (filePath: string) => void;
  /**
   * Set the checkbox state of one file inside a changelist. Independent from
   * `selectedFiles` so that the same file can be checked in one changelist
   * but not another. The key in `selectedByChangelist` is the changelist id
   * — for the default "Changes" list callers pass `defaultChangelistId`; for
   * user lists, the user-changelist id.
   *
   * `selected` is the *target* state, not a blind toggle: when the changelist
   * has no stored Set yet the implicit "everything checked" state is
   * materialized first, so the first click on an untouched list actually
   * unchecks the row instead of adding it to an empty Set.
   */
  setChangelistFileSelection: (
    changelistId: string,
    filePath: string,
    selected: boolean,
  ) => void;
  /** Folder / group-header counterpart: set every key in `keys` at once. */
  setChangelistFileSelectionKeys: (
    changelistId: string,
    keys: string[],
    selected: boolean,
  ) => void;
  setFileKeys: (keys: string[], selected: boolean) => void;
  /** Effective checked paths for a changelist (tri-state aware — see
   *  `selectedByChangelist`). Used by the changelist groups to render, and by
   *  every mutation below so the checkbox state and the staged file set never
   *  drift apart. */
  resolveChangelistSelection: (changelistId: string) => Set<string>;
  /**
   * 拉取并缓存这些文件的真实 diff hunk。已经在缓存里的直接跳过，所以可以
   * 放心地在每次渲染后调用。单个文件失败只记日志、不影响其它文件。
   */
  fetchFileHunks: (paths: string[]) => Promise<void>;
  /** 清空 hunk 缓存（工作区变化后行号会漂移）。 */
  invalidateFileHunks: () => void;
  /**
   * 工具栏 Commit 按钮能提交的范围 = 默认 "Changes" + "Unversioned Files" +
   * "Merge Conflicts" 三个分组当前真正渲染出来的文件。已经被整份移入其它列表
   * 的文件不在其中——按钮据此判断"还有没有东西可提交"，提交也只取这个交集，
   * 免得 UI 上看不见的文件被顺手带进这次提交。
   */
  getToolbarCommitPaths: () => string[];
  selectAllFiles: () => void;
  deselectAllFiles: () => void;
  highlightFile: (key: string, mode: "single" | "toggle") => void;
  stageFile: (filePath: string, force?: boolean) => Promise<void>;
  commit: () => Promise<boolean>;
  rollbackFile: (filePath: string) => Promise<void>;
  showDiff: (filePath: string, changelistId?: string) => Promise<void>;
  shelveChanges: (message?: string, filePaths?: string[]) => Promise<void>;
  unshelveChanges: (stashId: string, drop?: boolean) => Promise<void>;
  deleteShelve: (stashId: string) => Promise<void>;
  fetchIdeaShelves: () => Promise<void>;
  ideaShelveChanges: (message?: string, filePaths?: string[]) => Promise<void>;
  ideaUnshelveChanges: (shelfName: string, drop?: boolean) => Promise<void>;
  deleteIdeaShelf: (shelfName: string) => Promise<void>;
  setActiveTab: (tab: TabType) => void;
  toggleGroup: (group: string) => void;
  toggleDir: (dirPath: string) => void;
  expandAllDirs: () => void;
  collapseAllDirs: (allDirPaths: string[]) => void;
  toggleGroupByDirectory: () => void;
  toggleShowUnversioned: () => void;
  refresh: () => Promise<void>;

  // Changelist actions
  fetchChangelists: () => Promise<void>;
  createChangelist: (
    name: string,
    comment?: string,
  ) => Promise<Changelist | null>;
  /**
   * Create a new changelist using the smallest free "ChangelistN" name (N ≥ 0,
   * skipping any N already taken), make it the active changelist, and return
   * the new changelist so the UI can drop straight into inline rename mode.
   * Falls back to the regular `createChangelist` path on backend errors.
   */
  createChangelistAuto: () => Promise<Changelist | null>;
  renameChangelist: (id: string, newName: string) => Promise<void>;
  deleteChangelist: (id: string) => Promise<void>;
  setActiveChangelist: (id: string) => Promise<void>;
  setChangelistComment: (id: string, comment: string) => Promise<void>;
  /**
   * UI-only: mark a changelist as the one currently being renamed inline.
   * Setting to null cancels rename mode. Never touches the backend.
   */
  setRenamingChangelistId: (id: string | null) => void;
  /** 把文件移入 `targetId`。`sourceChangelistId` 是发起这次移动的列表：
   *  只有它持有的行会被搬走，同文件里属于其它列表的行原地不动。 */
  moveFileToChangelist: (
    filePath: string,
    targetId: string,
    sourceChangelistId?: string,
  ) => Promise<void>;
  removeFileFromChangelist: (filePath: string) => Promise<void>;
  openHunkDialog: (filePath: string) => Promise<void>;
  closeHunkDialog: () => void;
  getFileHunks: (filePath: string) => Promise<HunkInfo[]>;
  assignHunks: (filePath: string, hunks: HunkAssignment[]) => Promise<void>;
  clearFileHunks: (filePath: string) => Promise<void>;
  commitChangelist: (
    changelistId: string,
    message: string,
    amend?: boolean,
  ) => Promise<boolean>;
  shelveChangelist: (changelistId: string, message?: string) => Promise<void>;
  createPatchFromChangelist: (changelistId: string) => Promise<void>;
  /**
   * Spec §7.6 / Finding 2: walk every file with stored hunk assignments,
   * drop ranges that no longer overlap any current hunk, then push the
   * cleaned assignment back to the backend. Returns the number of removed
   * hunks so the caller can surface a toast.
   */
  validateHunkAssignments: () => Promise<number>;
  clearHunkInvalidationToast: () => void;

  // AI actions
  loadAiConfig: () => Promise<void>;
  saveAiConfig: (input: {
    provider: AiProvider;
    baseUrl: string;
    model: string;
    apiKey?: string;
    clearApiKey?: boolean;
    language?: "en" | "zh";
    maxLength?: number;
  }) => Promise<AiConfig>;
  generateAIMessage: () => Promise<string | null>;
}

export const useCommitStore = create<CommitStore>((set, get) => ({
  changes: [],
  selectedFiles: new Set<string>(),
  selectedByChangelist: {},
  highlightedFiles: new Set<string>(),
  commitMessage: "",
  amend: false,
  shelves: [],
  ideaShelves: [],
  activeTab: "commit",
  loading: false,
  expandedGroups: new Set(["changes", "unversioned"]),
  groupByDirectory: true,
  showUnversioned: true,
  collapsedDirs: new Set<string>(),

  aiConfig: null,
  aiLoading: false,

  changelists: [],
  activeChangelistId: null,
  defaultChangelistId: null,
  assignments: {},
  changelistSettings: null,
  fileHunks: {},
  hunkDialogFile: null,
  loadingChangelist: false,
  hunkInvalidationToast: null,
  renamingChangelistId: null,

  async fetchChanges() {
    set({ loading: true });
    const start = Date.now();
    try {
      const result = (await bridge.request(
        "getWorkingTreeChanges",
      )) as WorkingTreeFile[];
      if (Array.isArray(result)) {
        const newPaths = new Set(result.map((f) => f.path));
        const { selectedFiles, changes } = get();
        if (changes.length === 0) {
          // First load — no auto-selection (user manually selects files)
          set({ changes: result, selectedFiles: new Set<string>() });
        } else {
          // Refresh — preserve user's selection state (only keep existing selections)
          const preserved = new Set<string>();
          for (const p of selectedFiles) {
            if (newPaths.has(p)) preserved.add(p);
          }
          set({ changes: result, selectedFiles: preserved });
        }
      }
    } catch (err) {
      console.error("fetchChanges failed:", err);
    } finally {
      // Ensure loading bar is visible for at least 300ms
      const elapsed = Date.now() - start;
      if (elapsed < 300) {
        await new Promise((r) => setTimeout(r, 300 - elapsed));
      }
      set({ loading: false });
    }
  },

  async fetchShelves() {
    try {
      const result = (await bridge.request("getShelves")) as ShelveEntry[];
      if (Array.isArray(result)) {
        set({ shelves: result });
      }
    } catch (err) {
      console.error("fetchShelves failed:", err);
    }
  },

  setCommitMessage(msg: string) {
    set({ commitMessage: msg });
  },

  setAmend(amend: boolean) {
    set({ amend });
    if (amend) {
      // Load last commit message
      void (async () => {
        try {
          const result = (await bridge.request("getAmendMessage")) as {
            message: string;
          };
          if (result?.message) {
            set({ commitMessage: result.message });
          }
        } catch {
          // ignore
        }
      })();
    }
  },

  toggleFileSelection(key: string) {
    const { selectedFiles } = get();
    const next = new Set(selectedFiles);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    set({ selectedFiles: next });
  },

  /** Effective checked paths for a changelist, honouring the tri-state above:
   *  absent key → every file the changelist currently renders is checked. */
  resolveChangelistSelection(changelistId: string): Set<string> {
    const {
      selectedByChangelist,
      changes,
      assignments,
      activeChangelistId,
      defaultChangelistId,
      fileHunks,
    } = get();
    return resolveChangelistSelection(
      changelistId,
      selectedByChangelist[changelistId],
      {
        changes,
        assignments,
        activeChangelistId,
        defaultChangelistId,
        fileHunks,
      },
    );
  },

  setChangelistFileSelection(changelistId, filePath, selected) {
    const { selectedByChangelist } = get();
    const next = new Set(get().resolveChangelistSelection(changelistId));
    if (selected) {
      next.add(filePath);
    } else {
      next.delete(filePath);
    }
    set({
      selectedByChangelist: {
        ...selectedByChangelist,
        [changelistId]: next,
      },
    });
  },

  setChangelistFileSelectionKeys(changelistId, keys, selected) {
    const { selectedByChangelist } = get();
    const next = new Set(get().resolveChangelistSelection(changelistId));
    for (const key of keys) {
      if (selected) {
        next.add(key);
      } else {
        next.delete(key);
      }
    }
    set({
      selectedByChangelist: {
        ...selectedByChangelist,
        [changelistId]: next,
      },
    });
  },

  setFileKeys(keys: string[], selected: boolean) {
    const { selectedFiles } = get();
    const next = new Set(selectedFiles);
    for (const key of keys) {
      if (selected) {
        next.add(key);
      } else {
        next.delete(key);
      }
    }
    set({ selectedFiles: next });
  },

  async fetchFileHunks(paths) {
    const { fileHunks } = get();
    const missing = paths.filter((p) => !(p in fileHunks));
    if (missing.length === 0) return;
    // 逐个串行：这些文件都要跑一次 `git diff`，并发只会互相抢 CPU，且
    // 数量天然很小（只有被拆过行的文件）。
    const fetched: Record<string, HunkInfo[]> = {};
    for (const p of missing) {
      try {
        const hunks = await get().getFileHunks(p);
        fetched[p] = hunks;
      } catch (err) {
        console.error("getFileHunks failed for", p, err);
        // 失败**不能**缓存成空数组：空数组对默认列表的含义是"这个文件的
        // hunk 都被别的列表拿走了"，会把仍然存在的改动整条藏掉。留空让
        // 选择器退回存储区间（文件照常显示），下次工作区变化或重建时重试。
      }
    }
    if (Object.keys(fetched).length === 0) return;
    set({ fileHunks: { ...get().fileHunks, ...fetched } });
  },

  invalidateFileHunks() {
    set({ fileHunks: {} });
  },

  getToolbarCommitPaths() {
    const { changes, assignments, defaultChangelistId, fileHunks } = get();
    const paths = new Set<string>();
    for (const e of computeDefaultChangelistEntries({
      changes,
      assignments,
      defaultChangelistId,
      fileHunks,
    })) {
      paths.add(e.file.path);
    }
    for (const f of changes) {
      if (f.status === "untracked" || f.status === "conflicted") {
        paths.add(f.path);
      }
    }
    return [...paths];
  },

  selectAllFiles() {
    const { changes } = get();
    const allPaths = new Set(changes.map((f) => f.path));
    set({ selectedFiles: allPaths });
  },

  deselectAllFiles() {
    set({ selectedFiles: new Set() });
  },

  highlightFile(key: string, mode: "single" | "toggle") {
    const { highlightedFiles } = get();
    if (mode === "single") {
      set({ highlightedFiles: new Set([key]) });
    } else {
      // toggle (Cmd+click)
      const next = new Set(highlightedFiles);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      set({ highlightedFiles: next });
    }
  },

  async stageFile(filePath: string, force = false) {
    try {
      await bridge.request("stageFile", { filePath, force });
      await get().fetchChanges();
    } catch (err) {
      console.error("stageFile failed:", err);
    }
  },

  async commit() {
    const {
      commitMessage,
      amend,
      changes,
      selectedFiles,
      assignments,
      defaultChangelistId,
    } = get();
    if (!commitMessage.trim()) return false;

    // Only paths the three toolbar-owned groups actually render. A file whose
    // every hunk moved into another changelist is no longer displayed by the
    // default list, so committing it from here would be a hidden write.
    const visible = new Set(get().getToolbarCommitPaths());
    const filePaths = changes
      .filter((f) => selectedFiles.has(f.path) && visible.has(f.path))
      .map((f) => f.path);
    if (filePaths.length === 0) return false;
    try {
      set({ loading: true });
      // 行级隔离：只要选中的文件里有任何一个被拆过行（部分 hunk 归其它列表），
      // 整文件 `git add` 就会把那些行一起提交进来——那等于把别的列表的内容
      // 偷进这次提交。这种情况改走行级精确的 commitChangelist 通道。
      const needsHunkIsolation =
        defaultChangelistId !== null &&
        filePaths.some((p) =>
          hasCrossListHunks(assignments[p], defaultChangelistId),
        );
      if (needsHunkIsolation) {
        await bridge.request("commitChangelist", {
          changelistId: defaultChangelistId,
          message: commitMessage,
          amend,
          selectedFiles: filePaths,
        });
      } else {
        await bridge.request("commitChanges", {
          message: commitMessage,
          amend,
          filePaths,
        });
      }
      set({ commitMessage: "", amend: false });
      await get().fetchChanges();
      return true;
    } catch (err) {
      console.error("commit failed:", err);
      return false;
    } finally {
      set({ loading: false });
    }
  },

  async rollbackFile(filePath: string) {
    try {
      await bridge.request("rollbackFile", { filePath });
      await get().fetchChanges();
    } catch (err) {
      console.error("rollbackFile failed:", err);
    }
  },

  /**
   * Open a diff for `filePath`.
   *
   * When `changelistId` is given, the host serves a changelist-scoped right-hand
   * side (committed content + only that list's hunks), so the diff never shows
   * another changelist's lines. Omit it for groups that are not changelists
   * (Merge Conflicts, Unversioned Files) to get the plain whole-file diff.
   */
  async showDiff(filePath: string, changelistId?: string) {
    try {
      await bridge.request("showDiffForWorkingFile", {
        filePath,
        changelistId,
      });
    } catch (err) {
      console.error("showDiff failed:", err);
    }
  },

  async shelveChanges(message?: string, filePaths?: string[]) {
    try {
      set({ loading: true });
      await bridge.request("shelveChanges", { message, filePaths });
      await get().fetchChanges();
      await get().fetchShelves();
    } catch (err) {
      console.error("shelveChanges failed:", err);
    } finally {
      set({ loading: false });
    }
  },

  async unshelveChanges(stashId: string, drop = true) {
    try {
      set({ loading: true });
      await bridge.request("unshelveChanges", { stashId, drop });
      await get().fetchChanges();
      await get().fetchShelves();
    } catch (err) {
      console.error("unshelveChanges failed:", err);
    } finally {
      set({ loading: false });
    }
  },

  async deleteShelve(stashId: string) {
    try {
      await bridge.request("deleteShelve", { stashId });
      await get().fetchShelves();
    } catch (err) {
      console.error("deleteShelve failed:", err);
    }
  },

  async fetchIdeaShelves() {
    try {
      const result = (await bridge.request(
        "getIdeaShelves",
      )) as IdeaShelfEntry[];
      if (Array.isArray(result)) {
        set({ ideaShelves: result });
      }
    } catch (err) {
      console.error("fetchIdeaShelves failed:", err);
    }
  },

  async ideaShelveChanges(message?: string, filePaths?: string[]) {
    try {
      set({ loading: true });
      await bridge.request("ideaShelveChanges", { message, filePaths });
      await get().fetchChanges();
      await get().fetchIdeaShelves();
    } catch (err) {
      console.error("ideaShelveChanges failed:", err);
    } finally {
      set({ loading: false });
    }
  },

  async ideaUnshelveChanges(shelfName: string, drop = true) {
    try {
      set({ loading: true });
      await bridge.request("ideaUnshelveChanges", { shelfName, drop });
      await get().fetchChanges();
      await get().fetchIdeaShelves();
    } catch (err) {
      console.error("ideaUnshelveChanges failed:", err);
    } finally {
      set({ loading: false });
    }
  },

  async deleteIdeaShelf(shelfName: string) {
    try {
      await bridge.request("deleteIdeaShelf", { shelfName });
      await get().fetchIdeaShelves();
    } catch (err) {
      console.error("deleteIdeaShelf failed:", err);
    }
  },

  setActiveTab(tab: TabType) {
    set({ activeTab: tab });
    if (tab === "stash") {
      get().fetchShelves();
    } else if (tab === "shelf") {
      get().fetchIdeaShelves();
    }
  },

  toggleGroup(group: string) {
    const { expandedGroups } = get();
    const next = new Set(expandedGroups);
    if (next.has(group)) {
      next.delete(group);
    } else {
      next.add(group);
    }
    set({ expandedGroups: next });
  },

  toggleDir(dirPath: string) {
    const { collapsedDirs } = get();
    const next = new Set(collapsedDirs);
    if (next.has(dirPath)) {
      next.delete(dirPath);
    } else {
      next.add(dirPath);
    }
    set({ collapsedDirs: next });
  },

  expandAllDirs() {
    set({ collapsedDirs: new Set() });
  },

  collapseAllDirs(allDirPaths: string[]) {
    set({ collapsedDirs: new Set(allDirPaths) });
  },

  toggleGroupByDirectory() {
    const next = !get().groupByDirectory;
    // When toggling to directory mode, reset collapsed state so DirectoryTree will collapse all on mount
    if (next) {
      set({ groupByDirectory: true, collapsedDirs: new Set() });
    } else {
      set({ groupByDirectory: false, collapsedDirs: new Set() });
    }
  },

  toggleShowUnversioned() {
    set({ showUnversioned: !get().showUnversioned });
  },

  async refresh() {
    await Promise.all([
      get().fetchChanges(),
      get().fetchShelves(),
      get().fetchIdeaShelves(),
    ]);
  },

  // ─── Changelist actions ───────────────────────────────────────────────

  async fetchChangelists() {
    try {
      const result = (await bridge.request(
        "getChangelists",
      )) as ChangelistsFile;
      const settings = (await bridge.request(
        "getChangelistSettings",
      )) as ChangelistSettings;
      set({
        changelists: result.changelists,
        activeChangelistId: result.activeChangelistId,
        defaultChangelistId: result.defaultChangelistId,
        assignments: result.assignments,
        changelistSettings: settings,
      });
    } catch (err) {
      console.error("fetchChangelists failed:", err);
    }
  },

  async createChangelist(name, comment) {
    try {
      const result = (await bridge.request("createChangelist", {
        name,
        comment: comment ?? "",
      })) as { changelist: Changelist };
      await get().fetchChangelists();
      return result.changelist;
    } catch (err) {
      void bridge.request("showErrorNotification", {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },

  async createChangelistAuto() {
    // Pick the smallest N ≥ 0 such that no existing changelist is named
    // "ChangelistN". Bail out at a generous cap so a runaway backend can't
    // make us loop forever (also a useful safety net if N is ever huge).
    const taken = new Set(get().changelists.map((c) => c.name));
    let n = 0;
    while (taken.has(`Changelist${n}`) && n < 10_000) n++;
    const name = `Changelist${n}`;
    const created = await get().createChangelist(name);
    if (created) {
      // Make it the active changelist so any newly-checked-out files go here
      // by default — matches the user expectation that "New Changelist" lands
      // them inside a fresh, ready-to-fill list.
      await get().setActiveChangelist(created.id);
    }
    return created;
  },

  setRenamingChangelistId(id) {
    set({ renamingChangelistId: id });
  },

  async renameChangelist(id, newName) {
    try {
      await bridge.request("renameChangelist", { id, newName });
      await get().fetchChangelists();
    } catch (err) {
      void bridge.request("showErrorNotification", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async deleteChangelist(id) {
    try {
      await bridge.request("deleteChangelist", { id });
      await get().fetchChangelists();
      // The list is gone — drop its selection entry so a future list with the
      // same id never inherits a stale checkbox state.
      const { selectedByChangelist } = get();
      if (!(id in selectedByChangelist)) return;
      const { [id]: _dropped, ...rest } = selectedByChangelist;
      set({ selectedByChangelist: rest });
    } catch (err) {
      void bridge.request("showErrorNotification", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async setActiveChangelist(id) {
    await bridge.request("setActiveChangelist", { id });
    await get().fetchChangelists();
  },

  async setChangelistComment(id, comment) {
    await bridge.request("setChangelistComment", { id, comment });
    await get().fetchChangelists();
  },

  async moveFileToChangelist(filePath, targetId, sourceChangelistId) {
    await bridge.request("moveFileToChangelist", {
      filePath,
      targetId,
      sourceChangelistId,
    });
    await get().fetchChangelists();
    // A file that just landed in a list must show up checked there, and every
    // other row of that list has to keep whatever state the user gave it. So
    // resolve the target's effective selection (materializing the implicit
    // all-checked default) and write an explicit Set back.
    const {
      selectedByChangelist,
      resolveChangelistSelection: resolveSelection,
    } = get();
    const next = new Set(resolveSelection(targetId));
    next.add(filePath);
    set({
      selectedByChangelist: { ...selectedByChangelist, [targetId]: next },
    });
  },

  async removeFileFromChangelist(filePath) {
    await bridge.request("removeFileFromChangelist", { filePath });
    await get().fetchChangelists();
  },

  async openHunkDialog(filePath) {
    set({ hunkDialogFile: filePath });
  },

  closeHunkDialog() {
    set({ hunkDialogFile: null });
  },

  async getFileHunks(filePath) {
    const result = (await bridge.request("getFileHunks", { filePath })) as {
      hunks: HunkInfo[];
    };
    return result.hunks;
  },

  async assignHunks(filePath, hunks) {
    await bridge.request("assignHunks", { filePath, hunks });
    await get().fetchChangelists();
  },

  async clearFileHunks(filePath) {
    await bridge.request("clearFileHunks", { filePath });
    await get().fetchChangelists();
  },

  async commitChangelist(changelistId, message, amend = false) {
    if (!message.trim()) return false;
    try {
      set({ loadingChangelist: true });
      // Per-changelist selection: `undefined` means "no manual selection yet →
      // stage all". A Set (possibly empty) means "filter to these files only";
      // an empty Set therefore means "stage nothing".
      const stored = get().selectedByChangelist[changelistId];
      const selectedFiles =
        stored === undefined ? undefined : Array.from(stored);
      await bridge.request("commitChangelist", {
        changelistId,
        message,
        amend,
        selectedFiles,
      });
      await get().fetchChangelists();
      return true;
    } catch (err) {
      void bridge.request("showErrorNotification", {
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      set({ loadingChangelist: false });
    }
  },

  async shelveChangelist(changelistId, message) {
    try {
      set({ loadingChangelist: true });
      // Same selection contract as commitChangelist: undefined → shelve all;
      // Set (possibly empty) → filter to those files.
      const stored = get().selectedByChangelist[changelistId];
      const selectedFiles =
        stored === undefined ? undefined : Array.from(stored);
      await bridge.request("shelveChangelist", {
        changelistId,
        message,
        selectedFiles,
      });
      await get().fetchChangelists();
      await get().fetchShelves();
    } catch (err) {
      void bridge.request("showErrorNotification", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      set({ loadingChangelist: false });
    }
  },

  async createPatchFromChangelist(changelistId) {
    try {
      set({ loadingChangelist: true });
      // Same selection contract: undefined → export all; Set → filter.
      const stored = get().selectedByChangelist[changelistId];
      const selectedFiles =
        stored === undefined ? undefined : Array.from(stored);
      await bridge.request("createPatchFromChangelist", {
        changelistId,
        selectedFiles,
      });
    } catch (err) {
      void bridge.request("showErrorNotification", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      set({ loadingChangelist: false });
    }
  },

  async validateHunkAssignments() {
    const { assignments, getFileHunks, assignHunks } = get();
    let removedCount = 0;
    const updates: Array<{ filePath: string; hunks: HunkAssignment[] }> = [];

    for (const [filePath, assignment] of Object.entries(assignments)) {
      const storedHunks = assignment.hunks;
      if (!storedHunks || storedHunks.length === 0) continue;

      let currentHunks: HunkInfo[] = [];
      try {
        currentHunks = await getFileHunks(filePath);
      } catch (err) {
        // If we cannot read the hunks (file gone, etc.), treat the file as
        // having no current hunks — every stored range will drift and fall
        // away, which matches the spec's "整文件自动回退归属默认列表" intent.
        console.error(
          "validateHunkAssignments: getFileHunks failed for",
          filePath,
          err,
        );
      }

      const remaining: HunkAssignment[] = [];
      const taken = new Set<number>();
      let reanchored = false;

      for (const h of storedHunks) {
        // 1) 行号仍然对得上 → 认下这个 hunk，并把行区间吸附到当前真实范围
        //    （hunk 是原子的：只要有重叠，整个 hunk 归这个列表，和
        //    getTargetLineRanges 的判定保持一致）。
        const byRange = currentHunks.findIndex(
          (c, i) =>
            !taken.has(i) &&
            !(h.endLine < c.startLine || h.startLine > c.endLine),
        );

        // 2) 行号漂了（典型场景：在文件上方增删行后又继续改代码）→ 用内容
        //    指纹找回同一个 hunk，并重新锚定到它的新行号。少了这一步，移入
        //    其它列表的改动会因为行号漂移被错误地退回默认列表。
        const byContent =
          byRange === -1 && h.contentHash
            ? currentHunks.findIndex(
                (c, i) =>
                  !taken.has(i) &&
                  hunkFingerprint(c.patchText) === h.contentHash,
              )
            : -1;

        const match = byRange !== -1 ? byRange : byContent;
        if (match === -1) continue;

        taken.add(match);
        const target = currentHunks[match];
        if (target.startLine !== h.startLine || target.endLine !== h.endLine) {
          reanchored = true;
        }
        remaining.push({
          ...h,
          startLine: target.startLine,
          endLine: target.endLine,
        });
      }

      const removed = storedHunks.length - remaining.length;
      if (removed > 0) removedCount += removed;
      if (removed > 0 || reanchored) {
        // assignHunks([]) clears the assignment entirely when the file would
        // otherwise collapse back to the default list — same as the manual
        // clearHunksForFile path on the backend.
        updates.push({ filePath, hunks: remaining });
      }
    }

    // Apply updates sequentially to keep the backend's broadcast order stable.
    for (const { filePath, hunks } of updates) {
      try {
        await assignHunks(filePath, hunks);
      } catch (err) {
        console.error(
          "validateHunkAssignments: assignHunks failed for",
          filePath,
          err,
        );
      }
    }

    if (removedCount > 0) {
      // Fire-and-forget refresh so the store mirrors the backend. The fetch
      // triggered by assignHunks already updates assignments, but we re-fetch
      // here for safety in case any backend path short-circuits.
      void useCommitStore.getState().fetchChangelists();
      set({
        hunkInvalidationToast: `${removedCount} 个 hunk 因文件改动已失效，已回退到 Changes`,
      });
      // Note: clearHunkInvalidationToast is invoked by the UI after the
      // banner fades; do not auto-clear here so the user actually sees it.
    }

    return removedCount;
  },

  clearHunkInvalidationToast() {
    set({ hunkInvalidationToast: null });
  },

  // ─── AI actions ───────────────────────────────────────────────────────

  async loadAiConfig() {
    try {
      const cfg = (await bridge.request("aiGetConfig")) as AiConfig;
      set({ aiConfig: cfg });
    } catch (err) {
      console.error("loadAiConfig failed:", err);
    }
  },

  async saveAiConfig(input) {
    try {
      const cfg = (await bridge.request("aiSetConfig", {
        provider: input.provider,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKey: input.apiKey,
        clearApiKey: input.clearApiKey,
        maxLength: input.maxLength,
        language: input.language,
      })) as AiConfig;
      set({ aiConfig: cfg });
      return cfg;
    } catch (err) {
      console.error("saveAiConfig failed:", err);
      throw err;
    }
  },

  async generateAIMessage() {
    const { commitMessage, changes, selectedFiles } = get();
    const files = changes
      .filter((f) => selectedFiles.has(f.path))
      .map((f) => f.path);
    if (files.length === 0) {
      void bridge.request("showErrorNotification", {
        message:
          "Select at least one file in the changes list before generating.",
      });
      return null;
    }
    set({ aiLoading: true });
    try {
      const result = (await bridge.request(
        "aiGenerateCommitMessage",
        { files, prefix: commitMessage },
        { timeoutMs: 30_000 },
      )) as { message: string };
      if (result?.message) {
        set({ commitMessage: result.message });
      }
      return result?.message ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void bridge.request("showErrorNotification", {
        message: `AI generation failed: ${msg}`,
      });
      return null;
    } finally {
      set({ aiLoading: false });
    }
  },
}));

// Listen for commit state changes
bridge.onEvent((msg) => {
  if (msg.event === "worktreeChanged") {
    // Line numbers move whenever the working tree does, so every cached hunk
    // range is now suspect. Drop the cache; the changelist view refetches the
    // few files that are actually split across lists.
    useCommitStore.getState().invalidateFileHunks();
    useCommitStore.getState().fetchChanges();
  }
  if (msg.event === "stashChanged") {
    useCommitStore.getState().fetchShelves();
    useCommitStore.getState().fetchIdeaShelves();
  }
  if (msg.event === "changelistsChanged") {
    void useCommitStore
      .getState()
      .fetchChangelists()
      .then(() => {
        // Spec §7.6 / Finding 2: drop stored hunk ranges that no longer match
        // the current diff after the change broadcast.
        void useCommitStore.getState().validateHunkAssignments();
      });
  }
});

// Load AI configuration once at module init so the modal/settings UI can
// render with the current values immediately.
void useCommitStore.getState().loadAiConfig();
void useCommitStore.getState().fetchChangelists();
