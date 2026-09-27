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

export async function shelveChangelist(
  cs: ChangelistService,
  gitCtx: GitContext,
  changelistId: string,
  message: string | undefined,
): Promise<{ shelfName: string }> {
  const state = cs.getState();
  const target = state.changelists.find((c) => c.id === changelistId);
  if (!target) throw new Error(`Changelist "${changelistId}" not found`);
  const targets = await buildCommitTargets(cs, gitCtx, changelistId);
  if (targets.paths.length === 0) {
    throw new Error("No files to shelve in this changelist");
  }

  const ts = Date.now();
  const shelfName = message?.trim() || `${target.name}-${ts}`;
  const defaultId = state.defaultChangelistId;
  const shelvedFiles: string[] = [];

  try {
    // Make sure the index starts clean so we stage exactly what we intend.
    await gitCtx.execGit(["reset", "HEAD", "--", "."]);

    for (const file of targets.files) {
      // Read actual hunks from `git diff HEAD` so the staging respects the
      // CURRENT working tree, not stale hunk metadata.
      const actualHunksRaw = await getFileHunks(gitCtx, file.path);
      if (actualHunksRaw.length === 0) continue;

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
      if (!filtered.trim()) continue;

      const tmpPath = path.join(
        os.tmpdir(),
        `changelist-${randomUUID()}.patch`,
      );
      await fs.writeFile(tmpPath, filtered, "utf-8");
      try {
        // 1. Stage target hunks in the index.
        await gitCtx.execGit(["apply", "--cached", tmpPath]);
        // 2. Revert target hunks from the working tree (reverse apply).
        //    Working tree now retains only non-target hunks.
        await gitCtx.execGit(["apply", "-R", tmpPath]);
        // 3. Stash the remaining working tree state (non-target hunks only)
        //    for this file. The shelved target hunks are NOT in the stash;
        //    they have already been reverted to HEAD in step 2.
        await gitCtx.execGit([
          "stash",
          "push",
          "-m",
          shelfName,
          "--",
          file.path,
        ]);
        shelvedFiles.push(file.path);
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
    }

    if (shelvedFiles.length === 0) {
      throw new Error("No files have content to shelve in this changelist");
    }

    await gitCtx.execGit(["reset", "HEAD", "--", "."]);
    return { shelfName };
  } catch (err) {
    await gitCtx.execGit(["reset", "HEAD", "--", "."]).catch(() => {});
    throw err;
  }
}
