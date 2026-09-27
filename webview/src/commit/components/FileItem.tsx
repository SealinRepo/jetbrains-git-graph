import { getFileIcon } from "../../panel/utils/file-icons";
import type { HunkRange } from "../../shared/store/changelist-files";
import type { WorkingTreeFile } from "../../shared/store/commit-store";
import { TreeRow } from "./TreeRow";

/** 一行最多显示几段行区间，剩下的折叠成 "+N more"。 */
const MAX_RANGE_SEGMENTS = 3;

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
   * 可选：此文件在本列表里只拥有部分行时显示的 "Lines X–Y" 标注。默认
   * Changes 与用户变更列表都会出现——两边都是按行记账的。多个区间是常态
   * （每个 diff hunk 一段），超过 3 段折叠成 "+N"。
   */
  hunkRanges?: HunkRange[];
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
  hunkRanges,
}: FileItemProps) {
  const parts = file.path.split("/");
  const fileName = parts.pop() || parts.pop() || file.path;
  const dirPath = parts.length > 0 ? parts.join("/") : "";

  const statusLabel = getStatusLabel(file.status);
  const statusColor = getStatusColor(file.status);
  const FileIcon = getFileIcon(file.path);

  const hunkLabel = hunkRanges?.length
    ? formatHunkRanges(hunkRanges)
    : undefined;

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
          {hunkLabel && (
            <span className="commit-file-hunk" title={hunkLabel.full}>
              {hunkLabel.short}
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

/**
 * 把一组行区间渲染成 "Lines 10–20, 55–60" 这样的标注。行数多的时候短标签
 * 折叠掉尾巴（"Lines 10–20, 55–60 +3 more"），但 title 始终给全量信息。
 */
function formatHunkRanges(ranges: HunkRange[]): {
  short: string;
  full: string;
} {
  const full = `Lines ${ranges.map((r) => `${r.startLine}–${r.endLine}`).join(", ")}`;
  if (ranges.length <= MAX_RANGE_SEGMENTS) return { short: full, full };
  const head = ranges
    .slice(0, MAX_RANGE_SEGMENTS)
    .map((r) => `${r.startLine}–${r.endLine}`)
    .join(", ");
  return {
    short: `Lines ${head} +${ranges.length - MAX_RANGE_SEGMENTS}`,
    full,
  };
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
