import type {
  Changelist,
  FileAssignment,
  HunkInfo,
} from "../../../../shared/types/changelists";
import type { WorkingTreeFile } from "../store/commit-store";

/** Spec §7.4 / Finding 3: a file can appear under multiple changelists via
 *  hunk-mode assignments. We thread the optional line range through so each
 *  rendered group can show a "Lines X–Y" suffix when needed. */
export interface ChangelistFileEntry {
  file: WorkingTreeFile;
  hunkRange?: { startLine: number; endLine: number };
}

export interface ComputeParams {
  changelistId: string;
  changes: WorkingTreeFile[];
  assignments: Record<string, FileAssignment>;
  activeChangelistId: string | null;
  defaultChangelistId: string | null;
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
}: ComputeParams): ChangelistFileEntry[] {
  const untrackedPaths = new Set(
    changes.filter((f) => f.status === "untracked").map((f) => f.path),
  );

  const wholeBelongs: WorkingTreeFile[] = [];
  const hunkOnly: Array<{
    file: WorkingTreeFile;
    hunkRange: { startLine: number; endLine: number };
  }> = [];

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
      // 聚合该文件指向 changelistId 的所有行区间（min start, max end）
      let startLine = Number.POSITIVE_INFINITY;
      let endLine = Number.NEGATIVE_INFINITY;
      for (const h of a.hunks) {
        if (h.changelistId !== changelistId) continue;
        startLine = Math.min(startLine, h.startLine);
        endLine = Math.max(endLine, h.endLine);
      }
      if (startLine !== Number.POSITIVE_INFINITY) {
        hunkOnly.push({ file, hunkRange: { startLine, endLine } });
      }
    }
  }

  // 主归属去重：hunkOnly 中已出现在 wholeBelongs 的文件，整文件视图优先，
  // 不再单独画一行 "Lines X–Y"——同一文件在一个分组里只出现一次。
  const wholePaths = new Set(wholeBelongs.map((f) => f.path));
  const dedupedHunkOnly = hunkOnly.filter((e) => !wholePaths.has(e.file.path));

  return [...wholeBelongs.map((file) => ({ file })), ...dedupedHunkOnly];
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
function rangesOverlap(
  a: { startLine: number; endLine: number },
  b: { startLine: number; endLine: number },
): boolean {
  return !(a.endLine < b.startLine || a.startLine > b.endLine);
}

/**
 * Decide how the default changelist should display a file that has explicit
 * hunk assignments to *other* (non-default) changelists.
 *
 * Returns one of:
 * - `null`: caller should fall back to the file's whole-file display (no
 *   hunk-level separation is relevant here), OR skip the file entirely if it
 *   is whole-file assigned to a non-default changelist.
 * - An array of `HunkInfo`: the actual hunks NOT covered by any explicit
 *   assignment to a non-default changelist. Each entry is rendered as one
 *   "Lines X–Y" row in the default group's hunk-only section. An empty array
 *   means *all* hunks are claimed by other changelists, so nothing should be
 *   displayed in default.
 *
 * This is the inverse of the user-changelist aggregation in
 * `computeChangelistFiles` (which collects ranges pointing *at* the target):
 * here we collect ranges NOT pointing at any other target.
 */
export function getImplicitDefaultHunks(
  actualHunks: HunkInfo[],
  assignment: FileAssignment | undefined,
  defaultChangelistId: string | null,
): HunkInfo[] | null {
  if (!assignment) return null;

  // Whole-file assigned to another non-default changelist — file is fully
  // claimed elsewhere, nothing belongs to default.
  if (
    assignment.changelistId &&
    assignment.changelistId !== defaultChangelistId &&
    !assignment.hunks
  ) {
    return null;
  }

  if (!assignment.hunks || assignment.hunks.length === 0) {
    // No hunk assignments → use whole-file display.
    return null;
  }

  const hunksToOther = assignment.hunks.filter(
    (h) => h.changelistId !== defaultChangelistId,
  );

  if (hunksToOther.length === 0) {
    // Every stored hunk is explicitly to default — caller keeps whole-file.
    return null;
  }

  return actualHunks.filter(
    (h) => !hunksToOther.some((other) => rangesOverlap(other, h)),
  );
}
