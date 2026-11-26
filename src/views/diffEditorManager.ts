import * as vscode from "vscode";
import type { GitService } from "../git/gitService";
import type { DiffFile } from "../git/types";
import {
  createGitContentUri,
  GIT_BRAINS_SCHEME,
  normalizeGitFilePath,
} from "./gitContentProvider";

export class DiffEditorManager {
  /** Current diff navigation state */
  private diffFiles: DiffFile[] = [];
  private diffCommit = "";
  private diffIndex = -1;
  private diffBaseRef?: string;
  private diffCherryPickHashes?: string[];
  private diffOpenQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly gitService: GitService,
    private readonly workspaceRoot: string,
  ) {}

  /** Set the file list for diff navigation */
  setDiffFileList(
    files: DiffFile[],
    commit: string,
    baseRef?: string,
    cherryPickHashes?: string[],
  ): void {
    this.diffFiles = files;
    this.diffCommit = commit;
    this.diffBaseRef = baseRef;
    this.diffCherryPickHashes = cherryPickHashes;
    this.diffIndex = -1;
  }

  /** Set current index (when opening a specific file) */
  setCurrentIndex(index: number): void {
    this.diffIndex = index;
  }

  /** Navigate to next file diff */
  async nextDiff(): Promise<boolean> {
    if (this.diffFiles.length === 0) {
      void vscode.window.setStatusBarMessage(
        "$(info) No file list available. Open a diff from Changed Files first.",
        3000,
      );
      return false;
    }
    this.diffIndex = Math.min(this.diffIndex + 1, this.diffFiles.length - 1);
    await this.openCurrentDiff();
    return true;
  }

  /** Navigate to previous file diff */
  async prevDiff(): Promise<boolean> {
    if (this.diffFiles.length === 0) {
      void vscode.window.setStatusBarMessage(
        "$(info) No file list available. Open a diff from Changed Files first.",
        3000,
      );
      return false;
    }
    this.diffIndex = Math.max(this.diffIndex - 1, 0);
    await this.openCurrentDiff();
    return true;
  }

  private async openCurrentDiff(): Promise<void> {
    const file = this.diffFiles[this.diffIndex];
    if (!file) return;
    const filePath = file.newPath || file.oldPath;

    // Show status message
    const total = this.diffFiles.length;
    const current = this.diffIndex + 1;
    void vscode.window.setStatusBarMessage(
      `$(arrow-right) File ${current}/${total}: ${filePath.split("/").pop()}  —  Press again to go to the next file`,
      5000,
    );

    await this.openDiffEditor(
      this.diffCommit,
      filePath,
      file,
      this.diffBaseRef,
      this.diffCherryPickHashes,
    );
  }

  async openDiffEditor(
    commit: string,
    filePath: string,
    fileMeta?: DiffFile,
    baseRef?: string,
    cherryPickHashes?: string[],
  ): Promise<void> {
    filePath = normalizeGitFilePath(filePath);
    const status = fileMeta?.status ?? "modified";
    const oldPath = fileMeta?.oldPath ?? filePath;
    const newPath = fileMeta?.newPath ?? filePath;

    // Determine left (parent) and right (commit) refs
    let leftRef: string;
    let rightRef: string = commit;

    if (cherryPickHashes && cherryPickHashes.length > 1) {
      const range = await this.gitService.findFileRange(
        cherryPickHashes,
        newPath || oldPath,
      );
      if (range) {
        rightRef = range.newest;
        const parents = await this.gitService.getCommitParents(range.oldest);
        leftRef = parents[0] ?? "";
      } else {
        const parents = await this.gitService.getCommitParents(commit);
        leftRef = parents[0] ?? "";
      }
    } else if (baseRef) {
      leftRef = baseRef;
    } else {
      const parents = await this.gitService.getCommitParents(commit);
      leftRef = parents[0] ?? "";
    }

    // Build URIs based on file status
    let leftUri: vscode.Uri;
    let rightUri: vscode.Uri;

    switch (status) {
      case "added":
        leftUri = createGitContentUri(newPath, { ref: "empty" });
        rightUri = createGitContentUri(newPath, { ref: rightRef });
        break;
      case "deleted":
        leftUri = createGitContentUri(oldPath, { ref: leftRef });
        rightUri = createGitContentUri(oldPath, { ref: "empty" });
        break;
      case "renamed":
      case "copied":
        leftUri = createGitContentUri(oldPath, { ref: leftRef });
        rightUri = createGitContentUri(newPath, { ref: rightRef });
        break;
      default: // modified
        leftUri = createGitContentUri(newPath, { ref: leftRef });
        rightUri = createGitContentUri(newPath, { ref: rightRef });
        break;
    }

    // Build title
    const fileName = filePath.split("/").pop() ?? filePath;
    const shortHash = commit.substring(0, 7);
    const title =
      cherryPickHashes && cherryPickHashes.length > 1
        ? `${fileName} (${cherryPickHashes.length} commits)`
        : baseRef
          ? `${fileName} (${baseRef.substring(0, 7)}..${shortHash})`
          : `${fileName} (${shortHash})`;

    await this.openDiffUris(leftUri, rightUri, title);
  }

  async openDiffUris(
    leftUri: vscode.Uri,
    rightUri: vscode.Uri,
    title: string,
  ): Promise<void> {
    const opening = this.diffOpenQueue.then(() =>
      this.openDiffUrisNow(leftUri, rightUri, title),
    );
    this.diffOpenQueue = opening.then(
      () => undefined,
      () => undefined,
    );
    return opening;
  }

  private async openDiffUrisNow(
    leftUri: vscode.Uri,
    rightUri: vscode.Uri,
    title: string,
  ): Promise<void> {
    leftUri = this.withWorkspaceRoot(leftUri);
    rightUri = this.withWorkspaceRoot(rightUri);

    await Promise.all([
      vscode.workspace.openTextDocument(leftUri),
      vscode.workspace.openTextDocument(rightUri),
    ]);

    const viewColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      title,
      { viewColumn, preview: false },
    );
    await this.ensureSideBySideView();
    await this.moveDiffTabToFirst(leftUri, rightUri, viewColumn);
  }

  private async moveDiffTabToFirst(
    leftUri: vscode.Uri,
    rightUri: vscode.Uri,
    viewColumn: vscode.ViewColumn,
  ): Promise<void> {
    const findDiffIndex = () => {
      const group = vscode.window.tabGroups.all.find(
        (candidate) => candidate.viewColumn === viewColumn,
      );
      return (
        group?.tabs.findIndex(
          (tab) =>
            tab.input instanceof vscode.TabInputTextDiff &&
            tab.input.original.toString() === leftUri.toString() &&
            tab.input.modified.toString() === rightUri.toString(),
        ) ?? -1
      );
    };
    const index = findDiffIndex();
    if (index < 0) {
      throw new Error("Could not find the newly opened diff tab.");
    }
    if (index === 0) return;

    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes("moveActiveEditor")) {
      throw new Error("Cannot move the diff tab to the first position.");
    }

    await vscode.commands.executeCommand("moveActiveEditor", {
      to: "first",
      by: "tab",
    });
    if (findDiffIndex() !== 0) {
      throw new Error("Could not move the diff tab to the first position.");
    }
  }

  private withWorkspaceRoot(uri: vscode.Uri): vscode.Uri {
    if (uri.scheme !== GIT_BRAINS_SCHEME) return uri;

    const query = new URLSearchParams(uri.query);
    query.set("workspaceRoot", this.workspaceRoot);
    return uri.with({ query: query.toString() });
  }

  private async ensureSideBySideView(): Promise<void> {
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes("diffEditor.setViewMode.sideBySide")) {
      await vscode.commands.executeCommand("diffEditor.setViewMode.sideBySide");
      return;
    }

    const renderSideBySide = vscode.workspace
      .getConfiguration("diffEditor")
      .get<boolean>("renderSideBySide", true);
    if (
      !renderSideBySide &&
      commands.includes("toggle.diff.renderSideBySide")
    ) {
      await vscode.commands.executeCommand("toggle.diff.renderSideBySide");
    }
  }
}
