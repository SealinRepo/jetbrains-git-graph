import { getFileIcon } from "../../panel/utils/file-icons";
import type { WorkingTreeFile } from "../../shared/store/commit-store";
import { TreeRow } from "./TreeRow";

export interface FileItemProps {
  file: WorkingTreeFile;
  selected: boolean;
  highlighted: boolean;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onShowDiff: () => void;
  onClick: (e: React.MouseEvent) => void;
  /** 在目录树中的层级，非目录树模式下忽略 */
  depth?: number;
  /** 在 checkbox 前占一个和 chevron 等宽的空位，让本行和同层文件夹行对齐 */
  showIndentSlot?: boolean;
  /** 透传给 TreeRow：让整行可拖（用于拖到其它 changelist） */
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  /**
   * 可选：此文件是 hunk-only 归属时显示的 "Lines X-Y" 标注。只在用户
   * 变更列表中出现（默认 Changes 走整文件视图，commit 隔离由后端处理）。
   */
  hunkRange?: { startLine: number; endLine: number };
}

export function FileItem({
  file,
  selected,
  highlighted,
  onToggle,
  onContextMenu,
  onShowDiff,
  onClick,
  depth = 0,
  showIndentSlot = false,
  draggable,
  onDragStart,
  hunkRange,
}: FileItemProps) {
  const parts = file.path.split("/");
  const fileName = parts.pop() || parts.pop() || file.path;
  const dirPath = parts.length > 0 ? parts.join("/") : "";

  const statusLabel = getStatusLabel(file.status);
  const statusColor = getStatusColor(file.status);
  const FileIcon = getFileIcon(file.path);

  return (
    <TreeRow
      depth={depth}
      chevron={showIndentSlot ? "spacer" : undefined}
      checkbox={{ checked: selected, onChange: onToggle }}
      icon={<FileIcon style={{ width: 16, height: 16 }} />}
      label={fileName}
      labelTitle={file.path}
      labelColor={statusColor}
      labelGrow
      labelSuffix={
        dirPath ? (
          <span className="commit-file-path">{dirPath}</span>
        ) : undefined
      }
      highlighted={highlighted}
      trailingContent={
        <>
          {hunkRange && (
            <span
              className="commit-file-hunk"
              title={`Lines ${hunkRange.startLine}–${hunkRange.endLine}`}
            >
              Lines {hunkRange.startLine}–{hunkRange.endLine}
            </span>
          )}
          <span className="commit-file-status" style={{ color: statusColor }}>
            {statusLabel}
          </span>
        </>
      }
      onClick={onClick}
      onDoubleClick={onShowDiff}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e);
      }}
      draggable={draggable}
      onDragStart={onDragStart}
    />
  );
}

function getStatusLabel(status: WorkingTreeFile["status"]): string {
  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "conflicted":
      return "C";
    default:
      return "?";
  }
}

function getStatusColor(status: WorkingTreeFile["status"]): string {
  switch (status) {
    case "added":
      return "#6a8759";
    case "untracked":
      return "#d1675a";
    case "modified":
      return "#6897bb";
    case "deleted":
      return "#6c6c6c";
    case "renamed":
      return "#b9b462";
    case "conflicted":
      return "#d1675a";
    default:
      return "inherit";
  }
}
