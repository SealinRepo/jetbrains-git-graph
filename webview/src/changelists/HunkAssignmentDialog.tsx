import { useEffect, useState } from "react";
import type {
  HunkAssignment,
  HunkInfo,
} from "../../../shared/types/changelists";
import { useCommitStore } from "../shared/store/commit-store";

interface Props {
  filePath: string;
  onClose: () => void;
}

export function HunkAssignmentDialog({ filePath, onClose }: Props) {
  const changelists = useCommitStore((s) => s.changelists);
  const activeId = useCommitStore((s) => s.activeChangelistId);
  const defaultId = useCommitStore((s) => s.defaultChangelistId);
  const getFileHunks = useCommitStore((s) => s.getFileHunks);
  const assignHunks = useCommitStore((s) => s.assignHunks);

  const [hunks, setHunks] = useState<HunkInfo[]>([]);
  const [assignments, setAssignments] = useState<HunkAssignment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const result = await getFileHunks(filePath);
      setHunks(result);
      setAssignments(
        result.map((h) => ({
          startLine: h.startLine,
          endLine: h.endLine,
          changelistId: activeId ?? defaultId ?? "",
        })),
      );
      setLoading(false);
    })();
  }, [filePath, activeId, defaultId, getFileHunks]);

  const updateAssignment = (idx: number, changelistId: string) => {
    setAssignments((prev) =>
      prev.map((a, i) => (i === idx ? { ...a, changelistId } : a)),
    );
  };

  const confirm = async () => {
    await assignHunks(filePath, assignments);
    onClose();
  };

  return (
    <div className="hunk-dialog-overlay" onClick={onClose}>
      <div className="hunk-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Assign Hunks — {filePath}</h3>
        {loading ? (
          <div>Loading hunks…</div>
        ) : hunks.length === 0 ? (
          <div>该文件没有变更的 hunk</div>
        ) : (
          <div className="hunk-list">
            {hunks.map((h, idx) => (
              <div key={`${h.startLine}-${h.endLine}`} className="hunk-row">
                <div className="hunk-range">
                  Lines {h.startLine}–{h.endLine}
                </div>
                <pre className="hunk-preview">
                  {h.patchText.split("\n").slice(0, 8).join("\n")}
                </pre>
                <select
                  value={assignments[idx]?.changelistId ?? ""}
                  onChange={(e) => updateAssignment(idx, e.target.value)}
                >
                  {changelists.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.isDefault ? " (default)" : ""}
                      {c.id === activeId ? " — Active" : ""}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
        <div className="hunk-dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button onClick={confirm} disabled={loading || hunks.length === 0}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
