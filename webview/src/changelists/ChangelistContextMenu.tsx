import { useMemo } from "react";
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
  const renameChangelist = useCommitStore((s) => s.renameChangelist);
  const setComment = useCommitStore((s) => s.setChangelistComment);
  const setActive = useCommitStore((s) => s.setActiveChangelist);
  const deleteChangelist = useCommitStore((s) => s.deleteChangelist);
  const commitChangelist = useCommitStore((s) => s.commitChangelist);
  const shelveChangelist = useCommitStore((s) => s.shelveChangelist);
  const createPatch = useCommitStore((s) => s.createPatchFromChangelist);
  const showDiff = useCommitStore((s) => s.showDiff);

  const rename = async () => {
    const name = window.prompt("Rename changelist:", changelist.name);
    onClose();
    if (name && name !== changelist.name) {
      await renameChangelist(changelist.id, name);
    }
  };

  const editComment = async () => {
    const comment = window.prompt("Edit comment:", changelist.comment);
    onClose();
    if (comment !== null) {
      await setComment(changelist.id, comment);
    }
  };

  const setAsActive = async () => {
    onClose();
    await setActive(changelist.id);
  };

  const del = async () => {
    if (changelist.isDefault) return;
    if (
      !window.confirm(
        `Delete changelist "${changelist.name}"? Files will move to default.`,
      )
    ) {
      onClose();
      return;
    }
    onClose();
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

  const newList = async () => {
    onClose();
    const name = window.prompt("New changelist name:");
    if (!name) return;
    await useCommitStore.getState().createChangelist(name);
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
      className="context-menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="context-menu-item" onClick={newList}>
        New Changelist…
      </div>
      <div className="context-menu-item" onClick={rename}>
        Rename…
      </div>
      <div className="context-menu-item" onClick={editComment}>
        Edit Comment…
      </div>
      <div className="context-menu-item" onClick={setAsActive}>
        Set as Active
      </div>
      <div
        className="context-menu-item disabled"
        data-disabled={changelist.isDefault}
        onClick={del}
      >
        Delete Changelist
      </div>
      <div className="context-menu-separator" />
      <div className="context-menu-item" onClick={shelve}>
        Shelve Changelist…
      </div>
      <div className="context-menu-item" onClick={patch}>
        Create Patch…
      </div>
      <div className="context-menu-separator" />
      <div className="context-menu-item" onClick={commit}>
        Commit This Changelist
      </div>
      <div className="context-menu-item" onClick={showDiffClicked}>
        Show Diff
      </div>
    </div>
  );
}
