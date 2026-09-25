import { useMemo } from "react";
import { useCommitStore } from "../shared/store/commit-store";
import { ChangelistDropdown } from "./ChangelistDropdown";
import { ChangelistGroup } from "./ChangelistGroup";

export function ChangelistsTab() {
  const changelists = useCommitStore((s) => s.changelists);
  const activeId = useCommitStore((s) => s.activeChangelistId);
  const defaultId = useCommitStore((s) => s.defaultChangelistId);
  const assignments = useCommitStore((s) => s.assignments);
  const changes = useCommitStore((s) => s.changes);
  const settings = useCommitStore((s) => s.changelistSettings);
  const createChangelist = useCommitStore((s) => s.createChangelist);

  const untrackedPaths = useMemo(
    () => new Set(changes.filter((f) => f.status === "untracked").map((f) => f.path)),
    [changes],
  );

  // 把 changes 按归属拆到各列表
  const grouped = useMemo(() => {
    const out = new Map<string, typeof changes>();
    for (const c of changelists) out.set(c.id, []);
    out.set("__unversioned__", []);

    for (const file of changes) {
      const a = assignments[file.path];
      if (untrackedPaths.has(file.path) && !a) {
        out.get("__unversioned__")!.push(file);
        continue;
      }
      const listId = a?.changelistId ?? activeId ?? defaultId ?? "";
      if (!listId) continue;
      out.get(listId)?.push(file);
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
      {changelists.map((c) => (
        <ChangelistGroup
          key={c.id}
          changelist={c}
          files={grouped.get(c.id) ?? []}
          defaultExpanded={c.id === activeId}
          showEmptyChangelists={settings?.showEmptyChangelists ?? true}
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
      />
    </div>
  );
}