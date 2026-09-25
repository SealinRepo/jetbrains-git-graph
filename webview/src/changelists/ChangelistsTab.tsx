import { useEffect, useMemo, useState } from "react";
import type { WorkingTreeFile } from "../shared/store/commit-store";
import { useCommitStore } from "../shared/store/commit-store";
import { ChangelistDropdown } from "./ChangelistDropdown";
import { ChangelistGroup } from "./ChangelistGroup";
import { HunkAssignmentDialog } from "./HunkAssignmentDialog";

/** Spec §7.4 / Finding 3: a file can appear under multiple changelists via
 *  hunk-mode assignments. We thread the optional line range through so each
 *  ChangelistGroup can render a "Lines X–Y" prefix when needed. */
export interface ChangelistFileEntry {
  file: WorkingTreeFile;
  hunkRange?: { startLine: number; endLine: number };
}

const TOAST_DURATION_MS = 5000;

export function ChangelistsTab() {
  const changelists = useCommitStore((s) => s.changelists);
  const activeId = useCommitStore((s) => s.activeChangelistId);
  const defaultId = useCommitStore((s) => s.defaultChangelistId);
  const assignments = useCommitStore((s) => s.assignments);
  const changes = useCommitStore((s) => s.changes);
  const settings = useCommitStore((s) => s.changelistSettings);
  const createChangelist = useCommitStore((s) => s.createChangelist);
  const hunkDialogFile = useCommitStore((s) => s.hunkDialogFile);
  const closeHunkDialog = useCommitStore((s) => s.closeHunkDialog);
  const hunkInvalidationToast = useCommitStore((s) => s.hunkInvalidationToast);
  const clearHunkInvalidationToast = useCommitStore(
    (s) => s.clearHunkInvalidationToast,
  );

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

  const untrackedPaths = useMemo(
    () =>
      new Set(
        changes.filter((f) => f.status === "untracked").map((f) => f.path),
      ),
    [changes],
  );

  // 把 changes 按归属拆到各列表。每个变更列表可能因为行级 hunk 分配而
  // 出现同一文件的多个 bucket（hunkRange 不同）。
  const grouped = useMemo(() => {
    const out = new Map<string, ChangelistFileEntry[]>();
    for (const c of changelists) out.set(c.id, []);
    out.set("__unversioned__", []);

    for (const file of changes) {
      const a = assignments[file.path];
      if (untrackedPaths.has(file.path) && !a) {
        out.get("__unversioned__")?.push({ file });
        continue;
      }
      const listId = a?.changelistId ?? activeId ?? defaultId ?? "";
      if (listId) {
        out.get(listId)?.push({ file });
      }

      // Finding 3: hunk 模式下，同一文件也可能出现在非主归属的变更列表里。
      // 聚合该文件在每个 hunk-changelist 内的行号区间（min start, max end），
      // 渲染为 "Lines X–Y"。
      if (a?.hunks && a.hunks.length > 0) {
        const byChangelist = new Map<
          string,
          { startLine: number; endLine: number }
        >();
        for (const h of a.hunks) {
          const cur = byChangelist.get(h.changelistId);
          if (!cur) {
            byChangelist.set(h.changelistId, {
              startLine: h.startLine,
              endLine: h.endLine,
            });
          } else {
            cur.startLine = Math.min(cur.startLine, h.startLine);
            cur.endLine = Math.max(cur.endLine, h.endLine);
          }
        }
        for (const [changelistId, hunkRange] of byChangelist) {
          // 主归属列表已经按整文件渲染过；这里只补 hunk-changelist 的副本。
          if (changelistId === listId) continue;
          out.get(changelistId)?.push({ file, hunkRange });
        }
      }
    }
    return out;
  }, [changelists, assignments, changes, activeId, defaultId, untrackedPaths]);

  const asyncCreate = async () => {
    const name = window.prompt("New changelist name:");
    if (!name) return;
    await createChangelist(name);
  };

  return (
    <div className="changelists-tab">
      <div className="changelists-toolbar">
        <ChangelistDropdown />
        <button onClick={asyncCreate}>+ New Changelist</button>
      </div>
      {toastVisible && (
        <div className="changelist-toast" role="status">
          {toastVisible}
        </div>
      )}
      {changelists.map((c) => (
        <ChangelistGroup
          key={c.id}
          changelist={c}
          files={grouped.get(c.id) ?? []}
          defaultExpanded={c.id === activeId}
          showEmptyChangelists={settings?.showEmptyChangelists ?? true}
          isActive={c.id === activeId}
        />
      ))}
      <ChangelistGroup
        changelist={{
          id: "__unversioned__",
          name: "Unversioned Files",
          comment: "",
          isDefault: false,
          createdAt: 0,
        }}
        files={grouped.get("__unversioned__") ?? []}
        defaultExpanded={false}
        showEmptyChangelists={true}
        isActive={false}
      />
      {hunkDialogFile && (
        <HunkAssignmentDialog
          filePath={hunkDialogFile}
          onClose={closeHunkDialog}
        />
      )}
    </div>
  );
}
