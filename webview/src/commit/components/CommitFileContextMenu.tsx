import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../../shared/bridge";
import {
  AddIcon,
  DeleteIcon,
  DiffIcon,
  FolderWhiteIcon,
  JumpIcon,
  RollbackIcon,
  ShelveIcon,
} from "../../shared/components/Icons";
import type { WorkingTreeFile } from "../../shared/store/commit-store";
import { useCommitStore } from "../../shared/store/commit-store";

interface CommitFileContextMenuProps {
  x: number;
  y: number;
  file: WorkingTreeFile;
  onClose: () => void;
}

export function CommitFileContextMenu({
  x,
  y,
  file,
  onClose,
}: CommitFileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const {
    stageFile,
    rollbackFile,
    showDiff,
    shelveChanges,
    highlightedFiles,
    changes,
  } = useCommitStore();

  // Close on outside click, Escape, blur, or scroll
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
      ) {
        onClose();
      }
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

  // Position adjustment to keep menu in viewport
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  }>({ top: y, left: x });

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

  const style: React.CSSProperties = {
    position: "fixed",
    left: position.left,
    top: position.top,
    zIndex: 1000,
  };

  const handleShowDiff = useCallback(() => {
    showDiff(file.path);
    onClose();
  }, [file, showDiff, onClose]);

  const handleAddToVcs = useCallback(() => {
    stageFile(file.path, false);
    onClose();
  }, [file, stageFile, onClose]);

  const handleCompareWithRevision = useCallback(async () => {
    const result = (await bridge.request("showInputBox", {
      prompt: `Compare ${file.path} with revision:`,
      placeHolder: "main, HEAD~1, v1.2.3, <hash>",
      value: "HEAD",
    })) as { value: string | null };
    if (!result?.value || !result.value.trim()) {
      onClose();
      return;
    }
    await bridge.request("compareFileWithRevision", {
      filePath: file.path,
      ref: result.value.trim(),
    });
    onClose();
  }, [file, onClose]);

  const handleShowHistory = useCallback(async () => {
    await bridge.request("showFileHistory", { file: file.path });
    onClose();
  }, [file, onClose]);

  const handleAnnotate = useCallback(async () => {
    await bridge.request("annotateFile", { filePath: file.path });
    onClose();
  }, [file, onClose]);

  const handleRollback = useCallback(() => {
    rollbackFile(file.path);
    onClose();
  }, [file, rollbackFile, onClose]);

  const handleShelve = useCallback(() => {
    // If multiple files are highlighted, shelve all of them; otherwise just this file
    if (highlightedFiles.size > 1 && highlightedFiles.has(file.path)) {
      // Shelve all highlighted files
      const paths = changes
        .filter((f) => highlightedFiles.has(f.path))
        .map((f) => f.path);
      shelveChanges("Shelved changes", [...new Set(paths)]);
    } else {
      // Shelve only this file
      shelveChanges("Shelved changes", [file.path]);
    }
    onClose();
  }, [file, shelveChanges, highlightedFiles, changes, onClose]);

  const handleDelete = useCallback(() => {
    if (highlightedFiles.size > 1 && highlightedFiles.has(file.path)) {
      const paths = changes
        .filter((f) => highlightedFiles.has(f.path))
        .map((f) => f.path);
      import("../../shared/bridge").then(({ bridge }) => {
        bridge.request("deleteFiles", { filePaths: [...new Set(paths)] });
      });
    } else {
      import("../../shared/bridge").then(({ bridge }) => {
        bridge.request("deleteFiles", { filePaths: [file.path] });
      });
    }
    onClose();
  }, [file, highlightedFiles, changes, onClose]);

  const handleJumpToSource = useCallback(() => {
    import("../../shared/bridge").then(({ bridge }) => {
      bridge.request("openFile", { filePath: file.path });
    });
    onClose();
  }, [file, onClose]);

  const canRollback =
    file.status !== "untracked" &&
    file.status !== "added" &&
    file.status !== "deleted";

  const handleOpenInSystemFolder = useCallback(() => {
    import("../../shared/bridge").then(({ bridge }) => {
      bridge.request("revealInSystemExplorer", { filePath: file.path });
    });
    onClose();
  }, [file, onClose]);

  return (
    <div className="commit-context-menu" ref={menuRef} style={style}>
      {/* Show Diff */}
      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleShowDiff}
      >
        <DiffIcon className="commit-context-menu-icon" />
        <span>Show Diff</span>
        <span className="commit-context-menu-shortcut">⌘D</span>
      </button>

      {/* Compare with... */}
      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleCompareWithRevision}
      >
        <DiffIcon className="commit-context-menu-icon" />
        <span>Compare with...</span>
      </button>

      {/* Show History */}
      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleShowHistory}
      >
        <JumpIcon className="commit-context-menu-icon" />
        <span>Show History</span>
      </button>

      {/* Annotate */}
      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleAnnotate}
      >
        <JumpIcon className="commit-context-menu-icon" />
        <span>Annotate</span>
      </button>

      {/* Jump to Source */}
      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleJumpToSource}
      >
        <JumpIcon className="commit-context-menu-icon" />
        <span>Jump to Source</span>
      </button>

      {/* Open in System Folder */}
      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleOpenInSystemFolder}
      >
        <FolderWhiteIcon className="commit-context-menu-icon" />
        <span>Open in System Folder</span>
      </button>

      <div className="commit-context-menu-separator" />

      {/* Add to VCS：不判断是否已经暂存过，无条件对这个文件跑 git add */}
      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleAddToVcs}
        disabled={file.status !== "untracked" && file.status !== "added"}
      >
        <AddIcon className="commit-context-menu-icon" />
        <span>Add to VCS</span>
        <span className="commit-context-menu-shortcut">⌥⌘A</span>
      </button>

      {/* Rollback */}
      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleRollback}
        disabled={!canRollback}
      >
        <RollbackIcon className="commit-context-menu-icon" />
        <span>Rollback...</span>
        <span className="commit-context-menu-shortcut">⌥⌘Z</span>
      </button>

      <div className="commit-context-menu-separator" />

      {/* Shelve */}
      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleShelve}
      >
        <ShelveIcon className="commit-context-menu-icon" />
        <span>Shelve Changes...</span>
      </button>

      <div className="commit-context-menu-separator" />

      {/* Delete */}
      <button
        type="button"
        className="commit-context-menu-item"
        onClick={handleDelete}
      >
        <DeleteIcon className="commit-context-menu-icon" />
        <span>Delete...</span>
        <span className="commit-context-menu-shortcut">⌫</span>
      </button>
    </div>
  );
}
