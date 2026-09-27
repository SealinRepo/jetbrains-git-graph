import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { GitContext } from "../git/gitService/context";
import type { ChangelistService } from "./changelistService";
import { buildCommitTargets } from "./commitChangelist";
import { filterPatchByHunks } from "./filterPatchByHunks";

export async function createPatchFromChangelist(
  cs: ChangelistService,
  gitCtx: GitContext,
  changelistId: string,
  workspaceRoot: string,
  /**
   * Per-changelist checkbox filter forwarded from the webview. `null` /
   * `undefined` → export every file/hunk the changelist owns. `Set<string>`
   * → filter down to exactly these paths.
   */
  selectedFiles?: Set<string> | null,
): Promise<{ patchPath: string }> {
  const state = cs.getState();
  const target = state.changelists.find((c) => c.id === changelistId);
  if (!target) throw new Error(`Changelist "${changelistId}" not found`);
  const targets = await buildCommitTargets(
    cs,
    gitCtx,
    changelistId,
    undefined,
    selectedFiles,
  );
  if (targets.paths.length === 0) {
    throw new Error("No files to export in this changelist");
  }

  const patchParts: string[] = [];
  for (const file of targets.files) {
    if (file.mode === "whole") {
      const p = await gitCtx.execGit(["diff", "HEAD", "--", file.path]);
      if (p.trim()) patchParts.push(p);
    } else {
      const fullPatch = await gitCtx.execGit(["diff", "HEAD", "--", file.path]);
      const filtered = filterPatchByHunks(fullPatch, file.hunks ?? []);
      if (filtered.trim()) patchParts.push(filtered);
    }
  }

  const tmpPath = path.join(os.tmpdir(), `changelist-${randomUUID()}.patch`);
  await fs.writeFile(tmpPath, patchParts.join("\n"), "utf-8");

  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(
      path.join(workspaceRoot, `${target.name}.patch`),
    ),
    filters: { "Patch files": ["patch", "diff"], "All files": ["*"] },
    title: `Save Patch for "${target.name}"`,
  });
  if (!saveUri) {
    await fs.unlink(tmpPath).catch(() => {});
    throw new Error("Cancelled");
  }
  await fs.copyFile(tmpPath, saveUri.fsPath);
  await fs.unlink(tmpPath).catch(() => {});
  return { patchPath: saveUri.fsPath };
}
