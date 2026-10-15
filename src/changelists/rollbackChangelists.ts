import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HunkAssignment, HunkInfo } from "../../shared/types/changelists";
import type { GitContext } from "../git/gitService/context";
import { getFileHunks } from "../git/gitService/hunks";
import type { ChangelistService } from "./changelistService";
import {
  buildCommitTargets,
  getTargetLineRanges,
  type HunkRange,
} from "./commitChangelist";
import { filterPatchByHunks } from "./filterPatchByHunks";

export interface ChangelistRollbackTarget {
  changelistId: string;
  filePaths: string[];
}

/** Revert only the selected changelist hunks, preserving other lists' lines. */
export async function rollbackChangelists(
  cs: ChangelistService,
  gitCtx: GitContext,
  targets: ChangelistRollbackTarget[],
  trackedPaths: Set<string>,
): Promise<void> {
  const state = cs.getState();
  const pathTargets = new Map<string, Set<string>>();

  for (const target of targets) {
    if (!state.changelists.some((list) => list.id === target.changelistId)) {
      throw new Error(`Changelist "${target.changelistId}" not found`);
    }
    const paths = pathTargets.get(target.changelistId) ?? new Set<string>();
    for (const filePath of target.filePaths) paths.add(filePath);
    pathTargets.set(target.changelistId, paths);
  }

  const targetsByList = await Promise.all(
    [...pathTargets].map(async ([changelistId, filePaths]) => {
      const result = await buildCommitTargets(
        cs,
        gitCtx,
        changelistId,
        trackedPaths,
        undefined,
        filePaths,
      );
      return { changelistId, files: result.files };
    }),
  );
  const selectedPaths = [
    ...new Set(
      targetsByList.flatMap((target) => target.files.map((f) => f.path)),
    ),
  ];
  if (selectedPaths.length === 0) {
    throw new Error("No selected changes to roll back");
  }

  const actualHunksByPath = new Map<string, HunkInfo[]>();
  const rangesByPath = new Map<string, HunkAssignment[]>();
  const wholeFilePaths = new Set<string>();
  const defaultId = state.defaultChangelistId;

  // Keep selected file contents intact but unstage them before deriving a
  // single HEAD-based patch for all changelists.
  await gitCtx.execGit(["reset", "HEAD", "--", ...selectedPaths]);

  for (const target of targetsByList) {
    for (const file of target.files) {
      let actualHunks = actualHunksByPath.get(file.path);
      if (!actualHunks) {
        actualHunks = await getFileHunks(gitCtx, file.path);
        actualHunksByPath.set(file.path, actualHunks);
      }
      if (actualHunks.length === 0) {
        if (file.mode === "whole") wholeFilePaths.add(file.path);
        continue;
      }

      const ranges: HunkRange[] = actualHunks.map((hunk) => ({
        startLine: hunk.startLine,
        endLine: hunk.endLine,
      }));
      const ownedRanges = getTargetLineRanges(
        file.path,
        target.changelistId,
        defaultId,
        state.assignments,
        ranges,
      );
      const fileAssignments = rangesByPath.get(file.path) ?? [];
      fileAssignments.push(
        ...ownedRanges.map((range) => ({
          ...range,
          changelistId: target.changelistId,
        })),
      );
      rangesByPath.set(file.path, fileAssignments);
    }
  }

  const patchParts: string[] = [];
  for (const [filePath, ranges] of rangesByPath) {
    const fullPatch = await gitCtx.execGit(["diff", "HEAD", "--", filePath]);
    const filtered = filterPatchByHunks(fullPatch, ranges);
    if (filtered.trim()) patchParts.push(filtered);
  }
  const patchContent = patchParts.join("");
  if (!patchContent.trim() && wholeFilePaths.size === 0) {
    throw new Error("No selected changelist lines to roll back");
  }

  let tempPath: string | undefined;
  let patchApplied = false;
  try {
    if (patchContent.trim()) {
      tempPath = path.join(os.tmpdir(), `rollback-${randomUUID()}.patch`);
      await fs.writeFile(tempPath, patchContent, "utf-8");
      await gitCtx.execGit(["apply", "-R", tempPath]);
      patchApplied = true;
    }
    for (const filePath of wholeFilePaths) {
      await gitCtx.execGit(["checkout", "HEAD", "--", filePath]);
    }
    gitCtx.invalidateCache();
  } catch (err) {
    if (patchApplied && tempPath) {
      await gitCtx.execGit(["apply", tempPath]).catch(() => {});
    }
    throw err;
  } finally {
    if (tempPath) await fs.unlink(tempPath).catch(() => {});
  }
}
