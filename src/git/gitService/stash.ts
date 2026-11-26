import type { ShelveEntry } from "../types";
import type { GitContext } from "./context";
import { parsePorcelainV1Z } from "./statusParser";

/** 获取原生 git stash 列表，并为每条 stash 补充其涉及的文件列表。 */
export async function getShelves(ctx: GitContext): Promise<ShelveEntry[]> {
  try {
    const output = await ctx.execGit([
      "stash",
      "list",
      "--format=%gd%x00%s%x00%aI%x00%D",
    ]);
    if (!output.trim()) return [];

    const entries: ShelveEntry[] = [];
    for (const line of output.trim().split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\x00");
      const id = parts[0] ?? "";
      const message = (parts[1] ?? "").replace(/^(WIP on|On) [^:]+:\s*/, "");
      const date = parts[2] ?? "";
      const _refs = parts[3] ?? "";
      // Extract branch from refs or message
      const branchMatch = (parts[1] ?? "").match(/^(?:WIP on|On) ([^:]+)/);
      const branch = branchMatch?.[1] ?? "";

      entries.push({ id, message, date, branch, files: [] });
    }

    // Load files for each stash
    for (const entry of entries) {
      try {
        const filesOutput = await ctx.execGit([
          "stash",
          "show",
          entry.id,
          "--name-only",
        ]);
        entry.files = filesOutput.trim().split("\n").filter(Boolean);
      } catch {
        // ignore
      }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * 将改动存入 git stash。指定 `filePaths` 时只 stash 这些文件：
 * 先清空索引、只暂存目标文件再 stash，最后把原本已暂存但不在目标里的文件重新暂存回去，
 * 避免把用户其他已暂存的改动一并卷入。未指定文件时直接 stash 全部改动（含未跟踪文件）。
 */
export async function shelveChanges(
  ctx: GitContext,
  message: string,
  filePaths?: string[],
): Promise<void> {
  if (filePaths && filePaths.length > 0) {
    // Strategy: to stash only specific files without pulling in other staged files,
    // we need to temporarily reset the index, stage only our target files, then stash.

    // 1. Save current index state by creating a temporary stash of the index
    //    We use a different approach: reset index, add targets, stash, restore index.

    // Get current status to know what's staged
    const statusBefore = await ctx.execGit(["status", "--porcelain=v1", "-z"]);
    const previouslyStaged: string[] = [];
    for (const { indexStatus, path } of parsePorcelainV1Z(statusBefore)) {
      if (indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!") {
        previouslyStaged.push(path);
      }
    }

    // 2. Reset the index (unstage everything) without touching working tree
    try {
      await ctx.execGit(["reset", "HEAD"]);
    } catch {
      // May fail if there's no HEAD (initial commit) — that's ok
    }

    // 3. Stage only the target files
    await ctx.execGit(["add", "--", ...filePaths]);

    // 4. Stash only the staged files
    await ctx.execGit([
      "stash",
      "push",
      "--staged",
      "-m",
      message || "Shelved changes",
    ]);

    // 5. Re-stage previously staged files (that weren't stashed)
    const remainingToStage = previouslyStaged.filter(
      (f) => !filePaths.includes(f),
    );
    if (remainingToStage.length > 0) {
      try {
        await ctx.execGit(["add", "--", ...remainingToStage]);
      } catch {
        // Some files may no longer exist, ignore errors
      }
    }
  } else {
    // Stash all changes including untracked
    const args = ["stash", "push", "-m", message || "Shelved changes", "-u"];
    await ctx.execGit(args);
  }
  ctx.invalidateCache();
}

/** 恢复指定 stash 的改动，`drop` 为 true（默认）时应用后删除该 stash（`pop`），否则保留（`apply`）。 */
export async function unshelveChanges(
  ctx: GitContext,
  stashId: string,
  drop = true,
): Promise<void> {
  if (drop) {
    await ctx.execGit(["stash", "pop", stashId]);
  } else {
    await ctx.execGit(["stash", "apply", stashId]);
  }
  ctx.invalidateCache();
}

/** 删除指定 stash。 */
export async function deleteShelve(
  ctx: GitContext,
  stashId: string,
): Promise<void> {
  await ctx.execGit(["stash", "drop", stashId]);
}
