import { useCommitStore } from "../shared/store/commit-store";

export function ChangelistDropdown() {
  const changelists = useCommitStore((s) => s.changelists);
  const activeId = useCommitStore((s) => s.activeChangelistId);
  const setActive = useCommitStore((s) => s.setActiveChangelist);

  return (
    <div className="changelist-dropdown">
      <label>Active:</label>
      <select
        value={activeId ?? ""}
        onChange={(e) => void setActive(e.target.value)}
      >
        {changelists.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.isDefault ? " (default)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
