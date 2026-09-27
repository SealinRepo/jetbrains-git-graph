import * as vscode from "vscode";
import type { GitService } from "../git/gitService";

export const GIT_BRAINS_SCHEME = "git-brains";

/**
 * Provides virtual file content for git file revisions.
 * Uri format: git-brains:/<filePath>?ref=<commitHash>
 *
 * A second form, git-brains:/<filePath>?changelist=<id>, serves a *changelist
 * scoped* revision: the committed content plus only the hunks that changelist
 * owns. That's the right-hand side of a list-scoped diff.
 *
 * Implements both TextDocumentContentProvider (for text diff) and
 * FileSystemProvider (for binary files like images).
 */
export class GitContentProvider
  implements vscode.TextDocumentContentProvider, vscode.FileSystemProvider
{
  private externalContent: Map<string, string> | null = null;
  /**
   * Resolves the changelist-scoped content for a file. Injected by the
   * extension host so this provider doesn't need to know about
   * ChangelistService (and so it stays trivially testable).
   */
  private changelistContent:
    | ((filePath: string, changelistId: string) => Promise<string>)
    | null = null;

  private _onDidChangeFile = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  constructor(private readonly gitService: GitService) {}

  setExternalContentMap(map: Map<string, string>): void {
    this.externalContent = map;
  }

  setChangelistContentResolver(
    resolver: (filePath: string, changelistId: string) => Promise<string>,
  ): void {
    this.changelistContent = resolver;
  }

  // ─── TextDocumentContentProvider ──────────────────────────────────

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // Check external content map first (used for shelf diffs)
    if (this.externalContent) {
      const external = this.externalContent.get(uri.toString());
      if (external !== undefined) {
        return external;
      }
    }

    const query = new URLSearchParams(uri.query);
    const filePath = uri.path.startsWith("/") ? uri.path.slice(1) : uri.path;
    if (!filePath) {
      return "";
    }

    // Changelist-scoped revision: committed content + this list's hunks only.
    const changelistId = query.get("changelist");
    if (changelistId) {
      if (!this.changelistContent) return "";
      return this.changelistContent(filePath, changelistId);
    }

    const ref = query.get("ref") ?? "";
    if (!ref) {
      return "";
    }
    return this.gitService.getFileContent(ref, filePath);
  }

  // ─── FileSystemProvider (for binary files) ────────────────────────

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(_uri: vscode.Uri): Promise<vscode.FileStat> {
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: 0,
    };
  }

  readDirectory(): Thenable<[string, vscode.FileType][]> {
    return Promise.resolve([]);
  }

  createDirectory(): void {}

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const ref = new URLSearchParams(uri.query).get("ref") ?? "";
    const filePath = uri.path.startsWith("/") ? uri.path.slice(1) : uri.path;
    if (!ref || !filePath) {
      return new Uint8Array(0);
    }
    const buffer = await this.gitService.getFileContentBuffer(ref, filePath);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions("Read-only git content");
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions("Read-only git content");
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Read-only git content");
  }
}
