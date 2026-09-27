import type {
  Changelist,
  FileAssignment,
  HunkAssignment,
  HunkInfo,
} from "../../../../shared/types/changelists";
import type { WorkingTreeFile } from "../store/commit-store";

/** 行区间（工作区行号，闭区间）。 */
export interface HunkRange {
  startLine: number;
  endLine: number;
}

/** Spec §7.4 / Finding 3: a file can appear under multiple changelists via
 *  hunk-mode assignments. We thread the owned line ranges through so each
 *  rendered group can show a "Lines X–Y" suffix when needed. Multiple ranges
 *  per file are the norm (one per diff hunk), so the renderer must not assume
 *  a single contiguous block. */
export interface ChangelistFileEntry {
  file: WorkingTreeFile;
  /** 本列表在该文件里真正拥有的行区间。缺省 = 整文件归属。 */
  hunkRanges?: HunkRange[];
}

export interface ComputeParams {
  changelistId: string;
  changes: WorkingTreeFile[];
  assignments: Record<string, FileAssignment>;
  activeChangelistId: string | null;
  defaultChangelistId: string | null;
  /** 缓存的 `git diff HEAD` 实际 hunk（store 里的 `fileHunks`）。用于把存储的
   *  行区间换算成真实 diff hunk；未加载到的文件退回到存储区间。 */
  fileHunks?: Record<string, HunkInfo[]>;
}

/**
 * 决定一个文件是否归属于指定变更列表。归属来源有两类：
 * 1) 整文件归属（assignments[path].changelistId）
 * 2) 行级 hunk 归属（assignments[path].hunks[].changelistId）
 *
 * 未显式分配的文件，tracked 默认归属到 defaultChangelistId（不是 active），
 * 与 IDEA 行为一致：tracked 改动始终进默认 "Changes" 列表。
 * untracked 文件如果没有任何显式归属，不视为属于任何列表——它们只会出现在
 * "Unversioned Files" 分组里。
 */
export function computeChangelistFiles({
  changelistId,
  changes,
  assignments,
  activeChangelistId,
  defaultChangelistId,
  fileHunks,
}: ComputeParams): ChangelistFileEntry[] {
  const untrackedPaths = new Set(
    changes.filter((f) => f.status === "untracked").map((f) => f.path),
  );

  const wholeBelongs: WorkingTreeFile[] = [];
  const hunkOnly: ChangelistFileEntry[] = [];

  for (const file of changes) {
    const a = assignments[file.path];
    if (untrackedPaths.has(file.path) && !a) continue;

    const primaryId =
      a?.changelistId ?? defaultChangelistId ?? activeChangelistId ?? "";
    if (primaryId === changelistId) {
      wholeBelongs.push(file);
      // 即使主归属命中，hunk 也可能还指向其它列表，继续累加
    }

    if (a?.hunks && a.hunks.length > 0) {
      const claimed = a.hunks.filter((h) => h.changelistId === changelistId);
      const ranges = ownedRanges(claimed, fileHunks?.[file.path]);
      if (ranges.length > 0) hunkOnly.push({ file, hunkRanges: ranges });
    }
  }

  // 主归属去重：hunkOnly 中已出现在 wholeBelongs 的文件，整文件视图优先，
  // 不再单独画一行 "Lines X–Y"——同一文件在一个分组里只出现一次。
  const wholePaths = new Set(wholeBelongs.map((f) => f.path));
  const dedupedHunkOnly = hunkOnly.filter((e) => !wholePaths.has(e.file.path));

  return [...wholeBelongs.map((file) => ({ file })), ...dedupedHunkOnly];
}

/**
 * 把"存储的行区间"换算成"真实 diff hunk"。
 *
 * 存储的 `HunkAssignment` 只是移入那一刻的行号快照，文件一改就会漂移；真正
 * 该被这个列表拿走的是**当前** diff 里与这些区间重叠的 hunk。所以只要实际
 * hunk 已经拿到，就以它为准（顺便天然过滤掉已经消失的区间）。还没加载到
 * 实际 hunk 时退回存储区间，保证行不会凭空消失。
 */
function ownedRanges(
  claimed: HunkAssignment[],
  actualHunks: HunkInfo[] | undefined,
): HunkRange[] {
  if (claimed.length === 0) return [];
  if (actualHunks && actualHunks.length > 0) {
    const matched = actualHunks.filter((h) =>
      claimed.some((c) =>
        rangesOverlap(c, { startLine: h.startLine, endLine: h.endLine }),
      ),
    );
    if (matched.length > 0) {
      return matched.map((h) => ({
        startLine: h.startLine,
        endLine: h.endLine,
      }));
    }
  }
  return claimed.map((c) => ({ startLine: c.startLine, endLine: c.endLine }));
}

/**
 * 默认 "Changes" 列表的行级视图。这是与用户列表对称的一半：默认列表同样
 * 按 hunk 记账，而不是整文件。
 *
 * - 整文件被显式分配给其它列表 → 默认列表完全不显示（它已经没有变更了）
 * - 有 hunk 被其它列表拿走 → 默认列表只显示**没被拿走的那些 hunk**，
 *   每行一个 "Lines X–Y" 区间；一个 hunk 都不剩时整个文件从默认列表消失
 * - 其余情况（无显式分配 / 全部 hunk 都还在默认）→ 整文件行
 *
 * 实际 hunk 还没加载到时，这类文件先不渲染：宁可晚一帧出现，也不要先闪出
 * 一个整文件行再消失——那正是"移入其它列表后默认列表还在显示这个文件"的
 * 错位观感。
 */
export function computeDefaultChangelistEntries({
  changes,
  assignments,
  defaultChangelistId,
  fileHunks,
}: {
  changes: WorkingTreeFile[];
  assignments: Record<string, FileAssignment>;
  defaultChangelistId: string | null;
  fileHunks?: Record<string, HunkInfo[]>;
}): ChangelistFileEntry[] {
  const entries: ChangelistFileEntry[] = [];

  for (const file of changes) {
    if (file.status === "untracked" || file.status === "conflicted") continue;
    const a = assignments[file.path];

    // 整文件归属其它列表 → 默认列表不持有它
    if (a?.changelistId && a.changelistId !== defaultChangelistId && !a.hunks) {
      continue;
    }

    // 没有显式行分配，或者行分配全都在默认列表自己手里 → 整文件行。
    // 这条分支必须留在"需要真实 hunk"判断之前：这种文件不会被
    // `filesNeedingHunks` 列入，永远拿不到真实 hunk，若在这里就要求 hunk
    // 会让它们凭空从默认列表消失。
    if (!hasCrossListHunks(a, defaultChangelistId)) {
      entries.push({ file });
      continue;
    }

    const actualHunks = fileHunks?.[file.path];
    if (!actualHunks) continue; // 还没加载到真实 hunk，先不渲染

    const ownership = resolveDefaultOwnership(
      actualHunks,
      a,
      defaultChangelistId,
    );
    if (ownership.kind === "whole") {
      entries.push({ file });
      continue;
    }
    if (ownership.hunks.length === 0) continue; // 全部 hunk 都被别的列表拿走了
    entries.push({
      file,
      hunkRanges: ownership.hunks.map((h) => ({
        startLine: h.startLine,
        endLine: h.endLine,
      })),
    });
  }

  return entries;
}

/** 这个文件是否有 hunk 被分配给非默认列表（即被拆过行）。 */
export function hasCrossListHunks(
  assignment: FileAssignment | undefined,
  defaultChangelistId: string | null,
): boolean {
  const hunks = assignment?.hunks;
  if (!hunks || hunks.length === 0) return false;
  return hunks.some((h) => h.changelistId !== defaultChangelistId);
}

/**
 * 哪些文件需要向扩展端拉真实 hunk？只有"存在跨列表 hunk 分配"的文件——
 * 它们的默认列表视图要按行拆分。普通文件走整文件行，不需要额外一次
 * `git diff`，所以不会给常规流程增加任何开销。
 */
export function filesNeedingHunks(
  changes: WorkingTreeFile[],
  assignments: Record<string, FileAssignment>,
  defaultChangelistId: string | null,
): string[] {
  const paths: string[] = [];
  for (const file of changes) {
    if (file.status === "untracked" || file.status === "conflicted") continue;
    if (hasCrossListHunks(assignments[file.path], defaultChangelistId)) {
      paths.push(file.path);
    }
  }
  return paths;
}

/**
 * 解析某个 changelist 当前"实际被勾选"的文件集合。`selectedByChangelist`
 * 里的缺失 key 与空 Set 是两个完全不同的状态，不能混为一谈：
 *
 * - `undefined`（key 不存在）→ 用户还没动过这个列表，按 IDEA 的行为把该列表
 *   渲染出来的所有文件都当作已勾选。
 * - `Set`（可能为空）→ 用户显式表达过意图，集合即为全部答案；空 Set 意味着
 *   "全都取消了勾选"。
 *
 * 之前把 `size > 0` 当成"有没有手动选择"的判据，导致空 Set 又被当成"没动过"
 * 而回退成全选——于是第一次点"取消勾选"反而把文件勾上（toggle 往空 Set 里
 * add 了刚点掉的那个路径），列表的复选框怎么点都在两个状态之间来回跳。
 *
 * store 的写操作也用这个函数把隐式全选物化成显式 Set，保证 UI 渲染出来的
 * 勾选状态和提交时真正 stage 的文件集合是同一份数据。
 */
export function resolveChangelistSelection(
  changelistId: string,
  stored: Set<string> | undefined,
  params: Omit<ComputeParams, "changelistId">,
): Set<string> {
  if (stored) return stored;
  return new Set(
    computeChangelistFiles({ changelistId, ...params }).map((e) => e.file.path),
  );
}

/** Spec §7.4: 排除默认列表后剩下的"用户可见"列表，按 createdAt 升序排序。 */
export function userChangelists(
  changelists: Changelist[],
  defaultChangelistId: string | null,
): Changelist[] {
  return changelists
    .filter((c) => c.id !== defaultChangelistId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Two closed ranges [aStart, aEnd] and [bStart, bEnd] overlap iff neither is
 *  entirely below / above the other. Touching endpoints count as overlap so
 *  adjacent line ranges merge into a single hunk row. */
function rangesOverlap(a: HunkRange, b: HunkRange): boolean {
  return !(a.endLine < b.startLine || a.startLine > b.endLine);
}

/**
 * 默认列表对一个文件的持有范围。二选一，避免用 `null` 同时表达"整文件"和
 * "整个文件都不属于默认"这两种相反的结论：
 * - `whole`：整个文件都是默认列表的（渲染成普通文件行）
 * - `hunks`：只持有这几个实际 hunk；**空数组表示一个都不剩**，即这个文件
 *   的改动已经全部被别的列表拿走，默认列表不该再显示它
 */
export type DefaultOwnership =
  | { kind: "whole" }
  | { kind: "hunks"; hunks: HunkInfo[] };

/**
 * 决定默认 "Changes" 列表持有某个文件的哪些内容。
 *
 * 这与 `computeChangelistFiles`（收集**指向**目标列表的行区间）正好互为
 * 镜像：这里收集的是**没有**被任何非默认列表拿走的 hunk。任何显式分配都
 * 覆盖不到的 hunk 都归默认列表（IDEA 行为），所以"移入其它列表之后又改了
 * 别的行"时，新行会自动重新出现在默认列表里。
 */
export function resolveDefaultOwnership(
  actualHunks: HunkInfo[],
  assignment: FileAssignment | undefined,
  defaultChangelistId: string | null,
): DefaultOwnership {
  if (!assignment) return { kind: "whole" };

  // 整文件被别的列表拿走 → 默认列表什么都不持有
  if (
    assignment.changelistId &&
    assignment.changelistId !== defaultChangelistId &&
    !assignment.hunks
  ) {
    return { kind: "hunks", hunks: [] };
  }

  if (!assignment.hunks || assignment.hunks.length === 0) {
    return { kind: "whole" };
  }

  const hunksToOther = assignment.hunks.filter(
    (h) => h.changelistId !== defaultChangelistId,
  );
  if (hunksToOther.length === 0) {
    // 显式记录的 hunk 全都还在默认列表 → 整文件展示
    return { kind: "whole" };
  }

  return {
    kind: "hunks",
    hunks: actualHunks.filter(
      (h) =>
        !hunksToOther.some((other) =>
          rangesOverlap(other, { startLine: h.startLine, endLine: h.endLine }),
        ),
    ),
  };
}
