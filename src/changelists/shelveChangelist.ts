import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChangelistService } from "./changelistService";
import type { GitContext } from "../git/gitService/context";
import { filterPatchByHunks } from "./filterPatchByHunks";
import { buildCommitTargets } from "./commitChangelist";

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

  try {
    await gitCtx.execGit(["reset", "HEAD", "--", "."]);

    for (const file of targets.files) {
      if (file.mode === "whole") {
        // 直接 stash
        await gitCtx.execGit(["stash", "push", "-m", shelfName, "--", file.path]);
      } else {
        // hunk 模式：先把 hunk 写入暂存区，再 stash 整文件
        const fullPatch = await gitCtx.execGit(["diff", "HEAD", "--", file.path]);
        const filtered = filterPatchByHunks(fullPatch, file.hunks ?? []);
        if (filtered.trim()) {
          const tmpPath = path.join(os.tmpdir(), `changelist-${randomUUID()}.patch`);
          await fs.writeFile(tmpPath, filtered, "utf-8");
          try {
            await gitCtx.execGit(["apply", "--cached", tmpPath]);
          } finally {
            await fs.unlink(tmpPath).catch(() => {});
          }
        }
        await gitCtx.execGit(["stash", "push", "-m", shelfName, "--", file.path]);
      }
    }

    await gitCtx.execGit(["reset", "HEAD", "--", "."]);
    return { shelfName };
  } catch (err) {
    await gitCtx.execGit(["reset", "HEAD", "--", "."]).catch(() => {});
    throw err;
  }
}