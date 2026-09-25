import { create } from "zustand";
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

type TabType = "commit" | "shelf" | "stash" | "changelists";

interface CommitStore {
  // File changes
  changes: WorkingTreeFile[];
  selectedFiles: Set<string>;
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
  hunkDialogFile: string | null;
  loadingChangelist: boolean;
  /** Spec §7.6: one-shot toast shown when stored hunk ranges drift away from current diff hunks. */
  hunkInvalidationToast: string | null;

  // Actions
  fetchChanges: () => Promise<void>;
  fetchShelves: () => Promise<void>;
  setCommitMessage: (msg: string) => void;
  setAmend: (amend: boolean) => void;
  toggleFileSelection: (filePath: string) => void;
  setFileKeys: (keys: string[], selected: boolean) => void;
  selectAllFiles: () => void;
  deselectAllFiles: () => void;
  highlightFile: (key: string, mode: "single" | "toggle") => void;
  stageFile: (filePath: string, force?: boolean) => Promise<void>;
  commit: () => Promise<boolean>;
  rollbackFile: (filePath: string) => Promise<void>;
  showDiff: (filePath: string) => Promise<void>;
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
  renameChangelist: (id: string, newName: string) => Promise<void>;
  deleteChangelist: (id: string) => Promise<void>;
  setActiveChangelist: (id: string) => Promise<void>;
  setChangelistComment: (id: string, comment: string) => Promise<void>;
  moveFileToChangelist: (filePath: string, targetId: string) => Promise<void>;
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
  hunkDialogFile: null,
  loadingChangelist: false,
  hunkInvalidationToast: null,

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
    const { commitMessage, amend, changes, selectedFiles } = get();
    if (!commitMessage.trim()) return false;

    const filePaths = changes
      .filter((f) => selectedFiles.has(f.path))
      .map((f) => f.path);

    try {
      set({ loading: true });
      await bridge.request("commitChanges", {
        message: commitMessage,
        amend,
        filePaths,
      });
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

  async showDiff(filePath: string) {
    try {
      await bridge.request("showDiffForWorkingFile", { filePath });
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
    if (tab === "changelists") {
      get().fetchChangelists();
    } else if (tab === "stash") {
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

  async moveFileToChangelist(filePath, targetId) {
    await bridge.request("moveFileToChangelist", { filePath, targetId });
    await get().fetchChangelists();
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
      await bridge.request("commitChangelist", {
        changelistId,
        message,
        amend,
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
      await bridge.request("shelveChangelist", { changelistId, message });
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
      await bridge.request("createPatchFromChangelist", { changelistId });
    } catch (err) {
      void bridge.request("showErrorNotification", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      set({ loadingChangelist: false });
    }
  },

  async validateHunkAssignments() {
    const { assignments, defaultChangelistId, getFileHunks, assignHunks } =
      get();
    let removedCount = 0;
    const updates: Array<{ filePath: string; hunks: HunkAssignment[] }> = [];

    for (const [filePath, assignment] of Object.entries(assignments)) {
      const storedHunks = assignment.hunks;
      if (!storedHunks || storedHunks.length === 0) continue;
      let currentHunkRanges: Array<[number, number]> = [];
      try {
        const currentHunks = await getFileHunks(filePath);
        currentHunkRanges = currentHunks.map((h) => [h.startLine, h.endLine]);
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
      const remaining = storedHunks.filter(
        (h) =>
          currentHunkRanges.length > 0 &&
          currentHunkRanges.some(
            ([s, e]) => !(h.endLine < s || h.startLine > e),
          ),
      );
      const removed = storedHunks.length - remaining.length;
      if (removed > 0) {
        removedCount += removed;
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

    // Touch defaultChangelistId so the linter does not flag the unused destructure.
    void defaultChangelistId;
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
