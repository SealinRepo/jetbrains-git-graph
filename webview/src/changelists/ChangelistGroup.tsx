import { useState } from "react";
import type { Changelist } from "../../../shared/types/changelists";
import { useCommitStore } from "../shared/store/commit-store";
import { ChangelistContextMenu } from "./ChangelistContextMenu";
import type { ChangelistFileEntry } from "./ChangelistsTab";

interface Props {
  changelist: Changelist;
  files: ChangelistFileEntry[];
  defaultExpanded: boolean;
  showEmptyChangelists: boolean;
  isActive: boolean;
}

export function ChangelistGroup({
  changelist,
  files,
  defaultExpanded,
  showEmptyChangelists,
  isActive,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [dropHover, setDropHover] = useState(false);

  if (files.length === 0 && !showEmptyChangelists) return null;

  return (
    <div
      className={`changelist-group ${dropHover ? "drop-hover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDropHover(true);
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropHover(false);
        const data = e.dataTransfer.getData("application/x-jetgit-file-paths");
        if (!data) return;
        const paths: string[] = JSON.parse(data);
        for (const p of paths) {
          void useCommitStore.getState().moveFileToChangelist(p, changelist.id);
        }
      }}
    >
      <div
        className="changelist-group-header"
        onClick={() => setExpanded(!expanded)}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <span>{expanded ? "▼" : "▶"}</span>
        <span>{changelist.name}</span>
        <span className="changelist-count">({files.length})</span>
        {changelist.isDefault && <span className="changelist-default">●</span>}
      </div>
      {expanded && (
        <div className="changelist-group-files">
          {files.map((entry) => (
            <div
              key={`${entry.file.path}-${entry.hunkRange?.startLine ?? "w"}-${entry.hunkRange?.endLine ?? "w"}`}
              className={`changelist-file-row ${!isActive ? "changelist-inactive-file" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  "application/x-jetgit-file-paths",
                  JSON.stringify([entry.file.path]),
                );
              }}
            >
              <span className="changelist-file-status">
                {entry.file.status[0]?.toUpperCase()}
              </span>
              <span className="changelist-file-path">{entry.file.path}</span>
              {entry.hunkRange && (
                <span className="changelist-file-hunk">
                  Lines {entry.hunkRange.startLine}–{entry.hunkRange.endLine}
                </span>
              )}
            </div>
          ))}
          {files.length === 0 && <div className="changelist-empty">（空）</div>}
        </div>
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
