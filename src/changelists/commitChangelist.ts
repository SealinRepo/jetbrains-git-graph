import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  FileAssignment,
  HunkAssignment,
  HunkInfo,
} from "../../shared/types/changelists";
import type { GitContext } from "../git/gitService/context";
import { getFileHunks } from "../git/gitService/hunks";
import type { ChangelistService } from "./changelistService";
import { filterPatchByHunks } from "./filterPatchByHunks";

interface BuildTargetsResult {
  files: Array<{
    path: string;
    mode: "whole" | "hunks";
    hunks?: Array<{ startLine: number; endLine: number; changelistId: string }>;
  }>;
  paths: string[];
}

/** Hunk interval used internally by the hunk-aware staging algorithm. */
export interface HunkRange {
  startLine: number;
  endLine: number;
}

/** Two line intervals overlap iff neither ends before the other starts. */
function rangesOverlap(
  a: { startLine: number; endLine: number },
  b: { startLine: number; endLine: number },
): boolean {
  return !(a.endLine < b.startLine || b.endLine < a.startLine);
}

/**
 * For a given file and target changelist, decide which actual hunks (from
 * `git diff HEAD -- <file>`) should be staged for THIS commit.
 *
 * The decision tree for each actual hunk:
 *  1. If the file has explicit whole-file assignment to the target → hunk
 *     belongs to the target (whole-file overrides anything else).
 *  2. Else if any explicit hunk assignment on the file targets the target
 *     and overlaps this actual hunk → hunk belongs to the target.
 *  3. Else if the file has explicit whole-file assignment to a NON-default
 *     changelist → hunk belongs to that other list (NOT the target).
 *  4. Else if any explicit hunk assignment on the file targets a non-default
 *     changelist and overlaps this actual hunk → hunk belongs to that other
 *     list (NOT the target).
 *  5. Else (no explicit assignment covers this hunk):
 *       - if target is the default changelist → hunk belongs to target
 *         (implicit default ownership of unassigned hunks).
 *       - else → hunk does NOT belong to target.
 */
export function getTargetLineRanges(
  filePath: string,
  changelistId: string,
  defaultChangelistId: string,
  assignments: Record<string, FileAssignment>,
  actualHunks: HunkRange[],
): HunkRange[] {
  const a = assignments[filePath];
  const ranges: HunkRange[] = [];

  for (const hunk of actualHunks) {
    const hasWholeAssignmentToTarget = a?.changelistId === changelistId;
    const hasExplicitHunkToTarget = (a?.hunks ?? []).some(
      (h) =>
        h.changelistId === changelistId &&
        rangesOverlap(
          { startLine: hunk.startLine, endLine: hunk.endLine },
          { startLine: h.startLine, endLine: h.endLine },
        ),
    );
    const hasWholeAssignmentToOther =
      a?.changelistId !== undefined &&
      a.changelistId !== changelistId &&
      a.changelistId !== defaultChangelistId;
    const hasExplicitHunkToOther = (a?.hunks ?? []).some(
      (h) =>
        h.changelistId !== changelistId &&
        h.changelistId !== defaultChangelistId &&
        rangesOverlap(
          { startLine: hunk.startLine, endLine: hunk.endLine },
          { startLine: h.startLine, endLine: h.endLine },
        ),
    );

    let belongs = false;
    if (hasWholeAssignmentToTarget || hasExplicitHunkToTarget) {
      // Even with whole-file / explicit-hunk assignment, this specific hunk
      // might be assigned to another non-default changelist. Exclude it in
      // that case (it belongs to the other list).
      const hasExplicitHunkToOtherList = (a?.hunks ?? []).some(
        (h) =>
          h.changelistId !== changelistId &&
          h.changelistId !== defaultChangelistId &&
          rangesOverlap(
            { startLine: hunk.startLine, endLine: hunk.endLine },
            { startLine: h.startLine, endLine: h.endLine },
          ),
      );
      belongs = !hasExplicitHunkToOtherList;
    } else if (hasWholeAssignmentToOther || hasExplicitHunkToOther) {
      belongs = false;
    } else {
      // No explicit assignment covers this hunk: implicit-default rule.
      belongs = changelistId === defaultChangelistId;
    }
    if (belongs) ranges.push(hunk);
  }
  return ranges;
}

/**
 * Build the set of file paths to commit for `changelistId`, plus the
 * hunk-level metadata needed to stage them correctly.
 *
 * - Files with explicit whole-file assignment to `changelistId` → whole-mode.
 * - Files with explicit hunk-mode assignments targeting `changelistId` →
 *   hunks-mode (only those hunks will be staged).
 * - Tracked files with no explicit assignment at all are considered
 *   "implicit" members of the default changelist (Spec §2.2): they are
 *   included only when committing the default changelist.
 * - Untracked files are never implicit; they only appear if the caller
 *   explicitly moves them to a changelist via `assignHunks`/`moveFile`.
 */
export async function buildCommitTargets(
  cs: ChangelistService,
  gitCtx: GitContext,
  changelistId: string,
  /**
   * Spec §2.2 (revised): tracked files without an explicit assignment are
   * treated as implicitly belonging to the **default** "Changes" changelist,
   * not the active one — this matches IDEA's behavior. When the caller
   * passes the set of tracked file paths from `getWorkingTreeChanges()`,
   * unassigned ones are added to the targets only if `changelistId` is the
   * default changelist. Untracked files are never implicit (only explicit
   * Move puts them in a changelist).
   */
  trackedPaths?: Set<string>,
  /**
   * Untracked (new) file paths. They have no `git diff HEAD` output, so they
   * can never be split into hunks — they are always committed as whole files.
   * Passed explicitly (rather than inferred) so callers that don't want new
   * files in scope keep their current behaviour.
   */
  untrackedPaths?: Set<string>,
  /**
   * Per-changelist checkbox filter from the webview UI:
   * - `null` / `undefined` → user has not made any manual selection yet for
   *   this changelist; stage every file/hunk the changelist owns (current
   *   default behaviour).
   * - `Set<string>` → filter the targets down to exactly these file paths.
   *   An empty Set means "user unchecked everything" → no files get staged.
   *
   * Stored per changelist in `selectedByChangelist` on the webview side so
   * the same file can be checked in one list but unchecked in another.
   */
  selectedFiles?: Set<string> | null,
): Promise<BuildTargetsResult> {
  // gitCtx is part of the signature for symmetry with commitChangelist and to
  // keep callers' argument lists uniform; the function only reads Changelist
  // state, so touch the parameter to silence the unused-arg lint.
  void gitCtx;
  const state = cs.getState();
  const defaultId = state.defaultChangelistId;
  const out: BuildTargetsResult = { files: [], paths: [] };
  const considered = new Set<string>();
  // `null`/`undefined` → no manual selection → no filter.
  // `Set` (even empty) → user has chosen exactly these paths.
  const hasFilter = selectedFiles !== undefined && selectedFiles !== null;

  // First: files with explicit whole-file OR explicit hunk-mode assignment to
  // the target changelist. A hunk-mode file (assignment.changelistId points
  // to default/non-target with assignment.hunks targeting target) also
  // contributes its hunks here.
  for (const [filePath, assignment] of Object.entries(state.assignments)) {
    if (hasFilter && !selectedFiles.has(filePath)) continue;
    const fileHunks = (assignment.hunks ?? []).filter(
      (h) => h.changelistId === changelistId,
    );
    const isWholeAssigned = assignment.changelistId === changelistId;
    if (isWholeAssigned || fileHunks.length > 0) {
      out.files.push({
        path: filePath,
        mode: fileHunks.length > 0 ? "hunks" : "whole",
        hunks: fileHunks,
      });
      out.paths.push(filePath);
      considered.add(filePath);
    }
  }

  // Then: implicit-whole — tracked files NOT in any assignment belong to the
  // default "Changes" changelist (not the active one), matching IDEA
  // behavior. Only contribute when this commit targets the default list.
  if (trackedPaths && changelistId === defaultId) {
    for (const filePath of trackedPaths) {
      if (considered.has(filePath)) continue;
      if (hasFilter && !selectedFiles.has(filePath)) continue;
      out.files.push({ path: filePath, mode: "whole" });
      out.paths.push(filePath);
      considered.add(filePath);
    }
  }

  // Finally: untracked files the user explicitly put in scope. They were never
  // part of `trackedPaths` and cannot be split into hunks, so they always
  // commit as whole files. Without this the default-list commit would silently
  // drop every new file the user had checked.
  if (untrackedPaths) {
    for (const filePath of untrackedPaths) {
      if (considered.has(filePath)) continue;
      if (hasFilter && !selectedFiles.has(filePath)) continue;
      out.files.push({ path: filePath, mode: "whole" });
      out.paths.push(filePath);
      considered.add(filePath);
    }
  }

  return out;
}

/**
 * Commit the hunks belonging to `changelistId` for every file in the
 * build-targets result. Uses unified hunk-aware staging:
 *  - For every target file, query `git diff HEAD -- <file>` to discover the
 *    ACTUAL hunks currently present in the working tree.
 *  - For each actual hunk, decide via `getTargetLineRanges` whether it
 *    belongs to the target changelist (considering whole-file assignments,
 *    explicit hunk assignments to the target, and explicit assignments to
 *    OTHER changelists).
 *  - If at least one hunk belongs, filter the patch with
 *    `filterPatchByHunks` and apply it to the index.
 *  - Commit only the files that actually got staged content; if none, fail.
 *
 * This guarantees that an explicit hunk-mode assignment to a non-target
 * changelist is respected: that hunk's content will NOT be staged for this
 * commit even if the file also has implicit-default ownership.
 */
export async function commitChangelist(
  cs: ChangelistService,
  gitCtx: GitContext,
  changelistId: string,
  message: string,
  amend: boolean,
  trackedPaths?: Set<string>,
  /** Untracked file paths to commit as whole files. See `buildCommitTargets`. */
  untrackedPaths?: Set<string>,
  /**
   * Per-changelist checkbox filter forwarded from the webview. See
   * `buildCommitTargets` for the contract (`null`/`undefined` → stage all,
   * `Set` → filter to those paths).
   */
  selectedFiles?: Set<string> | null,
): Promise<{ committedFiles: string[] }> {
  const targets = await buildCommitTargets(
    cs,
    gitCtx,
    changelistId,
    trackedPaths,
    untrackedPaths,
    selectedFiles,
  );
  if (targets.paths.length === 0) {
    throw new Error("No files to commit in this changelist");
  }

  const state = cs.getState();
  const defaultId = state.defaultChangelistId;
  const committedFiles: string[] = [];

  try {
    // Make sure the index starts clean so we stage exactly what we intend.
    await gitCtx.execGit(["reset", "HEAD", "--", "."]);

    for (const file of targets.files) {
      // Read actual hunks from `git diff HEAD` so the staging respects the
      // CURRENT working tree, not stale hunk metadata.
      const actualHunksRaw = await getFileHunks(gitCtx, file.path);
      if (actualHunksRaw.length === 0) {
        // No diff against HEAD. For a brand-new file that's the normal case
        // (untracked files never appear in `git diff HEAD`) and the only
        // correct action is a plain `git add`. For a tracked file it means
        // there's nothing left to commit, so skip it.
        if (file.mode === "whole" && untrackedPaths?.has(file.path)) {
          await gitCtx.execGit(["add", "--", file.path]);
          committedFiles.push(file.path);
        }
        continue;
      }

      const actualHunks: HunkRange[] = actualHunksRaw.map((h: HunkInfo) => ({
        startLine: h.startLine,
        endLine: h.endLine,
      }));

      const targetRanges = getTargetLineRanges(
        file.path,
        changelistId,
        defaultId,
        state.assignments,
        actualHunks,
      );
      if (targetRanges.length === 0) continue;

      // filterPatchByHunks takes HunkAssignment-shaped objects; convert.
      const filterInput: HunkAssignment[] = targetRanges.map((r) => ({
        startLine: r.startLine,
        endLine: r.endLine,
        changelistId,
      }));

      const fullPatch = await gitCtx.execGit(["diff", "HEAD", "--", file.path]);
      const filtered = filterPatchByHunks(fullPatch, filterInput);
      if (filtered.trim()) {
        const tmpPath = path.join(
          os.tmpdir(),
          `changelist-${randomUUID()}.patch`,
        );
        await fs.writeFile(tmpPath, filtered, "utf-8");
        try {
          await gitCtx.execGit(["apply", "--cached", tmpPath]);
          committedFiles.push(file.path);
        } finally {
          await fs.unlink(tmpPath).catch(() => {});
        }
      }
    }

    if (committedFiles.length === 0) {
      throw new Error("No files have content to commit in this changelist");
    }

    // 必须提交 index，**不能**带 pathspec。
    //
    // `git commit -- <paths>` 的语义是"忽略 index，直接记录这些路径的**工作区
    // 内容**"——上面用 `git apply --cached` 精心筛出来的行级过滤会被完全作废，
    // 同一个文件里属于其它变更列表的行会被一起提交进去。
    // 开头已经 `reset HEAD -- .` 把 index 清空，所以此刻 index 里只有我们想
    // 提交的内容，直接无路径提交即可。
    const commitArgs = ["commit", "-m", message];
    if (amend) commitArgs.push("--amend");
    await gitCtx.execGit(commitArgs);

    await gitCtx.execGit(["reset", "HEAD", "--", "."]);
    return { committedFiles };
  } catch (err) {
    await gitCtx.execGit(["reset", "HEAD", "--", "."]).catch(() => {});
    throw err;
  }
}
