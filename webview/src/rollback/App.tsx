// 解决行尾编译错误字符
import { useCallback, useEffect, useMemo, useState } from "react";
import CodiconListFlat from "~icons/codicon/list-flat";
import CodiconListTree from "~icons/codicon/list-tree";
import type { RollbackFileInfo } from "../../../shared/protocol";
import { bridge } from "../shared/bridge";
import { FileTree, type FileTreeNode } from "../shared/components/FileTree";
import type { DiffFile } from "../shared/types/git";
import "./rollback.css";

interface RollbackGroup {
  id: string;
  name: string;
  files: RollbackFileInfo[];
}

function getGroupId(file: RollbackFileInfo): string {
  return file.groupId ?? file.changelistId ?? "files";
}

function getTargetKey(file: RollbackFileInfo): string {
  return `${getGroupId(file)}\0${file.path}`;
}

function buildRollbackGroups(files: RollbackFileInfo[]): RollbackGroup[] {
  const groups = new Map<string, RollbackGroup>();
  for (const file of files) {
    const id = getGroupId(file);
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        name: file.groupName ?? "Files",
        files: [],
      };
      groups.set(id, group);
    }
    group.files.push(file);
  }
  return [...groups.values()];
}

/**
 * Collect all leaf file paths under a FileTreeNode (recursively).
 */
function collectLeafPaths(node: FileTreeNode): string[] {
  if (node.isLeaf && node.file) {
    return [node.file.newPath || node.file.oldPath];
  }
  const paths: string[] = [];
  for (const child of node.children) {
    paths.push(...collectLeafPaths(child));
  }
  return paths;
}

export function RollbackApp() {
  const root = document.getElementById("root");
  const initialFilesJson = root?.dataset.files ?? "[]";
  const [files, setFiles] = useState<RollbackFileInfo[]>(() =>
    JSON.parse(initialFilesJson),
  );
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(
    () =>
      new Set(
        (JSON.parse(initialFilesJson) as RollbackFileInfo[]).map(getTargetKey),
      ),
  );
  const [viewMode, setViewMode] = useState<"tree" | "flat">("tree");
  const [collapsed, setCollapsed] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [deleteLocalCopies, setDeleteLocalCopies] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => buildRollbackGroups(files), [files]);

  // Listen for re-init events (when panel is reused)
  useEffect(() => {
    return bridge.onEvent((msg) => {
      if (msg.event === "rollbackPanelInit") {
        const newFiles = msg.data.files;
        setFiles(newFiles);
        setCheckedFiles(new Set(newFiles.map(getTargetKey)));
        setError(null);
        setRolling(false);
        setDeleteLocalCopies(false);
        setCollapsed({});
      }
    });
  }, []);

  const handleToggleFile = useCallback((key: string) => {
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleToggleFiles = useCallback((keys: string[]) => {
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      const allChecked = keys.every((key) => next.has(key));
      for (const key of keys) {
        if (allChecked) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }, []);

  const handleToggleDir = useCallback(
    (groupId: string, dirFiles: string[]) => {
      const keys = dirFiles.map((path) => `${groupId}\0${path}`);
      handleToggleFiles(keys);
    },
    [handleToggleFiles],
  );

  const handleToggleDirectory = useCallback(
    (groupId: string, dirPath: string) => {
      setCollapsed((prev) => ({
        ...prev,
        [groupId]: {
          ...prev[groupId],
          [dirPath]: !prev[groupId]?.[dirPath],
        },
      }));
    },
    [],
  );

  const handleRollback = useCallback(async () => {
    const targets = files
      .filter((file) => checkedFiles.has(getTargetKey(file)))
      .map(({ path, status, changelistId, groupId }) => ({
        path,
        status,
        changelistId,
        groupId,
      }));
    if (targets.length === 0) return;
    setRolling(true);
    setError(null);
    try {
      await bridge.request("executeRollback", {
        targets,
        deleteLocalCopies,
      });
      // Panel will be closed by extension host on success
    } catch (err) {
      setRolling(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [checkedFiles, deleteLocalCopies, files]);

  const handleCancel = useCallback(() => {
    bridge.request("closeRollbackPanel");
  }, []);

  return (
    <div className="rollback-container">
      {/* Header with view mode toggle */}
      <div className="rollback-header">
        <span className="rollback-title">
          {files.length} file{files.length !== 1 ? "s" : ""}
        </span>
        <span className="rollback-view-toggle">
          <button
            type="button"
            className={viewMode === "tree" ? "active" : ""}
            onClick={() => setViewMode("tree")}
            title="Tree View"
          >
            <CodiconListTree />
          </button>
          <button
            type="button"
            className={viewMode === "flat" ? "active" : ""}
            onClick={() => setViewMode("flat")}
            title="Flat List"
          >
            <CodiconListFlat />
          </button>
        </span>
      </div>

      {/* File list with checkboxes */}
      <div className="rollback-file-list">
        {groups.map((group) => (
          <RollbackGroupList
            key={group.id}
            group={group}
            viewMode={viewMode}
            checkedFiles={checkedFiles}
            collapsed={collapsed[group.id] ?? {}}
            onToggleFile={handleToggleFile}
            onToggleFiles={handleToggleFiles}
            onToggleDir={(paths) => handleToggleDir(group.id, paths)}
            onToggleDirectory={(dirPath) =>
              handleToggleDirectory(group.id, dirPath)
            }
          />
        ))}
      </div>

      {/* Footer */}
      <div className="rollback-footer">
        <label className="rollback-delete-option">
          <input
            type="checkbox"
            checked={deleteLocalCopies}
            onChange={() => setDeleteLocalCopies((prev) => !prev)}
          />
          Delete local copies of added files
        </label>
        {error && <span className="rollback-error">{error}</span>}
        <div className="rollback-actions">
          <button
            type="button"
            className="rollback-btn rollback-btn-secondary"
            onClick={handleCancel}
            disabled={rolling}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rollback-btn rollback-btn-primary"
            onClick={handleRollback}
            disabled={rolling || checkedFiles.size === 0}
          >
            {rolling ? "Rolling back..." : "Rollback"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RollbackGroupList({
  group,
  viewMode,
  checkedFiles,
  collapsed,
  onToggleFile,
  onToggleFiles,
  onToggleDir,
  onToggleDirectory,
}: {
  group: RollbackGroup;
  viewMode: "tree" | "flat";
  checkedFiles: Set<string>;
  collapsed: Record<string, boolean>;
  onToggleFile: (key: string) => void;
  onToggleFiles: (keys: string[]) => void;
  onToggleDir: (paths: string[]) => void;
  onToggleDirectory: (dirPath: string) => void;
}) {
  const filesByPath = useMemo(
    () => new Map(group.files.map((file) => [file.path, file])),
    [group.files],
  );
  const diffFiles: DiffFile[] = useMemo(
    () =>
      group.files.map((file) => ({
        oldPath: file.path,
        newPath: file.path,
        status: file.status as DiffFile["status"],
        isBinary: false,
      })),
    [group.files],
  );
  const groupKeys = group.files.map(getTargetKey);
  const allChecked =
    groupKeys.length > 0 && groupKeys.every((key) => checkedFiles.has(key));
  const someChecked =
    !allChecked && groupKeys.some((key) => checkedFiles.has(key));

  return (
    <section className="rollback-group">
      <div className="rollback-group-header">
        <input
          type="checkbox"
          aria-label={`Select all files in ${group.name}`}
          checked={allChecked}
          ref={(element) => {
            if (element) element.indeterminate = someChecked;
          }}
          onChange={() => onToggleFiles(groupKeys)}
          onClick={(event) => event.stopPropagation()}
        />
        <span className="rollback-group-name">{group.name}</span>
        <span className="rollback-group-count">{group.files.length}</span>
      </div>
      <FileTree
        files={diffFiles}
        viewMode={viewMode}
        selectedFiles={[]}
        onFileClick={(_event, file) => {
          const path = file.newPath || file.oldPath;
          const target = filesByPath.get(path);
          if (target) onToggleFile(getTargetKey(target));
        }}
        collapsed={collapsed}
        onToggle={onToggleDirectory}
        renderExtraColumns={(file) => {
          const path = file.newPath || file.oldPath;
          const target = filesByPath.get(path);
          if (!target) return null;
          return (
            <>
              {target.hunkRanges && target.hunkRanges.length > 0 && (
                <span
                  className="rollback-hunk-ranges"
                  title={`Lines ${target.hunkRanges.map((range) => `${range.startLine}-${range.endLine}`).join(", ")}`}
                >
                  Lines{" "}
                  {target.hunkRanges
                    .map((range) => `${range.startLine}-${range.endLine}`)
                    .join(", ")}
                </span>
              )}
              <input
                type="checkbox"
                checked={checkedFiles.has(getTargetKey(target))}
                onChange={() => onToggleFile(getTargetKey(target))}
                onClick={(event) => event.stopPropagation()}
                style={{ order: -1 }}
              />
            </>
          );
        }}
        renderDirExtra={(dirNode) => {
          const paths = collectLeafPaths(dirNode);
          const keys = paths
            .map((path) => filesByPath.get(path))
            .filter((file): file is RollbackFileInfo => file !== undefined)
            .map(getTargetKey);
          const checkedCount = keys.filter((key) =>
            checkedFiles.has(key),
          ).length;
          const directoryChecked =
            keys.length > 0 && checkedCount === keys.length;
          const directoryIndeterminate = checkedCount > 0 && !directoryChecked;
          return (
            <input
              type="checkbox"
              checked={directoryChecked}
              ref={(element) => {
                if (element) element.indeterminate = directoryIndeterminate;
              }}
              onChange={() => onToggleDir(paths)}
              onClick={(event) => event.stopPropagation()}
              style={{ order: -1, marginRight: 4 }}
            />
          );
        }}
      />
    </section>
  );
}
