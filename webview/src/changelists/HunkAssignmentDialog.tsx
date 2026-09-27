import { useEffect, useState } from "react";
import { hunkFingerprint } from "../../../shared/hunkFingerprint";
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
  const assignments = useCommitStore((s) => s.assignments);
  const getFileHunks = useCommitStore((s) => s.getFileHunks);
  const assignHunks = useCommitStore((s) => s.assignHunks);

  const [hunks, setHunks] = useState<HunkInfo[]>([]);
  const [draft, setDraft] = useState<HunkAssignment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const result = await getFileHunks(filePath);
      setHunks(result);
      // 必须从**已登记的分配**回填，而不是一律给 active 列表：这个文件可能已经
      // 被拆到多个列表上了（例如第 10 行在列表 1、第 30 行在默认）。如果默认成
      // active 列表，用户只是进来点开看一下就 Confirm，会把已有的拆分整个覆盖掉。
      const stored = assignments[filePath];
      setDraft(
        result.map((h) => {
          const claimed = (stored?.hunks ?? []).find(
            (c) => !(h.endLine < c.startLine || h.startLine > c.endLine),
          );
          return {
            startLine: h.startLine,
            endLine: h.endLine,
            changelistId: claimed?.changelistId ?? activeId ?? defaultId ?? "",
            // 带上内容指纹，之后编辑文件其它位置导致行号漂移时，这个分配仍然
            // 认得出自己。
            contentHash: hunkFingerprint(h.patchText),
          };
        }),
      );
      setLoading(false);
    })();
  }, [filePath, activeId, defaultId, assignments, getFileHunks]);

  const updateAssignment = (idx: number, changelistId: string) => {
    setDraft((prev) =>
      prev.map((a, i) => (i === idx ? { ...a, changelistId } : a)),
    );
  };

  const confirm = async () => {
    await assignHunks(filePath, draft);
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
                  value={draft[idx]?.changelistId ?? ""}
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
