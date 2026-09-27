import { useEffect, useMemo, useRef, useState } from "react";
import type { Changelist } from "../../../shared/types/changelists";
import { bridge } from "../shared/bridge";
import { useCommitStore } from "../shared/store/commit-store";

interface Props {
  changelist: Changelist;
  x: number;
  y: number;
  onClose: () => void;
}

export function ChangelistContextMenu({ changelist, x, y, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: y,
    left: x,
  });

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

  // Close on outside click / Escape / blur / scroll. Necessary because the
  // menu is now opened from inside the dense Commit panel (vs. the original
  // dedicated tab), so users need a way to dismiss it without picking an
  // action they may not want.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
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

  const setRenamingChangelistId = useCommitStore(
    (s) => s.setRenamingChangelistId,
  );
  const setActive = useCommitStore((s) => s.setActiveChangelist);
  const deleteChangelist = useCommitStore((s) => s.deleteChangelist);
  const commitChangelist = useCommitStore((s) => s.commitChangelist);
  const shelveChangelist = useCommitStore((s) => s.shelveChangelist);
  const createPatch = useCommitStore((s) => s.createPatchFromChangelist);
  const showDiff = useCommitStore((s) => s.showDiff);

  const rename = () => {
    // 复用 ChangelistFileGroup 里已有的内联重命名机制：把 renamingChangelistId
    // 设成当前列表的 id，inline 编辑器（auto-focus + select-all + Enter
    // 提交 / Escape 取消 / blur 提交）就会就地出现在列表头。
    setRenamingChangelistId(changelist.id);
    onClose();
  };

  const setAsActive = async () => {
    onClose();
    await setActive(changelist.id);
  };

  const del = async () => {
    if (changelist.isDefault) return;
    onClose();
    // VS Code webviews silently swallow window.confirm, so route the
    // confirmation through the bridge (showConfirmMessage → vscode modal).
    const result = (await bridge.request("showConfirmMessage", {
      message: `Delete changelist "${changelist.name}"? Files will move to default.`,
      confirmLabel: "Delete",
    })) as { confirmed: boolean };
    if (!result.confirmed) return;
    await deleteChangelist(changelist.id);
  };

  const commit = async () => {
    onClose();
    const prefill = changelist.comment || "";
    const message = window.prompt("Commit message:", prefill);
    if (message === null) return;
    await commitChangelist(changelist.id, message);
  };

  const shelve = async () => {
    onClose();
    const message = window.prompt("Shelf message (optional):");
    await shelveChangelist(changelist.id, message ?? undefined);
  };

  const patch = async () => {
    onClose();
    await createPatch(changelist.id);
  };

  // AC-2 / Finding 4: collect every file belonging to this changelist so the
  // menu can iterate showDiff per file. Mirrors ChangelistsTab's bucketing:
  // whole-file assignments (explicit + implicit via active) plus any file
  // whose hunk assignments target this changelist.
  const showDiffForChangelist = useMemo(() => {
    return () => {
      const state = useCommitStore.getState();
      const changes = state.changes;
      const assignments = state.assignments;
      const activeId = state.activeChangelistId;
      const defaultId = state.defaultChangelistId;
      const untrackedPaths = new Set(
        changes.filter((f) => f.status === "untracked").map((f) => f.path),
      );
      const paths = new Set<string>();
      for (const file of changes) {
        const a = assignments[file.path];
        if (untrackedPaths.has(file.path) && !a) continue;
        const primaryId = a?.changelistId ?? activeId ?? defaultId ?? "";
        const wholeBelongs = primaryId === changelist.id;
        const hunkBelongs =
          a?.hunks?.some((h) => h.changelistId === changelist.id) ?? false;
        if (wholeBelongs || hunkBelongs) paths.add(file.path);
      }
      return paths;
    };
  }, [changelist.id]);

  const showDiffClicked = async () => {
    onClose();
    const paths = showDiffForChangelist();
    if (paths.size === 0) {
      void bridge.request("showErrorNotification", {
        message: "该变更列表内没有文件可显示差异",
      });
      return;
    }
    // Sequential calls: each opens its own diff editor tab. Existing
    // showDiffForWorkingFile is the supported entry point — opening a single
    // merged-diff view across multiple files is out of scope for this fix
    // wave (spec acknowledges the trade-off).
    for (const p of paths) {
      await showDiff(p);
    }
  };

  return (
    <div
      ref={menuRef}
      className="commit-context-menu"
      style={{ left: position.left, top: position.top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="commit-context-menu-item" onClick={rename}>
        Rename…
      </div>
      <div className="commit-context-menu-item" onClick={setAsActive}>
        Set as Active
      </div>
      <div
        className={`commit-context-menu-item${changelist.isDefault ? " disabled" : ""}`}
        onClick={del}
        title={
          changelist.isDefault
            ? "The default changelist cannot be deleted"
            : undefined
        }
      >
        Delete Changelist
      </div>
      <div className="commit-context-menu-separator" />
      <div className="commit-context-menu-item" onClick={shelve}>
        Shelve Changelist…
      </div>
      <div className="commit-context-menu-item" onClick={patch}>
        Create Patch…
      </div>
      <div className="commit-context-menu-separator" />
      <div className="commit-context-menu-item" onClick={commit}>
        Commit This Changelist
      </div>
      <div className="commit-context-menu-item" onClick={showDiffClicked}>
        Show Diff
      </div>
    </div>
  );
}
