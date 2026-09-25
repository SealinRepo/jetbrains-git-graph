import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Changelist } from "../../../../shared/types/changelists";
import { ChangelistContextMenu } from "../../changelists/ChangelistContextMenu";
import { HunkAssignmentDialog } from "../../changelists/HunkAssignmentDialog";
import { bridge } from "../../shared/bridge";
import {
  DeleteIcon,
  FolderWhiteIcon,
  RollbackIcon,
} from "../../shared/components/Icons";
import {
  type ChangelistFileEntry,
  computeChangelistFiles,
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

  // Group files: Changes (tracked, modified) vs Unversioned Files (untracked)
  const { changedFiles, untrackedFiles, conflictedFiles } = useMemo(() => {
    const changed: WorkingTreeFile[] = [];
    const untracked: WorkingTreeFile[] = [];
    const conflicted: WorkingTreeFile[] = [];

    for (const file of changes) {
      if (file.status === "conflicted") {
        conflicted.push(file);
      } else if (file.status === "untracked") {
        untracked.push(file);
      } else {
        changed.push(file);
      }
    }
    return {
      changedFiles: changed,
      untrackedFiles: untracked,
      conflictedFiles: conflicted,
    };
  }, [changes]);

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
    },
    [],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const closeDirContextMenu = useCallback(() => {
    setDirContextMenu(null);
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

      <div className="commit-file-list">
        {toastVisible && (
          <div className="changelist-toast" role="status">
            {toastVisible}
          </div>
        )}

        {/* Merge Conflicts */}
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

        {/* Changes (tracked, modified) */}
        {changedFiles.length > 0 && (
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
          />
        )}

        {/* Unversioned Files */}
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
          />
        );
      })}
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
}: ChangelistFileGroupProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [dropHover, setDropHover] = useState(false);

  // 主归属（整文件）和 hunk-only 各算一份；只要任一非空就显示整组。
  const wholeEntries = entries.filter((e) => !e.hunkRange);
  const hunkEntries = entries.filter((e) => e.hunkRange);
  if (entries.length === 0 && !showEmptyChangelists) return null;

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

  return (
    <div
      className={`commit-group changelist-group ${dropHover ? "drop-hover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDropHover(true);
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={handleDrop}
    >
      <FileGroup
        label={changelist.name + (isActive ? " ●" : "")}
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
  onContextMenu: (e: React.MouseEvent) => void;
  onShowDiff: () => void;
}

function ChangelistHunkRow({
  entry,
  dimmed,
  onContextMenu,
  onShowDiff,
}: ChangelistHunkRowProps) {
  const { file, hunkRange } = entry;
  if (!hunkRange) return null;
  return (
    <div
      className={`commit-tree-row changelist-hunk-row ${dimmed ? "changelist-inactive-file" : ""}`}
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
