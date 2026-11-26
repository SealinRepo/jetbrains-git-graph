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
  private diffEditorViewColumn?: vscode.ViewColumn;
  private sourceEditorViewColumn?: vscode.ViewColumn;
  private sourceEditorUris: string[] = [];
  private diffLayoutMaximized = false;
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

  getSourceViewColumn(): vscode.ViewColumn | undefined {
    const groups = vscode.window.tabGroups.all;
    const sourceGroup = groups.find(
      (group) =>
        group.viewColumn !== this.diffEditorViewColumn &&
        group.tabs.some(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            this.sourceEditorUris.includes(tab.input.uri.toString()),
        ),
    );
    if (sourceGroup) {
      this.sourceEditorViewColumn = sourceGroup.viewColumn;
      return sourceGroup.viewColumn;
    }

    const savedGroup = groups.find(
      (group) =>
        group.viewColumn === this.sourceEditorViewColumn &&
        group.viewColumn !== this.diffEditorViewColumn,
    );
    return (
      savedGroup?.viewColumn ??
      groups.find((group) => group.viewColumn !== this.diffEditorViewColumn)
        ?.viewColumn
    );
  }

  async restoreEditorGroups(): Promise<void> {
    if (!this.diffLayoutMaximized) return;

    if (
      !vscode.window.tabGroups.all.some(
        (group) => group.viewColumn === this.diffEditorViewColumn,
      )
    ) {
      this.diffLayoutMaximized = false;
      return;
    }

    await vscode.commands.executeCommand(
      "workbench.action.toggleMaximizeEditorGroup",
    );
    this.diffLayoutMaximized = false;
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

    let diffGroup =
      this.diffEditorViewColumn === undefined
        ? undefined
        : vscode.window.tabGroups.all.find(
            (group) => group.viewColumn === this.diffEditorViewColumn,
          );
    const hasDiffTab = (group: vscode.TabGroup) =>
      group.tabs.some(
        (tab) =>
          tab.input instanceof vscode.TabInputTextDiff &&
          (tab.input.original.scheme === GIT_BRAINS_SCHEME ||
            tab.input.modified.scheme === GIT_BRAINS_SCHEME),
      );
    if (diffGroup && !hasDiffTab(diffGroup)) {
      if (diffGroup.tabs.length === 0) {
        await vscode.window.tabGroups.close(diffGroup, true);
      }
      diffGroup = undefined;
    }

    if (!diffGroup) {
      this.diffLayoutMaximized = false;
      const sourceGroup = vscode.window.tabGroups.activeTabGroup;
      this.sourceEditorViewColumn = sourceGroup.viewColumn;
      this.sourceEditorUris = sourceGroup.tabs.flatMap((tab) =>
        tab.input instanceof vscode.TabInputText
          ? [tab.input.uri.toString()]
          : [],
      );
      await vscode.commands.executeCommand("workbench.action.newGroupRight");
      diffGroup = vscode.window.tabGroups.activeTabGroup;
      this.diffEditorViewColumn = diffGroup.viewColumn;
    }

    if (!this.diffLayoutMaximized && vscode.window.tabGroups.all.length > 1) {
      if (
        vscode.window.tabGroups.activeTabGroup.viewColumn !==
        diffGroup.viewColumn
      ) {
        throw new Error("The diff editor group is not active.");
      }
      const commands = await vscode.commands.getCommands(true);
      if (!commands.includes("workbench.action.toggleMaximizeEditorGroup")) {
        throw new Error("Cannot maximize the diff editor group.");
      }
      await vscode.commands.executeCommand(
        "workbench.action.toggleMaximizeEditorGroup",
      );
      this.diffLayoutMaximized = true;
      await this.waitForDiffGroupLayout(diffGroup.viewColumn);
    }

    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      title,
      { viewColumn: diffGroup.viewColumn, preview: false },
    );
    await this.ensureSideBySideView();
  }

  private async waitForDiffGroupLayout(
    viewColumn: vscode.ViewColumn,
  ): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const diffGroup = vscode.window.tabGroups.all.find(
      (group) => group.viewColumn === viewColumn,
    );
    if (
      !diffGroup ||
      vscode.window.tabGroups.activeTabGroup.viewColumn !== viewColumn
    ) {
      throw new Error("The diff editor group layout did not stabilize.");
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
