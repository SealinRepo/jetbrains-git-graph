import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GitContext } from "../git/gitService/context";
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

export async function buildCommitTargets(
  cs: ChangelistService,
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
): Promise<BuildTargetsResult> {
  const state = cs.getState();
  const defaultId = state.defaultChangelistId;
  const out: BuildTargetsResult = { files: [], paths: [] };
  const seen = new Set<string>();

  for (const [filePath, assignment] of Object.entries(state.assignments)) {
    const fileHunks = (assignment.hunks ?? []).filter(
      (h) => h.changelistId === changelistId,
    );
    const isWholeAssigned = assignment.changelistId === changelistId;
    if (!isWholeAssigned && fileHunks.length === 0) continue;
    if (fileHunks.length > 0) {
      out.files.push({ path: filePath, mode: "hunks", hunks: fileHunks });
      out.paths.push(filePath);
    } else if (isWholeAssigned) {
      out.files.push({ path: filePath, mode: "whole" });
      out.paths.push(filePath);
    }
    seen.add(filePath);
  }

  // Implicit 归属: tracked files not in assignments belong to the default
  // "Changes" changelist (not the active one) — matches IDEA behavior.
  // Only contribute when this commit targets the default list.
  if (trackedPaths && changelistId === defaultId) {
    for (const filePath of trackedPaths) {
      if (seen.has(filePath)) continue;
      out.files.push({ path: filePath, mode: "whole" });
      out.paths.push(filePath);
      seen.add(filePath);
    }
  }

  return out;
}

export async function commitChangelist(
  cs: ChangelistService,
  gitCtx: GitContext,
  changelistId: string,
  message: string,
  amend: boolean,
  trackedPaths?: Set<string>,
): Promise<{ committedFiles: string[] }> {
  const targets = await buildCommitTargets(cs, changelistId, trackedPaths);
  if (targets.paths.length === 0) {
    throw new Error("No files to commit in this changelist");
  }

  try {
    await gitCtx.execGit(["reset", "HEAD", "--", "."]);

    for (const file of targets.files) {
      if (file.mode === "whole") {
        await gitCtx.execGit(["add", "--", file.path]);
      } else {
        const fullPatch = await gitCtx.execGit([
          "diff",
          "HEAD",
          "--",
          file.path,
        ]);
        const filtered = filterPatchByHunks(fullPatch, file.hunks ?? []);
        if (filtered.trim()) {
          const tmpPath = path.join(
            os.tmpdir(),
            `changelist-${randomUUID()}.patch`,
          );
          await fs.writeFile(tmpPath, filtered, "utf-8");
          try {
            await gitCtx.execGit(["apply", "--cached", tmpPath]);
          } finally {
            await fs.unlink(tmpPath).catch(() => {});
          }
        }
      }
    }

    const commitArgs = ["commit", "-m", message];
    if (amend) commitArgs.push("--amend");
    commitArgs.push("--", ...targets.paths);
    await gitCtx.execGit(commitArgs);

    await gitCtx.execGit(["reset", "HEAD", "--", "."]);
    return { committedFiles: targets.paths };
  } catch (err) {
    await gitCtx.execGit(["reset", "HEAD", "--", "."]).catch(() => {});
    throw err;
  }
}
