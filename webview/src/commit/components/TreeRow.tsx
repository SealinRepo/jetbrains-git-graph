import type { ReactNode } from "react";
import {
  ChevronRightIcon,
  FolderIconBlack,
} from "../../shared/components/Icons";
import type { WorkingTreeFile } from "../../shared/store/commit-store";

/**
 * 目录树里分组标题行、文件夹行、文件行共用同一条缩进公式。文件夹/分组行的
 * checkbox 前有个真实的 chevron，文件行则用一个同宽的空位占位（见 FileItem
 * 的 showIndentSlot），两者才能按同一个 depth 对齐，不需要各自单独调一个
 * 偏移量。
 */
const TREE_BASE_PADDING = 8;
const TREE_INDENT_UNIT = 16;

export function getTreeIndent(depth: number): number {
  return TREE_BASE_PADDING + depth * TREE_INDENT_UNIT;
}

export interface DirNode {
  name: string;
  fullPath: string;
  children: DirNode[];
  files: WorkingTreeFile[];
}

/**
 * 根节点本身也会被当成一行渲染（分组标题），所以调用方要传一个名字。真正的
 * 子目录 fullPath 永远不会是空字符串，只有根节点是——据此可以在渲染时识别
 * "这一项是分组自己的行，还是普通子目录"。
 */
export function buildDirTree(
  files: WorkingTreeFile[],
  rootName: string,
): DirNode {
  const root: DirNode = {
    name: rootName,
    fullPath: "",
    children: [],
    files: [],
  };

  for (const file of files) {
    const parts = file.path.split("/");
    parts.pop(); // 去掉文件名，只保留目录部分
    let current = root;

    for (const part of parts) {
      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          fullPath: current.fullPath ? `${current.fullPath}/${part}` : part,
          children: [],
          files: [],
        };
        current.children.push(child);
      }
      current = child;
    }
    current.files.push(file);
  }

  // 压缩单子节点目录（src/git → src/git）
  compactDirNode(root);
  return root;
}

function compactDirNode(node: DirNode) {
  for (const child of node.children) {
    while (child.children.length === 1 && child.files.length === 0) {
      const grandchild = child.children[0];
      child.name = `${child.name}/${grandchild.name}`;
      child.fullPath = grandchild.fullPath;
      child.children = grandchild.children;
      child.files = grandchild.files;
    }
    compactDirNode(child);
  }
}

export function countFiles(node: DirNode): number {
  let count = node.files.length;
  for (const child of node.children) {
    count += countFiles(child);
  }
  return count;
}

/** 递归收集某个 DirNode 下所有文件的 key */
export function collectFileKeys(node: DirNode): string[] {
  const keys: string[] = [];
  for (const file of node.files) {
    keys.push(file.path);
  }
  for (const child of node.children) {
    keys.push(...collectFileKeys(child));
  }
  return keys;
}

export function collectDirFiles(node: DirNode): WorkingTreeFile[] {
  const result: WorkingTreeFile[] = [...node.files];
  for (const child of node.children) {
    result.push(...collectDirFiles(child));
  }
  return result;
}

/**
 * 把目录树压平成渲染时的实际顺序：根节点自己排第一（分组标题这一行），然后
 * 每个文件夹的子目录（深度优先、逐个展开）排在它自己的直属文件前面。文件夹
 * 和文件都只是带 depth 的 item，不再分开定义各自的缩进规则；分组标题本质
 * 上就是根节点这一项，不需要单独的 kind。
 */
export type TreeItem =
  | { kind: "folder"; depth: number; node: DirNode }
  | { kind: "file"; depth: number; file: WorkingTreeFile };

export function flattenTree(
  root: DirNode,
  collapsedDirs: Set<string>,
): TreeItem[] {
  const items: TreeItem[] = [{ kind: "folder", depth: 0, node: root }];

  function walk(node: DirNode, depth: number) {
    for (const child of [...node.children].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      items.push({ kind: "folder", depth, node: child });
      if (!collapsedDirs.has(child.fullPath)) {
        walk(child, depth + 1);
      }
    }
    for (const file of node.files) {
      items.push({ kind: "file", depth, file });
    }
  }

  walk(root, 1);
  return items;
}

/**
 * 一个分组（Changes/Staged/...）从"是否展开""是否按目录分组"到渲染用的
 * item 列表的唯一入口。根节点永远按分组名+全部文件建好（无论是否按目录分组），
 * 这样根节点自己的勾选三态、文件计数才能覆盖整组文件，而不只是某一种视图下
 * 看到的那部分。
 */
export function buildGroupItems(
  label: string,
  files: WorkingTreeFile[],
  expanded: boolean,
  groupByDirectory: boolean,
  collapsedDirs: Set<string>,
): TreeItem[] {
  const root = buildDirTree(files, label);
  const rootItem: TreeItem = { kind: "folder", depth: 0, node: root };
  if (!expanded) return [rootItem];
  if (groupByDirectory) return flattenTree(root, collapsedDirs);
  return [
    rootItem,
    ...files.map((file) => ({ kind: "file" as const, depth: 1, file })),
  ];
}

export interface TreeRowCheckbox {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
}

export interface TreeRowProps {
  /** 在树里的层级，决定左侧缩进 */
  depth: number;
  /** 真实 chevron（可展开折叠）/ 同宽占位（对齐用，不可点）/ 不传则不占这个槽位 */
  chevron?: "real" | "spacer";
  chevronCollapsed?: boolean;
  checkbox: TreeRowCheckbox;
  /** 不传则不占图标的位置，文字直接跟在 checkbox 后面 */
  icon?: ReactNode;
  label: string;
  /** 悬浮提示文字，不传就用 label 本身（文件行会传完整路径） */
  labelTitle?: string;
  labelColor?: string;
  bold?: boolean;
  /** 只作用在 label 文字上，不影响 trailingContent（比如后面的 "x files"） */
  uppercase?: boolean;
  /** label 撑满剩余空间（文件行需要，这样状态角标能贴右边；目录/分组行不需要） */
  labelGrow?: boolean;
  /**
   * 跟在 label 文字后面、与它同属一个截断上下文的补充内容（文件行的目录路径）。
   *
   * 和 trailingContent 的区别在这里：trailingContent 是 label 的兄弟节点，有自己
   * 独立的宽度和省略号；labelSuffix 是 label 内部的 inline 元素，和文件名连成一段
   * 连续文本，宽度不够时由外层 label 统一从尾部打一个省略号——排在后面的路径先
   * 被吃掉，吃完了才轮到文件名，整行始终只有一个省略号。
   */
  labelSuffix?: ReactNode;
  /** 目录/分组行比文件行整体暗一档，跟现在的视觉保持一致 */
  dimmed?: boolean;
  highlighted?: boolean;
  trailingContent?: ReactNode;
  /** 目录/分组的整行点击是展开折叠，勾选框点击需要单独吃掉，不要冒泡触发展开 */
  stopCheckboxPropagation?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function TreeRow({
  depth,
  chevron,
  chevronCollapsed,
  checkbox,
  icon,
  label,
  labelTitle,
  labelColor,
  bold,
  uppercase,
  labelGrow,
  labelSuffix,
  dimmed,
  highlighted,
  trailingContent,
  stopCheckboxPropagation,
  onClick,
  onDoubleClick,
  onContextMenu,
}: TreeRowProps) {
  const stopIfNeeded = (e: React.SyntheticEvent) => {
    if (stopCheckboxPropagation) e.stopPropagation();
  };

  return (
    <div
      className={`commit-tree-row${dimmed ? " dimmed" : ""}${highlighted ? " highlighted" : ""}`}
      style={{ paddingLeft: getTreeIndent(depth) }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {chevron === "real" && (
        <span
          className={`commit-tree-chevron ${chevronCollapsed ? "collapsed" : ""}`}
        >
          <ChevronRightIcon />
        </span>
      )}
      {chevron === "spacer" && (
        <span className="commit-tree-chevron" aria-hidden="true" />
      )}
      <input
        type="checkbox"
        className="commit-tree-checkbox"
        checked={checkbox.checked}
        ref={(el) => {
          if (el) el.indeterminate = checkbox.indeterminate ?? false;
        }}
        onChange={(e) => {
          stopIfNeeded(e);
          checkbox.onChange();
        }}
        onClick={stopIfNeeded}
      />
      {icon && <span className="commit-tree-icon">{icon}</span>}
      <span
        className={`commit-tree-label${bold ? " bold" : ""}${uppercase ? " uppercase" : ""}${labelGrow ? " grow" : ""}`}
        title={labelTitle ?? label}
      >
        {/* 颜色挂在内层而不是外层：labelSuffix（目录路径）也在外层里面，
            挂外层会让路径跟着文件名一起染上状态色 */}
        <span style={labelColor ? { color: labelColor } : undefined}>
          {label}
        </span>
        {labelSuffix}
      </span>
      {trailingContent}
    </div>
  );
}

export interface FolderRowProps {
  node: DirNode;
  depth: number;
  collapsed: boolean;
  fileCount: number;
  allChecked: boolean;
  someChecked: boolean;
  onToggle: () => void;
  onCheckboxChange: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** 只有分组自己这一行（Merge Conflicts）会传，比如 Resolve 链接 */
  action?: React.ReactNode;
}

/**
 * 目录行和分组标题行共用这一个组件：分组的根节点 fullPath 永远是空字符串，
 * 据此区分要不要显示文件夹图标、要不要加粗/大写——两者本质上都是"一个可展开
 * 折叠的容器"，只是分组没有图标。
 */
export function FolderRow({
  node,
  depth,
  collapsed,
  fileCount,
  allChecked,
  someChecked,
  onToggle,
  onCheckboxChange,
  onContextMenu,
  action,
}: FolderRowProps) {
  const isGroupRoot = node.fullPath === "";

  return (
    <TreeRow
      depth={depth}
      chevron="real"
      chevronCollapsed={collapsed}
      checkbox={{
        checked: allChecked,
        indeterminate: someChecked && !allChecked,
        onChange: onCheckboxChange,
      }}
      stopCheckboxPropagation
      icon={
        isGroupRoot ? undefined : <FolderIconBlack style={{ flexShrink: 0 }} />
      }
      label={node.name}
      bold={isGroupRoot}
      uppercase={isGroupRoot}
      trailingContent={
        <>
          <span className="commit-tree-count">
            {fileCount} {fileCount === 1 ? "file" : "files"}
          </span>
          {action}
        </>
      }
      onClick={onToggle}
      onContextMenu={onContextMenu}
    />
  );
}
