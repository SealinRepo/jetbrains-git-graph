import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HunkAssignment, HunkInfo } from "../../shared/types/changelists";
import type { GitContext } from "../git/gitService/context";
import { getFileHunks } from "../git/gitService/hunks";
import { importPatchAsShelf } from "../git/gitService/ideaShelf";
import type { ChangelistService } from "./changelistService";
import {
  buildCommitTargets,
  getTargetLineRanges,
  type HunkRange,
} from "./commitChangelist";
import { filterPatchByHunks } from "./filterPatchByHunks";

export interface ChangelistShelfTarget {
  changelistId: string;
  selectedFiles?: Set<string> | null;
}

export async function shelveChangelist(
  cs: ChangelistService,
  gitCtx: GitContext,
  changelistId: string,
  message: string | undefined,
  trackedPaths?: Set<string>,
  selectedFiles?: Set<string> | null,
): Promise<{ shelfNames: string[] }> {
  return shelveChangelists(
    cs,
    gitCtx,
    [{ changelistId, selectedFiles }],
    message,
    trackedPaths,
  );
}

/** Shelve selected hunks from multiple changelists against one original diff. */
export async function shelveChangelists(
  cs: ChangelistService,
  gitCtx: GitContext,
  changelists: ChangelistShelfTarget[],
  message: string | undefined,
  trackedPaths?: Set<string>,
): Promise<{ shelfNames: string[] }> {
  const state = cs.getState();
  if (changelists.length === 0) {
    throw new Error("No changelists selected to shelve");
  }

  const targets = await Promise.all(
    changelists.map(async (selection) => {
      const changelist = state.changelists.find(
        (item) => item.id === selection.changelistId,
      );
      if (!changelist) {
        throw new Error(`Changelist "${selection.changelistId}" not found`);
      }
      const result = await buildCommitTargets(
        cs,
        gitCtx,
        selection.changelistId,
        trackedPaths,
        undefined,
        selection.selectedFiles,
      );
      return { changelist, files: result.files };
    }),
  );

  const selectedPaths = new Set(
    targets.flatMap((target) => target.files.map((file) => file.path)),
  );
  if (selectedPaths.size === 0) {
    throw new Error("No files to shelve in the selected changelists");
  }

  const defaultId = state.defaultChangelistId;
  const rangesByPath = new Map<string, HunkAssignment[]>();
  const rangesByChangelist = new Map<string, Map<string, HunkAssignment[]>>();
  const actualHunksByPath = new Map<string, HunkInfo[]>();
  const fullPatchesByPath = new Map<string, string>();

  try {
    // Unstage once, then collect every target from the same working-tree diff.
    await gitCtx.execGit(["reset", "HEAD", "--", "."]);

    for (const target of targets) {
      for (const file of target.files) {
        let actualHunks = actualHunksByPath.get(file.path);
        if (!actualHunks) {
          actualHunks = await getFileHunks(gitCtx, file.path);
          actualHunksByPath.set(file.path, actualHunks);
        }
        if (actualHunks.length === 0) continue;

        const actualRanges: HunkRange[] = actualHunks.map((hunk) => ({
          startLine: hunk.startLine,
          endLine: hunk.endLine,
        }));
        const targetRanges = getTargetLineRanges(
          file.path,
          target.changelist.id,
          defaultId,
          state.assignments,
          actualRanges,
        );
        if (targetRanges.length === 0) continue;

        const assignments = targetRanges.map((range) => ({
          ...range,
          changelistId: target.changelist.id,
        }));
        const listRanges =
          rangesByChangelist.get(target.changelist.id) ?? new Map();
        const listFileRanges = listRanges.get(file.path) ?? [];
        listFileRanges.push(...assignments);
        listRanges.set(file.path, listFileRanges);
        rangesByChangelist.set(target.changelist.id, listRanges);

        const combinedRanges = rangesByPath.get(file.path) ?? [];
        combinedRanges.push(...assignments);
        rangesByPath.set(file.path, combinedRanges);
      }
    }

    const shelfPatches: Array<{ name: string; content: string }> = [];
    for (const target of targets) {
      const listRanges = rangesByChangelist.get(target.changelist.id);
      if (!listRanges) continue;
      const patchParts: string[] = [];
      for (const [filePath, ranges] of listRanges) {
        let fullPatch = fullPatchesByPath.get(filePath);
        if (fullPatch === undefined) {
          fullPatch = await gitCtx.execGit(["diff", "HEAD", "--", filePath]);
          fullPatchesByPath.set(filePath, fullPatch);
        }
        const filtered = filterPatchByHunks(fullPatch, ranges);
        if (filtered.trim()) patchParts.push(filtered);
      }
      const content = patchParts.join("");
      if (content.trim()) {
        shelfPatches.push({
          name: message?.trim() || target.changelist.name,
          content,
        });
      }
    }

    const combinedPatchParts: string[] = [];
    for (const [filePath, ranges] of rangesByPath) {
      const fullPatch = fullPatchesByPath.get(filePath);
      if (!fullPatch) continue;
      const filtered = filterPatchByHunks(fullPatch, ranges);
      if (filtered.trim()) combinedPatchParts.push(filtered);
    }
    const patchContent = combinedPatchParts.join("");
    if (!patchContent.trim()) {
      throw new Error("No selected changes have content to shelve");
    }
    if (shelfPatches.length === 0) {
      throw new Error("No selected changes belong to the chosen changelists");
    }

    const tmpPath = path.join(os.tmpdir(), `changelist-${randomUUID()}.patch`);
    await fs.writeFile(tmpPath, patchContent, "utf-8");
    let reverted = false;
    try {
      await gitCtx.execGit(["apply", "-R", tmpPath]);
      reverted = true;
      for (const shelfPatch of shelfPatches) {
        await importPatchAsShelf(gitCtx, shelfPatch.name, shelfPatch.content);
      }
    } catch (err) {
      if (reverted) {
        await gitCtx.execGit(["apply", tmpPath]).catch(() => {});
      }
      throw err;
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }

    return { shelfNames: shelfPatches.map((shelfPatch) => shelfPatch.name) };
  } catch (err) {
    await gitCtx.execGit(["reset", "HEAD", "--", "."]).catch(() => {});
    throw err;
  }
}
