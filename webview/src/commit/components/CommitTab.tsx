import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Changelist } from "../../../../shared/types/changelists";
import { ChangelistContextMenu } from "../../changelists/ChangelistContextMenu";
import { HunkAssignmentDialog } from "../../changelists/HunkAssignmentDialog";
import { bridge } from "../../shared/bridge";
import {
  AddIcon,
  CheckIcon,
  DeleteIcon,
  EditIcon,
  FolderWhiteIcon,
  RollbackIcon,
} from "../../shared/components/Icons";
import {
  type ChangelistFileEntry,
  computeChangelistFiles,
  getImplicitDefaultHunks,
  userChangelists,
} from "../../shared/store/changelist-files";
import {
  useCommitStore,
  type WorkingTreeFile,
} from "../../shared/store/commit-store";
import { CommitFileContextMenu } from "./CommitFileContextMenu";
import { CommitMessageArea } from "./CommitMessageArea";
import { FileItem } from "./FileItem";
import { Toolbar } from "./Toolbar";
import {
  buildGroupItems,
  collectDirFiles,
  collectFileKeys,
  countFiles,
  FolderRow,
} from "./TreeRow";

const TOAST_DURATION_MS = 5000;

export function CommitTab() {
  const {
    changes,
    selectedFiles,
    highlightedFiles,
    expandedGroups,
    groupByDirectory,
    showUnversioned,
    toggleGroup,
    toggleFileSelection,
    setFileKeys,
    highlightFile,
    showDiff,
    ideaShelveChanges,
    changelists,
    activeChangelistId,
    defaultChangelistId,
    assignments,
    changelistSettings,
    hunkDialogFile,
    closeHunkDialog,
    hunkInvalidationToast,
    clearHunkInvalidationToast,
    getFileHunks,
  } = useCommitStore();

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: WorkingTreeFile;
  } | null>(null);

  const [dirContextMenu, setDirContextMenu] = useState<{
    x: number;
    y: number;
    files: WorkingTreeFile[];
    dirName: string;
  } | null>(null);

  const [backgroundMenu, setBackgroundMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const [toastVisible, setToastVisible] = useState<string | null>(null);
  useEffect(() => {
    if (!hunkInvalidationToast) return;
    setToastVisible(hunkInvalidationToast);
    const handle = setTimeout(() => {
      setToastVisible(null);
      clearHunkInvalidationToast();
    }, TOAST_DURATION_MS);
    return () => clearTimeout(handle);
  }, [hunkInvalidationToast, clearHunkInvalidationToast]);

  // Files that have at least one explicit hunk assigned to a non-default
  // changelist — they need hunk-only display in the default "Changes" group
  // instead of showing as a whole file. Recomputed whenever assignments change
  // so newly-assigned files immediately appear in this bucket.
  const filesWithHunksToOther = useMemo(() => {
    const result: WorkingTreeFile[] = [];
    for (const file of changes) {
      if (file.status === "untracked" || file.status === "conflicted") continue;
      const a = assignments[file.path];
      if (!a?.hunks) continue;
      const hasHunksToOther = a.hunks.some(
        (h) => h.changelistId !== defaultChangelistId,
      );
      if (hasHunksToOther) result.push(file);
    }
    return result;
  }, [changes, assignments, defaultChangelistId]);

  // Fetch the actual diff hunks for every file in the bucket above. The list
  // is short (only files the user has explicitly split), so a single
  // Promise.all pass is fine. We snapshot a cancellation flag in the cleanup
  // so out-of-order responses don't clobber the latest assignment view.
  const [actualHunksByFile, setActualHunksByFile] = useState<
    Map<string, import("../../../../shared/types/changelists").HunkInfo[]>
  >(() => new Map());
  useEffect(() => {
    let cancelled = false;
    const paths = filesWithHunksToOther.map((f) => f.path);
    if (paths.length === 0) {
      setActualHunksByFile(new Map());
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      const entries: Array<
        [string, import("../../../../shared/types/changelists").HunkInfo[]]
      > = [];
      for (const p of paths) {
        try {
          const hunks = await getFileHunks(p);
          entries.push([p, hunks]);
        } catch (err) {
          console.error("getFileHunks failed for", p, err);
          entries.push([p, []]);
        }
      }
      if (cancelled) return;
      setActualHunksByFile(new Map(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [filesWithHunksToOther, getFileHunks]);

  // Group files: Changes (tracked, modified) vs Unversioned Files (untracked).
  // Tracked files are split further:
  // - `changedFiles`: shown as a whole file in the default "Changes" group.
  // - `defaultHunkFiles`: shown as one or more "Lines X–Y" rows in the default
  //   group, scoped to the hunks not claimed by other changelists. These come
  //   from `filesWithHunksToOther` (computed above) so the renderer can fetch
  //   their actual hunks without re-scanning here.
  const { changedFiles, defaultHunkFiles, untrackedFiles, conflictedFiles } =
    useMemo(() => {
      const changed: WorkingTreeFile[] = [];
      const defaultHunks: WorkingTreeFile[] = [];
      const untracked: WorkingTreeFile[] = [];
      const conflicted: WorkingTreeFile[] = [];

      for (const file of changes) {
        if (file.status === "conflicted") {
          conflicted.push(file);
        } else if (file.status === "untracked") {
          untracked.push(file);
        } else {
          // Files explicitly whole-file assigned to a non-default changelist
          // belong ONLY to that changelist (not the default "Changes" group).
          const a = assignments[file.path];
          if (
            a?.changelistId &&
            a.changelistId !== defaultChangelistId &&
            !a.hunks
          ) {
            continue;
          }
          // If the file has hunks explicitly assigned to another non-default
          // changelist, route it through the hunk-only renderer instead of
          // showing it as a whole file in default.
          const hasHunksToOther = (a?.hunks ?? []).some(
            (h) => h.changelistId !== defaultChangelistId,
          );
          if (hasHunksToOther) {
            defaultHunks.push(file);
          } else {
            changed.push(file);
          }
        }
      }
      return {
        changedFiles: changed,
        defaultHunkFiles: defaultHunks,
        untrackedFiles: untracked,
        conflictedFiles: conflicted,
      };
    }, [changes, assignments, defaultChangelistId]);

  // Flatten `defaultHunkFiles` into one row per actual hunk that belongs to
  // default. Rows are emitted only after `actualHunksByFile` is populated for
  // the file — otherwise the file would briefly flash as a whole-file entry.
  const defaultHunkRows = useMemo(() => {
    const rows: Array<{
      file: WorkingTreeFile;
      hunkRange: { startLine: number; endLine: number };
    }> = [];
    for (const file of defaultHunkFiles) {
      const actualHunks = actualHunksByFile.get(file.path);
      if (!actualHunks) continue;
      const implicit = getImplicitDefaultHunks(
        actualHunks,
        assignments[file.path],
        defaultChangelistId,
      );
      if (!implicit) continue;
      for (const h of implicit) {
        rows.push({
          file,
          hunkRange: { startLine: h.startLine, endLine: h.endLine },
        });
      }
    }
    return rows;
  }, [defaultHunkFiles, actualHunksByFile, assignments, defaultChangelistId]);

  const userLists = useMemo(
    () => userChangelists(changelists, defaultChangelistId),
    [changelists, defaultChangelistId],
  );

  const handleShelveSelected = useCallback(async () => {
    const selectedPaths = changes
      .filter((f) => selectedFiles.has(f.path))
      .map((f) => f.path);
    if (selectedPaths.length === 0) return;
    await ideaShelveChanges("Shelved changes", [...new Set(selectedPaths)]);
  }, [changes, selectedFiles, ideaShelveChanges]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, file: WorkingTreeFile) => {
      setContextMenu({ x: e.clientX, y: e.clientY, file });
      setDirContextMenu(null);
    },
    [],
  );

  const handleDirContextMenu = useCallback(
    (e: React.MouseEvent, files: WorkingTreeFile[], dirName: string) => {
      e.preventDefault();
      e.stopPropagation();
      setDirContextMenu({ x: e.clientX, y: e.clientY, files, dirName });
      setContextMenu(null);
      setBackgroundMenu(null);
    },
    [],
  );

  const handleBackgroundContextMenu = useCallback((e: React.MouseEvent) => {
    // Panel-background right-click. File rows / folder rows / group headers
    // all have their own contextMenu handlers that stop propagation, so we
    // only reach here when the user clicked on bare whitespace (or the
    // "No changes detected" empty placeholder). Suppress the browser's
    // native context menu either way so the custom menu is the only thing
    // users see.
    e.preventDefault();
    e.stopPropagation();
    setBackgroundMenu({ x: e.clientX, y: e.clientY });
    setContextMenu(null);
    setDirContextMenu(null);
  }, []);

  // 拖文件到其他 changelist：所有 group 的文件行都允许拖；落点只存在于
  // 用户 changelist 那一组（ChangelistFileGroup 的 onDrop），所以从 Changes /
  // Unversioned / Merge Conflicts / 其它用户列表拖过来都行。
  const handleFileDragStart = useCallback(
    (filePath: string) => (e: React.DragEvent) => {
      e.dataTransfer.setData(
        "application/x-jetgit-file-paths",
        JSON.stringify([filePath]),
      );
    },
    [],
  );

  // 拖回默认列表：Changes group 自己也接受 drop（与 ChangelistFileGroup
  // 互为反向），实现"在用户列表和 Changes 之间互拖"的能力。
  const handleDropToDefault = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const data = e.dataTransfer.getData("application/x-jetgit-file-paths");
      if (!data) return;
      let paths: string[] = [];
      try {
        paths = JSON.parse(data);
      } catch {
        return;
      }
      if (!defaultChangelistId) return;
      for (const p of paths) {
        void useCommitStore
          .getState()
          .moveFileToChangelist(p, defaultChangelistId);
      }
    },
    [defaultChangelistId],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const closeDirContextMenu = useCallback(() => {
    setDirContextMenu(null);
  }, []);

  const closeBackgroundMenu = useCallback(() => {
    setBackgroundMenu(null);
  }, []);

  return (
    <div
      className="commit-tab-content"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <Toolbar
        onShelve={handleShelveSelected}
        onRollback={() => {
          // Use highlighted files (click/focus selection), not checkbox selection
          const highlightedPaths = changes
            .filter((f) => highlightedFiles.has(f.path))
            .map((f) => ({ path: f.path, status: f.status }));

          if (highlightedPaths.length > 0) {
            bridge.request("openRollbackPanel", { files: highlightedPaths });
          } else {
            // No highlighted files: fall back to all working tree change files
            const allFiles = changes.map((f) => ({
              path: f.path,
              status: f.status,
            }));
            bridge.request("openRollbackPanel", { files: allFiles });
          }
        }}
        hasChanges={changes.length > 0}
      />

      <div
        className="commit-file-list"
        onContextMenu={handleBackgroundContextMenu}
      >
        {toastVisible && (
          <div className="changelist-toast" role="status">
            {toastVisible}
          </div>
        )}

        {/* Merge Conflicts — virtual status group, never bold (not a real changelist) */}
        {conflictedFiles.length > 0 && (
          <FileGroup
            label="Merge Conflicts"
            files={conflictedFiles}
            expanded={expandedGroups.has("conflicts")}
            groupByDirectory={groupByDirectory}
            onToggle={() => toggleGroup("conflicts")}
            selectedFiles={selectedFiles}
            highlightedFiles={highlightedFiles}
            onToggleFile={toggleFileSelection}
            onSetFileKeys={setFileKeys}
            onHighlightFile={highlightFile}
            onShowDiff={showDiff}
            onContextMenu={handleContextMenu}
            onDirContextMenu={handleDirContextMenu}
            boldOverride={false}
            onFileDragStart={handleFileDragStart}
            action={
              <span
                className="commit-group-resolve-link"
                onClick={(e) => {
                  e.stopPropagation();
                  bridge.request("openConflictsPanel");
                }}
                onKeyDown={() => {}}
                role="button"
                tabIndex={0}
              >
                Resolve
              </span>
            }
          />
        )}

        {/* Changes (default changelist — tracked, modified) — always shown, even when empty.
            Bold only when the default changelist is the currently-active one.
            Accepts drops from user changelists (reverse direction of
            ChangelistFileGroup's onDrop). */}
        <FileGroup
          label="Changes"
          files={changedFiles}
          expanded={expandedGroups.has("changes")}
          groupByDirectory={groupByDirectory}
          onToggle={() => toggleGroup("changes")}
          selectedFiles={selectedFiles}
          highlightedFiles={highlightedFiles}
          onToggleFile={toggleFileSelection}
          onSetFileKeys={setFileKeys}
          onHighlightFile={highlightFile}
          onShowDiff={showDiff}
          onContextMenu={handleContextMenu}
          onDirContextMenu={handleDirContextMenu}
          boldOverride={defaultChangelistId === activeChangelistId}
          onFileDragStart={handleFileDragStart}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDropToDefault}
        />

        {/* Hunk-only rows inside the default group. Files that have explicit
            hunk assignments to other changelists are not rendered as whole
            files above; instead we render the implicit-default hunks here as
            "Lines X–Y" rows so users can see exactly which part of the file
            is still scoped to default. Each row uses the same
            ChangelistHunkRow layout as user changelists but without the
            italic styling (default is the primary list, not an annotation). */}
        {expandedGroups.has("changes") && defaultHunkRows.length > 0 && (
          <div className="changelist-hunk-only">
            {defaultHunkRows.map((entry, i) => (
              <ChangelistHunkRow
                key={`${entry.file.path}-${entry.hunkRange.startLine}-${entry.hunkRange.endLine}-${i}`}
                entry={entry}
                dimmed={false}
                italic={false}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleContextMenu(e, entry.file);
                }}
                onShowDiff={() => showDiff(entry.file.path)}
              />
            ))}
          </div>
        )}

        {/* Unversioned Files — virtual display group for untracked files, never bold. */}
        {showUnversioned && untrackedFiles.length > 0 && (
          <FileGroup
            label="Unversioned Files"
            files={untrackedFiles}
            expanded={expandedGroups.has("unversioned")}
            groupByDirectory={groupByDirectory}
            onToggle={() => toggleGroup("unversioned")}
            selectedFiles={selectedFiles}
            highlightedFiles={highlightedFiles}
            onToggleFile={toggleFileSelection}
            onSetFileKeys={setFileKeys}
            onHighlightFile={highlightFile}
            onShowDiff={showDiff}
            onContextMenu={handleContextMenu}
            onDirContextMenu={handleDirContextMenu}
            boldOverride={false}
            onFileDragStart={handleFileDragStart}
          />
        )}

        {/* User changelists — rendered AFTER Unversioned Files, in creation order.
            Each one is a full FileGroup (so tree/select/highlight behave the same
            as the other groups) with an extra right-click handler on the header
            for management actions. */}
        {userLists.map((changelist) => {
          const entries = computeChangelistFiles({
            changelistId: changelist.id,
            changes,
            assignments,
            activeChangelistId,
            defaultChangelistId,
          });
          return (
            <ChangelistFileGroup
              key={changelist.id}
              changelist={changelist}
              entries={entries}
              expanded={expandedGroups.has(changelist.id)}
              groupByDirectory={groupByDirectory}
              selectedFiles={selectedFiles}
              highlightedFiles={highlightedFiles}
              onToggle={() => toggleGroup(changelist.id)}
              onToggleFile={toggleFileSelection}
              onSetFileKeys={setFileKeys}
              onHighlightFile={highlightFile}
              onShowDiff={showDiff}
              onFileContextMenu={handleContextMenu}
              onDirContextMenu={handleDirContextMenu}
              showEmptyChangelists={
                changelistSettings?.showEmptyChangelists ?? true
              }
              isActive={changelist.id === activeChangelistId}
              onFileDragStart={handleFileDragStart}
            />
          );
        })}

        {changes.length === 0 && userLists.length === 0 && (
          <div className="shelf-empty">No changes detected</div>
        )}
      </div>

      <CommitMessageArea />

      {contextMenu && (
        <CommitFileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          file={contextMenu.file}
          onClose={closeContextMenu}
        />
      )}
      {dirContextMenu && (
        <DirContextMenu
          x={dirContextMenu.x}
          y={dirContextMenu.y}
          files={dirContextMenu.files}
          dirName={dirContextMenu.dirName}
          onClose={closeDirContextMenu}
        />
      )}
      {backgroundMenu && (
        <BackgroundContextMenu
          x={backgroundMenu.x}
          y={backgroundMenu.y}
          onClose={closeBackgroundMenu}
        />
      )}
      {hunkDialogFile && (
        <HunkAssignmentDialog
          filePath={hunkDialogFile}
          onClose={closeHunkDialog}
        />
      )}
    </div>
  );
}

interface FileGroupProps {
  label: string;
  files: WorkingTreeFile[];
  expanded: boolean;
  groupByDirectory: boolean;
  onToggle: () => void;
  selectedFiles: Set<string>;
  highlightedFiles: Set<string>;
  onToggleFile: (key: string) => void;
  onSetFileKeys: (keys: string[], selected: boolean) => void;
  onHighlightFile: (key: string, mode: "single" | "toggle") => void;
  onShowDiff: (path: string) => Promise<void>;
  onContextMenu: (e: React.MouseEvent, file: WorkingTreeFile) => void;
  onDirContextMenu: (
    e: React.MouseEvent,
    files: WorkingTreeFile[],
    dirName: string,
  ) => void;
  action?: React.ReactNode;
  /** Right-click on the group header. If omitted, the header has no
   *  context menu (current behaviour for Changes / Unversioned Files). */
  onHeaderContextMenu?: (e: React.MouseEvent) => void;
  /** Optional class name appended to the wrapping div, used by the changelist
   *  group to opt into the drop-hover styling. */
  extraClassName?: string;
  /** 传给 FolderRow 的 boldOverride：changelist group 用这个把"仅活跃列表
   *  加粗"压到真正的渲染层；其它 group 不传，保持原"分组根节点=加粗"行为。 */
  boldOverride?: boolean;
  /** Forwarded to FolderRow → TreeRow. Used by the inline changelist rename
   *  editor to swap the header label for an <input>. */
  customLabel?: React.ReactNode;
  /** 让整行可拖（拖到其他 changelist）。调用方一般在用户 changelist group
   *  上启用；Changes / Unversioned Files / Merge Conflicts 是否启用取决于
   *  它们的目标是不是只有用户列表（这里统一给所有 group 都打开）。 */
  onFileDragStart?: (filePath: string) => (e: React.DragEvent) => void;
  /** Drop target on the wrapping group div. The Changes group uses this to
   *  accept files dragged back from user changelists. */
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}

function FileGroup({
  label,
  files,
  expanded,
  groupByDirectory,
  onToggle,
  selectedFiles,
  highlightedFiles,
  onToggleFile,
  onSetFileKeys,
  onHighlightFile,
  onShowDiff,
  onContextMenu,
  onDirContextMenu,
  action,
  onHeaderContextMenu,
  extraClassName,
  boldOverride,
  customLabel,
  onFileDragStart,
  onDragOver,
  onDrop,
}: FileGroupProps) {
  const { collapsedDirs, toggleDir } = useCommitStore();

  // 分组标题本身也是一个 item（树的根节点），文件夹/文件都在它下面正常缩进，
  // 三种行统一走这一份数组 + 一次 .map()，不再分"标题 JSX + 目录树 + 扁平列表"
  const items = useMemo(
    () =>
      buildGroupItems(label, files, expanded, groupByDirectory, collapsedDirs),
    [label, files, expanded, groupByDirectory, collapsedDirs],
  );

  return (
    <div
      className={`commit-group${extraClassName ? ` ${extraClassName}` : ""}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {items.map((item) => {
        if (item.kind === "folder") {
          const { node, depth } = item;
          const isGroupRoot = node.fullPath === "";
          const childKeys = collectFileKeys(node);
          const allChecked =
            childKeys.length > 0 &&
            childKeys.every((k) => selectedFiles.has(k));
          const someChecked = childKeys.some((k) => selectedFiles.has(k));

          return (
            <FolderRow
              key={isGroupRoot ? "__group_root__" : node.fullPath}
              node={node}
              depth={depth}
              collapsed={
                isGroupRoot ? !expanded : collapsedDirs.has(node.fullPath)
              }
              fileCount={countFiles(node)}
              allChecked={allChecked}
              someChecked={someChecked}
              onToggle={isGroupRoot ? onToggle : () => toggleDir(node.fullPath)}
              onCheckboxChange={() => {
                if (allChecked) {
                  onSetFileKeys(childKeys, false);
                } else {
                  onSetFileKeys(childKeys, true);
                }
              }}
              onContextMenu={
                isGroupRoot
                  ? onHeaderContextMenu
                  : (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onDirContextMenu(e, collectDirFiles(node), node.name);
                    }
              }
              action={isGroupRoot ? action : undefined}
              boldOverride={isGroupRoot ? boldOverride : undefined}
              customLabel={isGroupRoot ? customLabel : undefined}
            />
          );
        }

        const { file, depth } = item;
        const key = file.path;
        // 按目录分组时，目录嵌套已经表达了路径，行内只显示文件名；扁平模式下
        // 还是要看到完整相对路径（原来的行为）
        const displayFile = groupByDirectory
          ? { ...file, path: file.path.split("/").pop() || file.path }
          : file;

        return (
          <FileItem
            key={key}
            file={displayFile}
            depth={depth}
            showIndentSlot
            selected={selectedFiles.has(key)}
            highlighted={highlightedFiles.has(key)}
            onToggle={() => onToggleFile(key)}
            onShowDiff={() => onShowDiff(file.path)}
            onContextMenu={(e) => onContextMenu(e, file)}
            onClick={(e) => {
              const mode = e.metaKey || e.ctrlKey ? "toggle" : "single";
              onHighlightFile(key, mode);
            }}
            draggable={!!onFileDragStart}
            onDragStart={onFileDragStart?.(file.path)}
          />
        );
      })}
      {expanded && files.length === 0 && (
        <div className="commit-group-empty">（空）</div>
      )}
    </div>
  );
}

/* ─── Changelist group (lives inside the Commit tab) ──────────── */

interface ChangelistFileGroupProps {
  changelist: Changelist;
  entries: ChangelistFileEntry[];
  expanded: boolean;
  groupByDirectory: boolean;
  selectedFiles: Set<string>;
  highlightedFiles: Set<string>;
  onToggle: () => void;
  onToggleFile: (key: string) => void;
  onSetFileKeys: (keys: string[], selected: boolean) => void;
  onHighlightFile: (key: string, mode: "single" | "toggle") => void;
  onShowDiff: (path: string) => Promise<void>;
  onFileContextMenu: (e: React.MouseEvent, file: WorkingTreeFile) => void;
  onDirContextMenu: (
    e: React.MouseEvent,
    files: WorkingTreeFile[],
    dirName: string,
  ) => void;
  showEmptyChangelists: boolean;
  isActive: boolean;
  onFileDragStart: (filePath: string) => (e: React.DragEvent) => void;
}

function ChangelistFileGroup({
  changelist,
  entries,
  expanded,
  groupByDirectory,
  selectedFiles,
  highlightedFiles,
  onToggle,
  onToggleFile,
  onSetFileKeys,
  onHighlightFile,
  onShowDiff,
  onFileContextMenu,
  onDirContextMenu,
  showEmptyChangelists,
  isActive,
  onFileDragStart,
}: ChangelistFileGroupProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const renamingChangelistId = useCommitStore((s) => s.renamingChangelistId);
  const setRenamingChangelistId = useCommitStore(
    (s) => s.setRenamingChangelistId,
  );
  const renameChangelist = useCommitStore((s) => s.renameChangelist);

  // 主归属（整文件）和 hunk-only 各算一份；只要任一非空就显示整组。
  const wholeEntries = entries.filter((e) => !e.hunkRange);
  const hunkEntries = entries.filter((e) => e.hunkRange);
  if (entries.length === 0 && !showEmptyChangelists) return null;

  const isRenaming = renamingChangelistId === changelist.id;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropHover(false);
    const data = e.dataTransfer.getData("application/x-jetgit-file-paths");
    if (!data) return;
    let paths: string[] = [];
    try {
      paths = JSON.parse(data);
    } catch {
      return;
    }
    for (const p of paths) {
      void useCommitStore.getState().moveFileToChangelist(p, changelist.id);
    }
  };

  const handleHeaderContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleRenameCommit = (newName: string) => {
    setRenamingChangelistId(null);
    const trimmed = newName.trim();
    if (trimmed && trimmed !== changelist.name) {
      void renameChangelist(changelist.id, trimmed);
    }
  };

  const handleRenameCancel = () => {
    setRenamingChangelistId(null);
  };

  return (
    <div
      className={`commit-group changelist-group ${dropHover ? "drop-hover" : ""} ${isActive ? "active" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDropHover(true);
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={handleDrop}
    >
      <FileGroup
        label={changelist.name}
        files={wholeEntries.map((e) => e.file)}
        expanded={expanded}
        groupByDirectory={groupByDirectory}
        onToggle={onToggle}
        selectedFiles={selectedFiles}
        highlightedFiles={highlightedFiles}
        onToggleFile={onToggleFile}
        onSetFileKeys={onSetFileKeys}
        onHighlightFile={onHighlightFile}
        onShowDiff={onShowDiff}
        onContextMenu={onFileContextMenu}
        onDirContextMenu={onDirContextMenu}
        onHeaderContextMenu={handleHeaderContextMenu}
        boldOverride={isActive}
        onFileDragStart={onFileDragStart}
        customLabel={
          isRenaming ? (
            <ChangelistRenameInput
              initialName={changelist.name}
              onCommit={handleRenameCommit}
              onCancel={handleRenameCancel}
            />
          ) : undefined
        }
      />

      {/* Hunk-only entries (Finding 3): same file but only a subset of hunks
          belongs to this changelist. Show them as flat rows with a line-range
          suffix so users can tell which part of the file is scoped here. */}
      {expanded && hunkEntries.length > 0 && (
        <div className="changelist-hunk-only">
          {hunkEntries.map((entry) => (
            <ChangelistHunkRow
              key={`${entry.file.path}-${entry.hunkRange?.startLine}-${entry.hunkRange?.endLine}`}
              entry={entry}
              dimmed={!isActive}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onFileContextMenu(e, entry.file);
              }}
              onShowDiff={() => onShowDiff(entry.file.path)}
            />
          ))}
        </div>
      )}

      {expanded && entries.length === 0 && (
        <div className="changelist-empty">（空）</div>
      )}

      {contextMenu && (
        <ChangelistContextMenu
          changelist={changelist}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

interface ChangelistHunkRowProps {
  entry: ChangelistFileEntry;
  dimmed: boolean;
  /** User changelists show their hunk rows as secondary annotations (italic);
   *  the default "Changes" group shows its implicit-default hunks as primary
   *  entries (normal weight). Defaults to italic for the user-list path. */
  italic?: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  onShowDiff: () => void;
}

/**
 * Inline rename editor rendered in place of the changelist header label while
 * `renamingChangelistId === this.id`. Auto-focuses and selects-all on mount so
 * the user can either accept the suggested "ChangelistN" by typing over it or
 * blur to confirm. Enter commits, Escape cancels, blur also commits (the
 * standard pattern for inline-rename fields in IDE-style UIs).
 */
function ChangelistRenameInput({
  initialName,
  onCommit,
  onCancel,
}: {
  initialName: string;
  onCommit: (newName: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      className="commit-tree-label-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      // Blur also commits — standard inline-rename UX (clicking away means
      // "I'm done"). Enter / Escape above take precedence because they fire
      // before blur and short-circuit the commit.
      onBlur={() => onCommit(value)}
      // Clicks inside the input must not toggle the group expansion — the
      // outer FolderRow catches onClick. Both stopPropagation calls are
      // needed: mousedown for selection-start, click for the synthesized
      // click that fires after mouseup.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      spellCheck={false}
    />
  );
}

function ChangelistHunkRow({
  entry,
  dimmed,
  italic = true,
  onContextMenu,
  onShowDiff,
}: ChangelistHunkRowProps) {
  const { file, hunkRange } = entry;
  if (!hunkRange) return null;
  return (
    <div
      className={`commit-tree-row changelist-hunk-row ${dimmed ? "changelist-inactive-file" : ""} ${italic ? "" : "changelist-hunk-row--primary"}`}
      style={{ paddingLeft: 24 }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(
          "application/x-jetgit-file-paths",
          JSON.stringify([file.path]),
        );
      }}
      onClick={onShowDiff}
      onContextMenu={onContextMenu}
    >
      <span
        className="commit-file-status"
        style={{ color: "var(--vscode-descriptionForeground)" }}
        title="Hunk-only assignment"
      >
        H
      </span>
      <span className="commit-tree-label grow" title={file.path}>
        {file.path}
      </span>
      <span className="changelist-file-hunk">
        Lines {hunkRange.startLine}–{hunkRange.endLine}
      </span>
    </div>
  );
}

/* ─── Background Context Menu ─────────────────────────────────────── */

function BackgroundContextMenu({
  x,
  y,
  onClose,
}: {
  x: number;
  y: number;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: y,
    left: x,
  });
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);

  // 读 store 而不是用 useCommitStore.getState()：disabled 是渲染期的属性，
  // hook 订阅能让菜单每次重开时都拿到最新的 active / isDefault。
  const { changelists, activeChangelistId } = useCommitStore();
  const activeChangelist = changelists.find((c) => c.id === activeChangelistId);
  const canEditComment = !!activeChangelist && !activeChangelist.isDefault;

  // Re-position so the menu stays inside the viewport on smaller windows.
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;
      let top = y;
      let left = x;
      if (top + rect.height > viewportH) {
        const above = y - rect.height;
        top = above >= 4 ? above : Math.max(4, viewportH - rect.height - 4);
      }
      if (left + rect.width > viewportW) {
        left = Math.max(4, viewportW - rect.width - 4);
      }
      setPosition({ top, left });
    });
  }, [x, y]);

  // Close on outside click / Escape / blur / scroll. Submenu hover lives in a
  // separate useEffect below so opening/closing it doesn't tear down the
  // outer dismissal listeners.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleBlur = () => onClose();
    const handleScroll = (e: Event) => {
      if (
        menuRef.current &&
        e.target instanceof Node &&
        !menuRef.current.contains(e.target)
      )
        onClose();
    };
    document.addEventListener("mousedown", handleClick, true);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleBlur);
    return () => {
      document.removeEventListener("mousedown", handleClick, true);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleBlur);
    };
  }, [onClose]);

  const handleNew = useCallback(() => {
    onClose();
    (async () => {
      // Auto-name with the smallest free "ChangelistN" — never ask the user
      // to type a name up front. Drop straight into inline rename mode so
      // they can fix the placeholder immediately (or just hit Enter to
      // accept it). The input element is owned by ChangelistFileGroup, which
      // watches `renamingChangelistId` from the store.
      const created = await useCommitStore.getState().createChangelistAuto();
      if (created) {
        useCommitStore.getState().setRenamingChangelistId(created.id);
      }
    })();
  }, [onClose]);

  const handleEditComment = useCallback(() => {
    const { activeChangelistId, changelists, setChangelistComment } =
      useCommitStore.getState();
    if (!activeChangelistId) return;
    const active = changelists.find((c) => c.id === activeChangelistId);
    if (!active || active.isDefault) return;
    const comment = window.prompt("Edit comment:", active.comment);
    onClose();
    if (comment === null) return;
    void setChangelistComment(active.id, comment);
  }, [onClose]);

  return (
    <div
      className="commit-context-menu"
      ref={menuRef}
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        zIndex: 1000,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleNew}
      >
        <AddIcon className="commit-context-menu-icon" />
        <span>New Changelist...</span>
      </button>

      <SetActiveChangelistItem
        onClose={onClose}
        activeSubmenu={activeSubmenu}
        setActiveSubmenu={setActiveSubmenu}
      />

      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleEditComment}
        disabled={!canEditComment}
        title={
          canEditComment
            ? undefined
            : "The default changelist has no editable comment"
        }
      >
        <EditIcon className="commit-context-menu-icon" />
        <span>Edit Comment...</span>
      </button>
    </div>
  );
}

/**
 * Single menu row "Set Active Changelist" with a hover-driven submenu listing
 * every changelist (including the built-in default "Changes"). Selecting one
 * runs setActiveChangelist; the currently active row shows a checkmark.
 *
 * NOTE: only real changelists from the store appear here. UNVERSIONED FILES
 * is a *virtual* display group rendered by FileGroup for untracked files —
 * it is never a member of `changelists` and therefore never appears in this
 * submenu. The default "Changes" changelist *does* appear (any list,
 * including the default, can be the active one).
 *
 * Hover-to-open mirrors the rest of the Commit panel's context menus and
 * keeps keyboard / click-on-title semantics simple — the parent row is
 * not itself clickable, so a stray click won't switch the active changelist
 * the way an accidental tap on a normal button would.
 */
function SetActiveChangelistItem({
  onClose,
  activeSubmenu,
  setActiveSubmenu,
}: {
  onClose: () => void;
  activeSubmenu: string | null;
  setActiveSubmenu: (id: string | null) => void;
}) {
  const { changelists, activeChangelistId } = useCommitStore();
  const isOpen = activeSubmenu === "set-active";

  return (
    <div
      className="commit-context-menu-item commit-context-menu-submenu-trigger"
      onMouseEnter={() => setActiveSubmenu("set-active")}
      onMouseLeave={() => {
        // Close on leave, but only if no nested item is being hovered (the
        // submenu itself owns its own hover state via document mousemove).
        if (activeSubmenu === "set-active") setActiveSubmenu(null);
      }}
    >
      <span className="commit-context-menu-icon-placeholder" />
      <span>Set Active Changelist</span>
      <span className="commit-context-menu-shortcut">▸</span>
      {isOpen && (
        <div
          className="commit-context-submenu"
          onMouseEnter={() => setActiveSubmenu("set-active")}
          onMouseLeave={() => setActiveSubmenu(null)}
        >
          {changelists.map((c) => (
            <ChangelistSubmenuRow
              key={c.id}
              changelist={c}
              isActive={c.id === activeChangelistId}
              onPick={() => {
                onClose();
                void useCommitStore.getState().setActiveChangelist(c.id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChangelistSubmenuRow({
  changelist,
  isActive,
  onPick,
}: {
  changelist: Changelist;
  isActive: boolean;
  onPick: () => void;
}) {
  // Default changelist is always selectable — only the inline "Edit Comment…"
  // action is disabled for it (because the default has no editable comment
  // field on the backend).
  return (
    <button type="button" className="commit-context-menu-item" onClick={onPick}>
      <span className="commit-context-menu-icon">
        {isActive ? <CheckIcon /> : null}
      </span>
      <span>
        {changelist.name}
        {changelist.isDefault ? " (default)" : ""}
      </span>
    </button>
  );
}

/* ─── Directory Context Menu ─────────────────────────────────────── */

function DirContextMenu({
  x,
  y,
  files,
  dirName,
  onClose,
}: {
  x: number;
  y: number;
  files: WorkingTreeFile[];
  dirName: string;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: y,
    left: x,
  });

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;
      let top = y;
      let left = x;
      if (top + rect.height > viewportH) {
        const above = y - rect.height;
        top = above >= 4 ? above : Math.max(4, viewportH - rect.height - 4);
      }
      if (left + rect.width > viewportW) {
        left = Math.max(4, viewportW - rect.width - 4);
      }
      setPosition({ top, left });
    });
  }, [x, y]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleScroll = (e: Event) => {
      if (
        menuRef.current &&
        e.target instanceof Node &&
        !menuRef.current.contains(e.target)
      )
        onClose();
    };
    document.addEventListener("mousedown", handleClick, true);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("blur", onClose);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", handleClick, true);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("blur", onClose);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const handleDelete = useCallback(() => {
    const paths = files.map((f) => f.path);
    import("../../shared/bridge").then(({ bridge }) => {
      bridge.request("deleteFiles", { filePaths: paths });
    });
    onClose();
  }, [files, onClose]);

  const handleRollback = useCallback(() => {
    const paths = files.map((f) => f.path);
    import("../../shared/bridge").then(({ bridge }) => {
      bridge.request("rollbackFiles", { filePaths: paths });
    });
    onClose();
  }, [files, onClose]);

  const handleOpenInSystemFolder = useCallback(() => {
    const firstFile = files[0];
    if (firstFile) {
      import("../../shared/bridge").then(({ bridge }) => {
        bridge.request("revealInSystemExplorer", { filePath: firstFile.path });
      });
    }
    onClose();
  }, [files, onClose]);

  return (
    <div
      className="commit-context-menu"
      ref={menuRef}
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        zIndex: 1000,
      }}
    >
      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleRollback}
      >
        <RollbackIcon className="commit-context-menu-icon" />
        <span>Rollback...</span>
      </button>

      <div className="commit-context-menu-separator" />

      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleOpenInSystemFolder}
      >
        <FolderWhiteIcon className="commit-context-menu-icon" />
        <span>Open in System Folder</span>
      </button>

      <div className="commit-context-menu-separator" />

      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleDelete}
      >
        <DeleteIcon className="commit-context-menu-icon" />
        <span>Delete "{dirName}"...</span>
        <span className="commit-context-menu-shortcut">⌫</span>
      </button>
    </div>
  );
}
