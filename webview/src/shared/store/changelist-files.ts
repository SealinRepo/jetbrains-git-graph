import type {
  Changelist,
  FileAssignment,
} from "../../../../shared/types/changelists";
import type { WorkingTreeFile } from "../store/commit-store";

/** Spec §7.4 / Finding 3: a file can appear under multiple changelists via
 *  hunk-mode assignments. We thread the optional line range through so each
 *  rendered group can show a "Lines X–Y" suffix when needed. */
export interface ChangelistFileEntry {
  file: WorkingTreeFile;
  hunkRange?: { startLine: number; endLine: number };
}

interface ComputeParams {
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

/** Spec §7.4: 排除默认列表后剩下的"用户可见"列表，按 createdAt 升序排序。 */
export function userChangelists(
  changelists: Changelist[],
  defaultChangelistId: string | null,
): Changelist[] {
  return changelists
    .filter((c) => c.id !== defaultChangelistId)
    .sort((a, b) => a.createdAt - b.createdAt);
}
