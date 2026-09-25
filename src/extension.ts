import * as nodefs from "node:fs/promises";
import * as vscode from "vscode";
import { AiService } from "./ai/aiService";
import { BranchDivergedError, GitService } from "./git/gitService";
import type {
  DiffFile,
  GitLogger,
  LaneSnapshot,
  WorkingTreeFile,
} from "./git/types";
import { MessageRouter } from "./messages/messageRouter";
import { GitDomain } from "./state/domains";
import { GitStateNotifier } from "./state/gitStateNotifier";
import { CommitViewProvider } from "./views/commitViewProvider";
import { ConflictsManager } from "./views/conflictsManager";
import { DiffEditorManager } from "./views/diffEditorManager";
import {
  GIT_BRAINS_SCHEME,
  GitContentProvider,
} from "./views/gitContentProvider";
import { GitLogViewProvider } from "./views/gitLogViewProvider";
import { MergeEditorManager } from "./views/mergeEditorManager";
import { PushPanel } from "./views/pushPanel";
import type { RollbackFileInfo } from "./views/rollbackPanel";
import { RollbackPanel } from "./views/rollbackPanel";
import { GitWatcher } from "./watchers/gitWatcher";

const NOT_GIT_REPO = { status: "not_git_repo" as const, data: null };

/** Temporary storage for shelf diff content (base/modified) */
const shelfDiffContent = new Map<string, string>();

function formatLogTimestamp(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  return `${datePart} ${timePart}`;
}

/** Wrap a git operation with progress events */
function withProgress(
  messageRouter: MessageRouter,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  messageRouter.broadcastEvent("busyStart", undefined);
  return fn().finally(() => {
    messageRouter.broadcastEvent("busyEnd", undefined);
  });
}

export function activate(context: vscode.ExtensionContext) {
  // 1. MessageRouter (always created)
  const messageRouter = new MessageRouter();

  // 1b. Output channel: logs every git CLI command this extension runs
  const gitOutputChannel = vscode.window.createOutputChannel("Git Graph");
  context.subscriptions.push(gitOutputChannel);
  const gitLogger: GitLogger = {
    log: (level, message) => {
      const timestamp = formatLogTimestamp(new Date());
      for (const line of message.split("\n")) {
        gitOutputChannel.appendLine(`${timestamp} [${level}] ${line}`);
      }
    },
  };

  // 1c. AI service: persists config in globalState, API keys in SecretStorage
  const aiService = new AiService(context.secrets, context.globalState);

  // 2. GitLogViewProvider (always registered)
  const logProvider = new GitLogViewProvider(
    context.extensionUri,
    messageRouter,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GitLogViewProvider.viewType,
      logProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // 2b. Git services for all workspace folders
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const allWorkspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(
    (f) => f.uri.fsPath,
  );
  let gitService: GitService | null = null;
  let diffManager: DiffEditorManager | null = null;

  const allGitServices: GitService[] = [];
  for (const root of allWorkspaceRoots) {
    allGitServices.push(new GitService(root, gitLogger));
  }

  // git 状态变更的唯一出口：失效缓存 + 按域广播。watcher 和各 handler 共用它。
  const notifier = new GitStateNotifier(
    messageRouter,
    allGitServices.map((s) => s.cache),
  );

  const currentLineGitInfoDecoration =
    vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "italic",
        margin: "0 0 0 12px",
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

  function formatBlameText(raw: string): string | null {
    const lines = raw.split(/\r?\n/);
    let hash = "";
    let author = "";
    let date = "";
    let summary = "";

    for (const line of lines) {
      if (!line) continue;
      if (/^[0-9a-fA-F]{40}\s/.test(line)) {
        hash = line.trimStart().split(/\s+/)[0].slice(0, 7);
        continue;
      }
      if (line.startsWith("author ")) {
        author = line.slice("author ".length).trim();
        continue;
      }
      if (line.startsWith("author-time ")) {
        const seconds = Number.parseInt(
          line.slice("author-time ".length).trim(),
          10,
        );
        if (Number.isFinite(seconds)) {
          date = new Date(seconds * 1000).toISOString().slice(0, 10);
        }
        continue;
      }
      if (line.startsWith("summary ")) {
        summary = line.slice("summary ".length).trim();
        continue;
      }
      if (line.startsWith("\t")) {
        // Ignore the actual source line, which is emitted after the metadata.
      }
    }

    if (!hash && !author && !summary) {
      return null;
    }

    const authorPart = author || "unknown";
    const datePart = date || "unknown date";
    const summaryPart = summary || "no message";
    const hashPart = hash ? ` ${hash}` : "";
    return `${authorPart} - ${datePart} - ${summaryPart} -${hashPart}`;
  }

  async function updateCurrentLineGitInfo(
    editor?: vscode.TextEditor,
  ): Promise<void> {
    if (!editor || !gitService) {
      for (const visibleEditor of vscode.window.visibleTextEditors) {
        visibleEditor.setDecorations(currentLineGitInfoDecoration, []);
      }
      return;
    }

    const doc = editor.document;
    const filePath = vscode.workspace.asRelativePath(doc.uri, false);
    if (!filePath || filePath.startsWith("..")) {
      editor.setDecorations(currentLineGitInfoDecoration, []);
      return;
    }

    const line = editor.selection.active.line;
    if (line < 0 || line >= doc.lineCount) {
      editor.setDecorations(currentLineGitInfoDecoration, []);
      return;
    }

    try {
      const blame = await gitService.annotateLine(filePath, line + 1);
      const info = formatBlameText(blame);
      if (!info) {
        editor.setDecorations(currentLineGitInfoDecoration, []);
        return;
      }
      const lineText = doc.lineAt(line).text;
      const end = lineText.length;
      editor.setDecorations(currentLineGitInfoDecoration, [
        {
          range: new vscode.Range(line, end, line, end),
          renderOptions: {
            after: {
              contentText: ` ${info}`,
              color: new vscode.ThemeColor("editorCodeLens.foreground"),
              fontStyle: "italic",
              fontWeight: "500",
            },
          },
        },
      ]);
    } catch {
      editor.setDecorations(currentLineGitInfoDecoration, []);
    }
  }

  context.subscriptions.push(
    currentLineGitInfoDecoration,
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        void updateCurrentLineGitInfo(editor);
      } else {
        for (const visibleEditor of vscode.window.visibleTextEditors) {
          visibleEditor.setDecorations(currentLineGitInfoDecoration, []);
        }
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      void updateCurrentLineGitInfo(event.textEditor);
    }),
  );

  if (workspaceRoot) {
    gitService = allGitServices[0] ?? new GitService(workspaceRoot, gitLogger);

    // Register virtual document provider for git file content
    const contentProvider = new GitContentProvider(gitService);
    contentProvider.setExternalContentMap(shelfDiffContent);
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        GIT_BRAINS_SCHEME,
        contentProvider,
      ),
      vscode.workspace.registerFileSystemProvider(
        GIT_BRAINS_SCHEME,
        contentProvider,
        { isReadonly: true },
      ),
    );

    diffManager = new DiffEditorManager(gitService);
  }

  // 2c. CommitViewProvider (always registered)
  const commitProvider = new CommitViewProvider(
    context.extensionUri,
    messageRouter,
    notifier,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CommitViewProvider.viewType,
      commitProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  /** 汇总所有 workspace 的工作区改动列表，跳过不是 git 仓库的目录。 */
  async function aggregateWorkingTreeChanges(): Promise<WorkingTreeFile[]> {
    const allChanges: WorkingTreeFile[] = [];
    for (const svc of allGitServices) {
      try {
        const changes = await svc.getWorkingTreeChanges();
        allChanges.push(...changes);
      } catch {
        // Skip folders that aren't git repos
      }
    }
    return allChanges;
  }

  /** 刷新活动栏图标上的角标：Changes + Unversioned Files 数量（不含冲突文件）。 */
  async function updateCommitBadge(): Promise<void> {
    if (allGitServices.length === 0) return;
    try {
      const allChanges = await aggregateWorkingTreeChanges();
      const count = allChanges.filter((f) => f.status !== "conflicted").length;
      commitProvider.setBadge(count);
    } catch {
      // Ignore transient errors (e.g. mid-rebase status query failures)
    }
  }
  // Defer to next tick so the badge query (which spawns git processes) doesn't
  // compete with VS Code's 10-second activation timeout window. `activate()`
  // returns first; the badge updates once the next event loop turn runs.
  setImmediate(() => {
    void updateCommitBadge();
  });
  context.subscriptions.push(
    messageRouter.onBroadcast((msg) => {
      if (msg.event === "worktreeChanged") {
        void updateCommitBadge();
      }
    }),
  );

  // 3. MergeEditorManager + ConflictsManager (always created)
  const mergeManager = new MergeEditorManager(
    context.extensionUri,
    messageRouter,
  );
  const conflictsManager = new ConflictsManager(
    context.extensionUri,
    messageRouter,
  );

  // 4. PushPanel
  const pushPanel = new PushPanel(context.extensionUri, messageRouter);

  // 4b. RollbackPanel
  const rollbackPanel = new RollbackPanel(context.extensionUri, messageRouter);

  // 5. Register VSCode commands (always registered)
  context.subscriptions.push(
    vscode.commands.registerCommand("git-brains.openPushPanel", async () => {
      if (!gitService) return;
      const branch = await gitService.getCurrentBranch();
      if (branch) {
        const remote = await gitService.getDefaultRemote(branch);
        pushPanel.open(branch, remote);
      }
    }),
    vscode.commands.registerCommand(
      "git-brains.openMergeEditor",
      (file?: string) => {
        mergeManager.openMergeEditor(file ?? "untitled");
      },
    ),
    vscode.commands.registerCommand(
      "git-brains.openDiffEditor",
      (commit?: string, filePath?: string) => {
        if (commit && filePath && diffManager) {
          diffManager.openDiffEditor(commit, filePath);
        }
      },
    ),
    vscode.commands.registerCommand("git-brains.refreshLog", () => {
      notifier.notifyAll();
    }),
    vscode.commands.registerCommand("git-brains.nextDiff", async () => {
      if (diffManager) {
        const result = await diffManager.nextDiff();
        if (!result) {
          void vscode.window.showInformationMessage(
            "JetGit: No diff file list. Double-click a file in Changed Files first.",
          );
        }
      } else {
        void vscode.window.showInformationMessage("JetGit: No workspace open.");
      }
    }),
    vscode.commands.registerCommand("git-brains.prevDiff", async () => {
      if (diffManager) {
        const result = await diffManager.prevDiff();
        if (!result) {
          void vscode.window.showInformationMessage(
            "JetGit: No diff file list. Double-click a file in Changed Files first.",
          );
        }
      } else {
        void vscode.window.showInformationMessage("JetGit: No workspace open.");
      }
    }),
    vscode.commands.registerCommand("git-brains.openConflicts", () => {
      conflictsManager.openConflictsPanel();
    }),
    vscode.commands.registerCommand(
      "git-brains.openMergeEditorFromSCM",
      (arg?: unknown) => {
        const filePath = getScmResourcePath(arg);
        if (!filePath) {
          void vscode.window.showWarningMessage(
            "Unable to locate conflict file from SCM item.",
          );
          return;
        }
        mergeManager.openMergeEditor(filePath);
      },
    ),
    vscode.commands.registerCommand(
      "git-brains.showFileHistory",
      async (uri?: vscode.Uri) => {
        const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!fileUri || !workspaceRoot) return;
        const relativePath = vscode.workspace.asRelativePath(fileUri, false);
        await vscode.commands.executeCommand("git-brains.gitLog.focus");
        messageRouter.broadcastEvent("showFileHistory", {
          file: relativePath,
        });
      },
    ),
    vscode.commands.registerCommand(
      "git-brains.compareWithRevision",
      async (arg?: unknown) => {
        const uri =
          (arg instanceof vscode.Uri ? arg : undefined) ??
          vscode.window.activeTextEditor?.document.uri;
        if (!uri || !workspaceRoot || !gitService) return;
        const filePath =
          getScmResourcePath(uri) ??
          vscode.workspace.asRelativePath(uri, false);
        const revision = await vscode.window.showInputBox({
          prompt: `Compare ${filePath} with revision:`,
          placeHolder: "main, HEAD~1, v1.2.3, <hash>",
          value: "HEAD",
        });
        if (!revision || !revision.trim()) return;
        const ref = revision.trim();
        const left = vscode.Uri.file(
          vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), filePath).fsPath,
        );
        const right = vscode.Uri.parse(
          `${GIT_BRAINS_SCHEME}:/${filePath}?ref=${encodeURIComponent(ref)}`,
        );
        await vscode.commands.executeCommand(
          "vscode.diff",
          left,
          right,
          `${filePath} (${ref})`,
        );
      },
    ),
    vscode.commands.registerCommand(
      "git-brains.annotateFile",
      async (arg?: unknown) => {
        const uri =
          (arg instanceof vscode.Uri ? arg : undefined) ??
          vscode.window.activeTextEditor?.document.uri;
        if (!uri || !workspaceRoot || !gitService) return;
        const filePath =
          getScmResourcePath(uri) ??
          vscode.workspace.asRelativePath(uri, false);
        const blame = await gitService.annotateFile(filePath);
        const channel = vscode.window.createOutputChannel("Git Annotate");
        channel.clear();
        channel.appendLine(`Annotate: ${filePath}`);
        channel.appendLine(blame.trim() || "No blame information available.");
        channel.show(true);
      },
    ),
    vscode.commands.registerCommand(
      "git-brains.addToVcs",
      async (arg?: unknown) => {
        const uri =
          (arg instanceof vscode.Uri ? arg : undefined) ??
          vscode.window.activeTextEditor?.document.uri;
        if (!uri || !workspaceRoot || !gitService) return;
        const filePath =
          getScmResourcePath(uri) ??
          vscode.workspace.asRelativePath(uri, false);
        const ignored = await gitService.isIgnored(filePath);
        if (ignored) {
          const choice = await vscode.window.showWarningMessage(
            `File "${filePath}" is ignored by .gitignore. Force add it?`,
            { modal: true },
            "Force Add",
          );
          if (choice !== "Force Add") return;
          await gitService.stageFile(filePath, true);
        } else {
          await gitService.stageFile(filePath);
        }
        notifier.notify(GitDomain.Worktree);
      },
    ),
    vscode.commands.registerCommand(
      "git-brains.rollbackContextFile",
      async (arg?: unknown) => {
        const uri =
          (arg instanceof vscode.Uri ? arg : undefined) ??
          vscode.window.activeTextEditor?.document.uri;
        if (!uri || !workspaceRoot || !gitService) return;
        const filePath =
          getScmResourcePath(uri) ??
          vscode.workspace.asRelativePath(uri, false);
        const choice = await vscode.window.showWarningMessage(
          `Rollback changes to "${filePath}"? This cannot be undone.`,
          { modal: true },
          "Rollback",
        );
        if (choice !== "Rollback") return;
        await gitService.rollbackFile(filePath);
        notifier.notify(GitDomain.Worktree);
      },
    ),
    vscode.commands.registerCommand("git-brains.editSource", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const uri = editor.document.uri;
      const line = editor.selection.active.line;
      const character = editor.selection.active.character;

      // Resolve the actual workspace file path from diff URI
      // Format: git-brains:/<relativePath>?ref=<commitHash>
      let filePath: string | undefined;

      if (uri.scheme === "file") {
        filePath = uri.fsPath;
      } else if (uri.scheme === "git-brains" || uri.scheme === "git") {
        // Extract relative path from URI path (strip leading /)
        const relativePath = uri.path.startsWith("/")
          ? uri.path.slice(1)
          : uri.path;
        if (relativePath && workspaceRoot) {
          filePath = vscode.Uri.joinPath(
            vscode.Uri.file(workspaceRoot),
            relativePath,
          ).fsPath;
        }
      } else {
        // Other schemes (e.g. vscode builtin git) — try path
        const relativePath = uri.path.startsWith("/")
          ? uri.path.slice(1)
          : uri.path;
        if (relativePath && workspaceRoot) {
          filePath = vscode.Uri.joinPath(
            vscode.Uri.file(workspaceRoot),
            relativePath,
          ).fsPath;
        }
      }

      if (!filePath) return;

      // Check if file exists before opening
      const fileUri = vscode.Uri.file(filePath);
      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch {
        void vscode.window.showWarningMessage(
          "Source file does not exist in the working directory.",
        );
        return;
      }

      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(line, character, line, character),
        preview: false,
      });
    }),
  );

  // 6. Register command handlers to MessageRouter
  // If GitService is unavailable, handlers return { status: 'not_git_repo' }

  messageRouter.handle("openMergeEditor", async (params) => {
    const file = (params.file as string) ?? "untitled";
    mergeManager.openMergeEditor(file);
    return undefined;
  });

  messageRouter.handle("openDiffEditor", async (params) => {
    if (!diffManager) return undefined;
    const commit = params.commit as string;
    const filePathParam = params.filePath as string | undefined;
    const fileParam = params.file as string | DiffFile | undefined;
    const baseRef = params.baseRef as string | undefined;
    const cherryPickHashes = params.cherryPickHashes as string[] | undefined;
    const fileList = params.fileList as DiffFile[] | undefined;
    const fileMeta =
      typeof fileParam === "object" && fileParam !== null
        ? (fileParam as DiffFile)
        : undefined;
    const filePath =
      filePathParam ??
      (typeof fileParam === "string" ? fileParam : undefined) ??
      fileMeta?.newPath ??
      fileMeta?.oldPath;

    if (commit && filePath) {
      // Set file list for next/prev navigation
      if (fileList && fileList.length > 0) {
        diffManager.setDiffFileList(
          fileList,
          commit,
          baseRef,
          cherryPickHashes,
        );
        // Set current index to the file being opened
        const idx = fileList.findIndex(
          (f) => (f.newPath || f.oldPath) === filePath,
        );
        if (idx >= 0) {
          diffManager.setCurrentIndex(idx);
        }
      }

      await diffManager.openDiffEditor(
        commit,
        filePath,
        fileMeta,
        baseRef,
        cherryPickHashes,
      );
    }
    return undefined;
  });

  messageRouter.handle("getGraphData", async (params) => {
    if (!gitService) {
      return NOT_GIT_REPO;
    }
    const options = {
      maxCount: (params.maxCount as number) ?? 200,
      skip: params.skip as number | undefined,
      branch: params.branch as string | undefined,
      search: params.search as string | undefined,
      author: params.author as string | undefined,
      file: params.file as string | undefined,
    };
    const snapshot = params.snapshot as LaneSnapshot | undefined;
    const result = await gitService.getGraphTopology(options, snapshot);
    return result;
  });

  messageRouter.handle("getLog", async (params) => {
    if (!gitService) {
      return NOT_GIT_REPO;
    }
    return gitService.getLog(
      params as Record<string, unknown> & { maxCount?: number },
    );
  });

  messageRouter.handle("loadMoreLog", async (params) => {
    if (!gitService) {
      return NOT_GIT_REPO;
    }
    const options = {
      maxCount: (params.count as number) ?? 200,
      skip: (params.skip as number) ?? 0,
      branch: params.branch as string | undefined,
      search: params.search as string | undefined,
      author: params.author as string | undefined,
    };
    const snapshot = params.snapshot as LaneSnapshot | undefined;
    const result = await gitService.getGraphTopology(options, snapshot);
    return result;
  });

  messageRouter.handle("getBranches", async () => {
    if (!gitService) {
      return NOT_GIT_REPO;
    }
    return gitService.getBranches();
  });

  messageRouter.handle("getRemoteBranches", async () => {
    if (!gitService) {
      return NOT_GIT_REPO;
    }
    // Invalidate branch cache to reflect latest remote changes
    gitService.cache.invalidate("branches");
    return gitService.getRemoteBranches();
  });

  messageRouter.handle("getTags", async () => {
    if (!gitService) {
      return NOT_GIT_REPO;
    }
    return gitService.getTags();
  });

  messageRouter.handle("getDiff", async (params) => {
    if (!gitService) {
      return NOT_GIT_REPO;
    }
    const ref1 = params.ref1 as string;
    const ref2 = params.ref2 as string;
    const file = params.file as string | undefined;
    return gitService.getDiff(ref1, ref2, file);
  });

  messageRouter.handle("getFileContent", async (params) => {
    if (!gitService) {
      return NOT_GIT_REPO;
    }
    const ref = params.ref as string;
    const filePath = params.filePath as string;
    return gitService.getFileContent(ref, filePath);
  });

  messageRouter.handle("getCommitFiles", async (params) => {
    if (!gitService) {
      return NOT_GIT_REPO;
    }
    const hash = params.hash as string;
    return gitService.getCommitFiles(hash);
  });

  messageRouter.handle("getCommitRangeFiles", async (params) => {
    if (!gitService) {
      return NOT_GIT_REPO;
    }
    const hashes = params.hashes as string[];
    return gitService.getCommitRangeFiles(hashes);
  });

  messageRouter.handle("getStatus", async () => {
    if (!gitService) {
      return NOT_GIT_REPO;
    }
    return gitService.getStatus();
  });

  messageRouter.handle("getMergeState", async () => {
    if (!gitService) return NOT_GIT_REPO;
    return gitService.getMergeState();
  });

  messageRouter.handle("getCherryPickState", async () => {
    if (!gitService) return { isCherryPicking: false };
    return gitService.getCherryPickState();
  });

  messageRouter.handle("cherryPickAction", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const action = params.action as "continue" | "abort" | "skip";
    return withProgress(messageRouter, async () => {
      await gitService.cherryPickAction(action);
      notifier.notify(GitDomain.Refs, GitDomain.Worktree, GitDomain.Operation);
      return { success: true };
    });
  });

  messageRouter.handle("getRebaseState", async () => {
    if (!gitService) return { isRebasing: false };
    return gitService.getRebaseState();
  });

  messageRouter.handle("rebaseAction", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const action = params.action as "continue" | "abort" | "skip";
    return withProgress(messageRouter, async () => {
      await gitService.rebaseAction(action);
      notifier.notify(GitDomain.Refs, GitDomain.Worktree, GitDomain.Operation);
      return { success: true };
    });
  });

  messageRouter.handle("mergeAction", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const action = params.action as "continue" | "abort";
    return withProgress(messageRouter, async () => {
      if (action === "continue") {
        await gitService.mergeContinue();
      } else {
        await gitService.mergeAbort();
      }
      notifier.notify(GitDomain.Refs, GitDomain.Worktree, GitDomain.Operation);
      return { success: true };
    });
  });

  messageRouter.handle("getConflictFiles", async () => {
    if (!gitService) return NOT_GIT_REPO;
    return gitService.getConflictFiles();
  });

  messageRouter.handle("openConflictsPanel", async () => {
    await vscode.commands.executeCommand("git-brains.openConflicts");
    return { success: true };
  });

  messageRouter.handle("getFileVersions", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const filePath = params.filePath as string;
    const versions = await gitService.getFileVersions(filePath);
    const mergeState = await gitService.getMergeState();
    const ext = filePath.split(".").pop() ?? "";
    return {
      ...versions,
      language: extToLanguage(ext),
      mergeMsg: mergeState.mergeMsg,
    };
  });

  messageRouter.handle("saveMergedContent", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    await gitService.saveMergedContent(
      params.filePath as string,
      params.content as string,
    );
    return { success: true };
  });

  messageRouter.handle("stageFile", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const filePath = params.filePath as string;
    const force = Boolean(params.force);
    if (!force && (await gitService.isIgnored(filePath))) {
      const choice = await vscode.window.showWarningMessage(
        `File "${filePath}" is ignored by .gitignore. Force add it?`,
        { modal: true },
        "Force Add",
      );
      if (choice !== "Force Add") {
        return { success: false, cancelled: true };
      }
    }
    await gitService.stageFile(
      filePath,
      force || (await gitService.isIgnored(filePath)),
    );
    notifier.notify(GitDomain.Worktree);
    return { success: true };
  });

  messageRouter.handle("compareFileWithRevision", async (params) => {
    if (!gitService || !workspaceRoot) return NOT_GIT_REPO;
    const filePath = params.filePath as string;
    const ref = (params.ref as string | undefined)?.trim();
    if (!filePath || !ref) {
      return {
        success: false,
        error: { message: "File path and revision are required" },
      };
    }
    const left = vscode.Uri.file(
      vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), filePath).fsPath,
    );
    const right = vscode.Uri.parse(
      `${GIT_BRAINS_SCHEME}:/${filePath}?ref=${encodeURIComponent(ref)}`,
    );
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${filePath} (${ref})`,
    );
    return { success: true };
  });

  messageRouter.handle("annotateFile", async (params) => {
    if (!gitService || !workspaceRoot) return NOT_GIT_REPO;
    const filePath = params.filePath as string;
    if (!filePath) {
      return { success: false, error: { message: "File path is required" } };
    }
    const blame = await gitService.annotateFile(filePath);
    const channel = vscode.window.createOutputChannel("Git Annotate");
    channel.clear();
    channel.appendLine(`Annotate: ${filePath}`);
    channel.appendLine(blame.trim() || "No blame information available.");
    channel.show(true);
    return { success: true };
  });

  messageRouter.handle("showFileHistory", async (params) => {
    if (!gitService || !workspaceRoot) return NOT_GIT_REPO;
    const file = (params.file as string | undefined)?.trim();
    if (!file) {
      return { success: false, error: { message: "File path is required" } };
    }
    await vscode.commands.executeCommand("git-brains.gitLog.focus");
    messageRouter.broadcastEvent("showFileHistory", { file });
    return { success: true };
  });

  messageRouter.handle("acceptOurs", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    await gitService.acceptOurs(params.filePath as string);
    return { success: true };
  });

  messageRouter.handle("acceptTheirs", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    await gitService.acceptTheirs(params.filePath as string);
    return { success: true };
  });

  messageRouter.handle("confirmCancelMerge", async (params) => {
    const hasChanges = params.hasChanges as boolean;
    if (!hasChanges) return { confirmed: true };
    const choice = await vscode.window.showWarningMessage(
      "You have unsaved merge changes. Discard them?",
      { modal: true },
      "Discard",
    );
    return { confirmed: choice === "Discard" };
  });

  messageRouter.handle("closeMergeEditor", async (params) => {
    const filePath = params.filePath as string;
    mergeManager.closeMergeEditor(filePath);
    return { success: true };
  });

  messageRouter.handle("openFile", async (params) => {
    const filePath = params.filePath as string;
    const absPath = workspaceRoot
      ? vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), filePath)
      : vscode.Uri.file(filePath);
    try {
      await vscode.commands.executeCommand("vscode.open", absPath);
    } catch {
      // Fallback for files that can't be opened in any editor
      await vscode.env.openExternal(absPath);
    }
    return { success: true };
  });

  messageRouter.handle("showInputBox", async (params) => {
    const prompt = params.prompt as string | undefined;
    const value = params.value as string | undefined;
    const placeHolder = params.placeHolder as string | undefined;
    const result = await vscode.window.showInputBox({
      prompt,
      value,
      placeHolder,
    });
    return { value: result ?? null };
  });

  messageRouter.handle("showConfirmMessage", async (params) => {
    const message = params.message as string;
    const confirmLabel = (params.confirmLabel as string) || "OK";
    const result = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      confirmLabel,
    );
    return { confirmed: result === confirmLabel };
  });

  messageRouter.handle("showErrorNotification", async (params) => {
    const message = params.message as string;
    void vscode.window.showErrorMessage(message);
    return { success: true };
  });

  messageRouter.handle("showInfoNotification", async (params) => {
    const message = params.message as string;
    void vscode.window.showInformationMessage(message);
    return { success: true };
  });

  messageRouter.handle("checkoutBranch", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const branchName = params.branchName as string;
    return withProgress(messageRouter, async () => {
      await gitService.checkout(branchName);
      notifier.notify(GitDomain.Refs, GitDomain.Worktree);
      return { success: true };
    });
  });

  messageRouter.handle("createBranch", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const newBranchName = params.newBranchName as string;
    const startPoint = params.startPoint as string;
    const checkout = params.checkout as boolean | undefined;
    const force = params.force as boolean | undefined;
    await gitService.createBranch(newBranchName, startPoint, force ?? false);
    if (checkout) {
      await gitService.checkout(newBranchName);
    }
    notifier.notify(GitDomain.Refs);
    return { success: true };
  });

  messageRouter.handle("deleteBranch", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const branchName = params.branchName as string;
    const isRemote = params.isRemote as boolean;
    const force = params.force as boolean | undefined;
    if (isRemote) {
      await gitService.deleteRemoteBranch(branchName);
    } else {
      await gitService.deleteBranch(branchName, force ?? false);
    }
    notifier.notify(GitDomain.Refs);
    return { success: true };
  });

  messageRouter.handle("renameBranch", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const oldName = params.oldName as string;
    const newName = params.newName as string;
    await gitService.renameBranch(oldName, newName);
    notifier.notify(GitDomain.Refs);
    return { success: true };
  });

  messageRouter.handle("mergeBranch", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const branchName = params.branchName as string;
    return withProgress(messageRouter, async () => {
      await gitService.merge(branchName);
      notifier.notify(GitDomain.Refs, GitDomain.Worktree, GitDomain.Operation);
      return { success: true };
    });
  });

  messageRouter.handle("rebaseBranch", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const onto = params.onto as string;
    return withProgress(messageRouter, async () => {
      await gitService.rebase(onto);
      notifier.notify(GitDomain.Refs, GitDomain.Worktree, GitDomain.Operation);
      return { success: true };
    });
  });

  messageRouter.handle("checkoutAndRebase", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const branchToCheckout = params.branchToCheckout as string;
    const rebaseOnto = params.rebaseOnto as string;
    return withProgress(messageRouter, async () => {
      await gitService.checkoutAndRebase(branchToCheckout, rebaseOnto);
      notifier.notify(GitDomain.Refs, GitDomain.Worktree, GitDomain.Operation);
      return { success: true };
    });
  });

  messageRouter.handle("pushBranch", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const branchName = params.branchName as string;
    const force = params.force as boolean | undefined;
    return withProgress(messageRouter, async () => {
      await gitService.push(branchName, force ?? false);
      notifier.notify(GitDomain.Refs);
      return { success: true };
    });
  });

  messageRouter.handle("getAheadCommits", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const branchName = params.branchName as string;
    const remote = params.remote as string | undefined;
    const commits = await gitService.getAheadCommits(branchName, remote);
    return { commits };
  });

  messageRouter.handle("executePush", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const branchName = params.branchName as string;
    const force = params.force as boolean | undefined;
    const remote = (params.remote as string) || "origin";
    const targetBranch = (params.targetBranch as string) || branchName;
    return withProgress(messageRouter, async () => {
      const output = await gitService.push(
        branchName,
        force ?? false,
        remote,
        targetBranch,
      );
      notifier.notify(GitDomain.Refs);
      // Return push output so webview can show result toast before closing
      const isUpToDate =
        output?.includes("Everything up-to-date") ||
        output?.includes("up to date");
      return { success: true, data: { output: output ?? "", isUpToDate } };
    });
  });

  messageRouter.handle("closePushPanel", async () => {
    pushPanel.close();
    return { success: true };
  });

  messageRouter.handle("openPushPanel", async () => {
    if (!gitService) return NOT_GIT_REPO;
    const branch = await gitService.getCurrentBranch();
    if (!branch) return { error: "No current branch" };
    const remote = await gitService.getDefaultRemote(branch);
    pushPanel.open(branch, remote);
    return { success: true };
  });

  // ─── Rollback Panel Handlers ───────────────────────────────────────

  messageRouter.handle("openRollbackPanel", async (params) => {
    const files = params.files as RollbackFileInfo[];
    rollbackPanel.open(files);
    return { success: true };
  });

  messageRouter.handle("executeRollback", async (params) => {
    if (!gitService || !workspaceRoot) return NOT_GIT_REPO;
    const filePaths = params.filePaths as string[];
    const deleteLocalCopies = params.deleteLocalCopies as boolean;

    try {
      // Get current working tree status to determine each file's state
      const workingTreeChanges = await gitService.getWorkingTreeChanges();
      const statusMap = new Map<string, string>();
      for (const file of workingTreeChanges) {
        statusMap.set(file.path, file.status);
      }

      for (const filePath of filePaths) {
        const status = statusMap.get(filePath) ?? "modified";
        if (status === "added" || status === "untracked") {
          if (deleteLocalCopies) {
            // Delete untracked/added file from filesystem
            const absPath = vscode.Uri.joinPath(
              vscode.Uri.file(workspaceRoot),
              filePath,
            );
            await vscode.workspace.fs.delete(absPath);
          }
          // If deleteLocalCopies is false, skip untracked/added files
        } else {
          // Revert tracked file changes via git checkout
          await gitService.rollbackFile(filePath);
        }
      }

      notifier.notify(GitDomain.Worktree);
      rollbackPanel.close();
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  messageRouter.handle("closeRollbackPanel", async () => {
    rollbackPanel.close();
    return { success: true };
  });

  messageRouter.handle("updateBranch", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    let branchName = params.branchName as string | undefined;
    const strategy = params.strategy as "merge" | "rebase" | undefined;
    return withProgress(messageRouter, async () => {
      if (!branchName) {
        branchName = (await gitService.getCurrentBranch()) ?? undefined;
        if (!branchName) {
          throw new Error("Not currently on a branch");
        }
      }
      try {
        await gitService.updateBranch(branchName, strategy);
      } catch (err: unknown) {
        if (err instanceof BranchDivergedError) {
          const choice = await vscode.window.showWarningMessage(
            `Branch "${err.branchName}" has diverged from ${err.remote}/${err.remoteBranch} and can't be fast-forwarded.`,
            { modal: true },
            "Merge",
            "Rebase",
          );
          if (choice !== "Merge" && choice !== "Rebase") {
            return { success: false, cancelled: true };
          }
          await gitService.updateBranch(
            err.branchName,
            choice === "Merge" ? "merge" : "rebase",
          );
        } else {
          throw err;
        }
      }
      notifier.notify(GitDomain.Refs, GitDomain.Worktree, GitDomain.Operation);
      return { success: true };
    });
  });

  messageRouter.handle("fetchBranch", async () => {
    if (!gitService) return NOT_GIT_REPO;
    return withProgress(messageRouter, async () => {
      await gitService.fetch();
      notifier.notify(GitDomain.Refs);
      return { success: true };
    });
  });

  messageRouter.handle("cherryPick", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const hash = params.hash as string;
    return withProgress(messageRouter, async () => {
      await gitService.cherryPick(hash);
      notifier.notify(GitDomain.Refs, GitDomain.Worktree, GitDomain.Operation);
      return { success: true };
    });
  });

  messageRouter.handle("checkoutCommit", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const hash = params.hash as string;
    await gitService.checkoutCommit(hash);
    notifier.notify(GitDomain.Refs, GitDomain.Worktree);
    return { success: true };
  });

  messageRouter.handle("revertFileChanges", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const hash = params.hash as string;
    const filePath = params.filePath as string;
    const status = params.status as string | undefined;
    await gitService.checkoutFileFromParent(hash, filePath, status);
    notifier.notify(GitDomain.Worktree);
    return { success: true };
  });

  messageRouter.handle("cherryPickFileChanges", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const hash = params.hash as string;
    const filePath = params.filePath as string;
    await gitService.checkoutFileFromCommit(hash, filePath);
    notifier.notify(GitDomain.Worktree);
    return { success: true };
  });

  messageRouter.handle("resetToCommit", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const hash = params.hash as string;
    const mode = params.mode as "soft" | "mixed" | "hard";
    return withProgress(messageRouter, async () => {
      await gitService.resetToCommit(hash, mode);
      notifier.notify(GitDomain.Refs, GitDomain.Worktree);
      return { success: true };
    });
  });

  messageRouter.handle("revertCommit", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const hash = params.hash as string;
    return withProgress(messageRouter, async () => {
      await gitService.revertCommit(hash);
      notifier.notify(GitDomain.Refs, GitDomain.Worktree, GitDomain.Operation);
      return { success: true };
    });
  });

  messageRouter.handle("dropCommit", async (params) => {
    if (!gitService) return NOT_GIT_REPO;

    const hash = params.hash as string;

    // 校验 hash 格式（40 位十六进制）
    if (!hash || !/^[0-9a-f]{40}$/i.test(hash)) {
      return {
        success: false,
        error: { message: "Invalid commit hash" },
      };
    }

    // 检查是否为 merge commit（在进入 withProgress 之前先拒绝）
    const parents = await gitService.getCommitParents(hash);
    if (parents.length > 1) {
      return {
        success: false,
        error: { message: "Merge commits cannot be dropped" },
      };
    }

    // Proceed with progress and 30-second timeout
    return withProgress(messageRouter, async () => {
      const timeoutMs = 30_000;
      const dropPromise = gitService.dropCommit(hash);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Operation timed out")), timeoutMs),
      );

      await Promise.race([dropPromise, timeoutPromise]);

      notifier.notify(GitDomain.Refs, GitDomain.Worktree, GitDomain.Operation);
      return { success: true };
    });
  });

  messageRouter.handle("createBranchFromCommit", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const branchName = params.branchName as string;
    const hash = params.hash as string;
    const checkout = params.checkout as boolean | undefined;
    const force = params.force as boolean | undefined;
    await gitService.createBranchFromCommit(branchName, hash, force ?? false);
    if (checkout) {
      await gitService.checkout(branchName);
    }
    notifier.notify(GitDomain.Refs);
    return { success: true };
  });

  messageRouter.handle("createTag", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const tagName = params.tagName as string;
    const hash = params.hash as string;
    const message = params.message as string | undefined;
    await gitService.createTag(tagName, hash, message);
    notifier.notify(GitDomain.Refs);
    return { success: true };
  });

  messageRouter.handle("copyToClipboard", async (params) => {
    const text = params.text as string;
    await vscode.env.clipboard.writeText(text);
    return { success: true };
  });

  messageRouter.handle("openFileAtRevision", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const filePath = params.filePath as string;
    const ref = params.ref as string;
    const uri = vscode.Uri.parse(
      `${GIT_BRAINS_SCHEME}:/${filePath}?ref=${ref}`,
    );
    await vscode.window.showTextDocument(uri, { preview: true });
    return { success: true };
  });

  // ─── Commit Panel Handlers ───────────────────────────────────────

  messageRouter.handle("getWorkingTreeChanges", async () => {
    if (allGitServices.length === 0) return NOT_GIT_REPO;
    return aggregateWorkingTreeChanges();
  });

  messageRouter.handle("commitChanges", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const message = params.message as string;
    const amend = params.amend as boolean | undefined;
    const filePaths = (params.filePaths as string[] | undefined) ?? [];

    await gitService.commitFiles(message, filePaths, amend ?? false);
    notifier.notify(GitDomain.Refs, GitDomain.Worktree);
    return { success: true };
  });

  messageRouter.handle("amendCommit", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const message = params.message as string;
    await gitService.commit(message, true);
    notifier.notify(GitDomain.Refs, GitDomain.Worktree);
    return { success: true };
  });

  messageRouter.handle("getAmendMessage", async () => {
    if (!gitService) return NOT_GIT_REPO;
    const message = await gitService.getLastCommitMessage();
    return { message };
  });

  messageRouter.handle("getRecentCommitMessages", async () => {
    if (!gitService) return NOT_GIT_REPO;
    return gitService.getRecentCommitMessages(20);
  });

  // ─── AI commit-message handlers ───────────────────────────────────────

  messageRouter.handle("aiGetConfig", async () => {
    return aiService.getConfig();
  });

  messageRouter.handle("aiSetConfig", async (params) => {
    return aiService.setConfig({
      provider:
        (params.provider as "vscode" | "anthropic" | "openai") ?? "vscode",
      baseUrl: (params.baseUrl as string) ?? "",
      model: (params.model as string) ?? "",
      apiKey: params.apiKey as string | undefined,
      clearApiKey: params.clearApiKey as boolean | undefined,
      maxLength: (params.maxLength as number | undefined) ?? 200,
      language: (params.language as "en" | "zh" | undefined) ?? "en",
    });
  });

  messageRouter.handle("aiGenerateCommitMessage", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const req = params as {
      files?: string[];
      prefix?: string;
    };
    const files = (req.files ?? []).filter(
      (f): f is string => typeof f === "string" && f.length > 0,
    );
    const diff = await gitService.getWorkingTreeDiff(
      files.length > 0 ? files : undefined,
    );
    if (!diff.trim() && !(req.prefix ?? "").trim()) {
      throw new Error(
        "No working-tree changes to summarize. Stage or modify some files first.",
      );
    }
    const cfg = await aiService.getConfig();
    if (cfg.provider !== "vscode" && !cfg.hasApiKey) {
      throw new Error(
        `No API key configured for ${cfg.provider}. Open the AI settings to add one.`,
      );
    }
    return aiService.generate(cfg, diff, {
      files,
      prefix: req.prefix ?? "",
    });
  });

  messageRouter.handle("rollbackFile", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const filePath = params.filePath as string;
    const choice = await vscode.window.showWarningMessage(
      `Rollback changes to "${filePath}"? This cannot be undone.`,
      { modal: true },
      "Rollback",
    );
    if (choice !== "Rollback") return { success: false };
    await gitService.rollbackFile(filePath);
    notifier.notify(GitDomain.Worktree);
    return { success: true };
  });

  messageRouter.handle("rollbackFiles", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const filePaths = params.filePaths as string[];
    if (!filePaths || filePaths.length === 0) return { success: false };
    const choice = await vscode.window.showWarningMessage(
      `Rollback changes to ${filePaths.length} file(s)? This cannot be undone.`,
      { modal: true },
      "Rollback",
    );
    if (choice !== "Rollback") return { success: false };
    for (const filePath of filePaths) {
      await gitService.rollbackFile(filePath);
    }
    notifier.notify(GitDomain.Worktree);
    return { success: true };
  });

  messageRouter.handle("revealInSystemExplorer", async (params) => {
    const filePath = params.filePath as string;
    if (!filePath || !workspaceRoot) return { success: false };
    const absPath = vscode.Uri.joinPath(
      vscode.Uri.file(workspaceRoot),
      filePath,
    );
    await vscode.commands.executeCommand("revealFileInOS", absPath);
    return { success: true };
  });

  messageRouter.handle("deleteFiles", async (params) => {
    if (!workspaceRoot) return NOT_GIT_REPO;
    const filePaths = params.filePaths as string[];
    if (!filePaths || filePaths.length === 0) return { success: false };

    const fileCount = filePaths.length;
    const message =
      fileCount === 1
        ? `Delete "${filePaths[0]}"? This cannot be undone.`
        : `Delete ${fileCount} files? This cannot be undone.`;

    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      "Delete",
    );
    if (choice !== "Delete") return { success: false };

    for (const filePath of filePaths) {
      const fullPath = vscode.Uri.joinPath(
        vscode.Uri.file(workspaceRoot),
        filePath,
      );
      try {
        await vscode.workspace.fs.delete(fullPath, { recursive: true });
      } catch {
        // File may already be deleted, ignore
      }
    }
    notifier.notify(GitDomain.Worktree);
    return { success: true };
  });

  messageRouter.handle("showDiffForWorkingFile", async (params) => {
    if (!gitService || !workspaceRoot) return NOT_GIT_REPO;
    const filePath = params.filePath as string;

    const rightUri = vscode.Uri.joinPath(
      vscode.Uri.file(workspaceRoot),
      filePath,
    );
    const leftUri = vscode.Uri.parse(
      `${GIT_BRAINS_SCHEME}:/${filePath}?ref=HEAD`,
    );
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${filePath} (HEAD ↔ Working Tree)`,
    );
    return { success: true };
  });

  // ─── Shelf Handlers ───────────────────────────────────────────────

  messageRouter.handle("getShelves", async () => {
    if (!gitService) return NOT_GIT_REPO;
    return gitService.getShelves();
  });

  messageRouter.handle("shelveChanges", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const message = params.message as string | undefined;
    const filePaths = params.filePaths as string[] | undefined;
    await gitService.shelveChanges(message ?? "", filePaths);
    notifier.notify(GitDomain.Stash, GitDomain.Worktree);
    return { success: true };
  });

  messageRouter.handle("unshelveChanges", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const stashId = params.stashId as string;
    const drop = (params.drop as boolean) ?? true;
    await gitService.unshelveChanges(stashId, drop);
    notifier.notify(GitDomain.Stash, GitDomain.Worktree);
    return { success: true };
  });

  messageRouter.handle("deleteShelve", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const stashId = params.stashId as string;
    const choice = await vscode.window.showWarningMessage(
      `Delete shelved changes "${stashId}"? This cannot be undone.`,
      { modal: true },
      "Delete",
    );
    if (choice !== "Delete") return { success: false };
    await gitService.deleteShelve(stashId);
    notifier.notify(GitDomain.Stash);
    return { success: true };
  });

  messageRouter.handle("showShelfFileDiff", async (params) => {
    if (!gitService || !workspaceRoot) return NOT_GIT_REPO;
    const stashId = params.stashId as string;
    const filePath = params.filePath as string;

    // Show diff between the stash version and the parent (before stash)
    const stashUri = vscode.Uri.parse(
      `${GIT_BRAINS_SCHEME}:/${filePath}?ref=${stashId}`,
    );
    const parentUri = vscode.Uri.parse(
      `${GIT_BRAINS_SCHEME}:/${filePath}?ref=${stashId}^`,
    );
    await vscode.commands.executeCommand(
      "vscode.diff",
      parentUri,
      stashUri,
      `${filePath} (Shelved: ${stashId})`,
    );
    return { success: true };
  });

  messageRouter.handle("unshelveFile", async (params) => {
    if (!gitService || !workspaceRoot) return NOT_GIT_REPO;
    const stashId = params.stashId as string;
    const filePath = params.filePath as string;

    // Checkout the single file from the stash into the working tree
    try {
      await gitService.checkoutFileFromCommit(stashId, filePath);
      notifier.notify(GitDomain.Stash, GitDomain.Worktree);
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(
        `Failed to unshelve file: ${message}`,
      );
      return { success: false };
    }
  });

  // ─── IDEA Shelf Handlers ────────────────────────────────────────────

  messageRouter.handle("getIdeaShelves", async () => {
    if (!gitService) return NOT_GIT_REPO;
    return gitService.getIdeaShelves();
  });

  messageRouter.handle("ideaShelveChanges", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const message = params.message as string | undefined;
    const filePaths = params.filePaths as string[] | undefined;
    await gitService.ideaShelveChanges(message ?? "", filePaths);
    notifier.notify(GitDomain.Stash, GitDomain.Worktree);
    return { success: true };
  });

  messageRouter.handle("ideaUnshelveChanges", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const shelfName = params.shelfName as string;
    const drop = (params.drop as boolean) ?? true;
    await gitService.ideaUnshelveChanges(shelfName, drop);
    notifier.notify(GitDomain.Stash, GitDomain.Worktree);
    return { success: true };
  });

  messageRouter.handle("deleteIdeaShelf", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const shelfName = params.shelfName as string;
    const choice = await vscode.window.showWarningMessage(
      `Delete shelf "${shelfName}"? This cannot be undone.`,
      { modal: true },
      "Delete",
    );
    if (choice !== "Delete") return { success: false };
    await gitService.deleteIdeaShelf(shelfName);
    notifier.notify(GitDomain.Stash);
    return { success: true };
  });

  messageRouter.handle("showIdeaShelfFileDiff", async (params) => {
    if (!gitService || !workspaceRoot) return NOT_GIT_REPO;
    const shelfName = params.shelfName as string;
    const filePath = params.filePath as string;

    const patchFile = `${workspaceRoot}/.idea/shelf/${shelfName}/shelved.patch`;
    try {
      const patchContent = await nodefs.readFile(patchFile, "utf-8");

      // Parse IDEA patch format to extract base content and modified content
      const { baseContent, modifiedContent } = parseIdeaPatchForFile(
        patchContent,
        filePath,
      );

      // Create virtual documents for both sides and show diff
      const baseUri = vscode.Uri.parse(
        `${GIT_BRAINS_SCHEME}:/shelved/${shelfName}/${filePath}?ref=base`,
      );
      const modifiedUri = vscode.Uri.parse(
        `${GIT_BRAINS_SCHEME}:/shelved/${shelfName}/${filePath}?ref=modified`,
      );

      // Register temporary content for these URIs
      shelfDiffContent.set(baseUri.toString(), baseContent);
      shelfDiffContent.set(modifiedUri.toString(), modifiedContent);

      await vscode.commands.executeCommand(
        "vscode.diff",
        baseUri,
        modifiedUri,
        `${filePath.split("/").pop()} (Shelved in ${shelfName})`,
      );
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(
        `Could not show diff for "${filePath}": ${msg}`,
      );
      return { success: false };
    }
  });

  messageRouter.handle("createPatchFromShelf", async (params) => {
    if (!gitService || !workspaceRoot) return NOT_GIT_REPO;
    const shelfName = params.shelfName as string;
    const patchFile = `${workspaceRoot}/.idea/shelf/${shelfName}/shelved.patch`;

    // Ask user where to save the patch
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${workspaceRoot}/${shelfName}.patch`),
      filters: { "Patch files": ["patch", "diff"], "All files": ["*"] },
      title: "Save Patch File",
    });

    if (!saveUri) return { success: false };

    try {
      const patchContent = await nodefs.readFile(patchFile, "utf-8");
      await nodefs.writeFile(saveUri.fsPath, patchContent, "utf-8");
      void vscode.window.showInformationMessage(
        `Patch saved to ${saveUri.fsPath}`,
      );
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to create patch: ${msg}`);
      return { success: false };
    }
  });

  messageRouter.handle("importPatches", async () => {
    if (!gitService || !workspaceRoot) return NOT_GIT_REPO;

    // Ask user to select patch files
    const fileUris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { "Patch files": ["patch", "diff"], "All files": ["*"] },
      title: "Import Patch Files",
    });

    if (!fileUris || fileUris.length === 0) return { success: false };

    try {
      for (const uri of fileUris) {
        const patchContent = await nodefs.readFile(uri.fsPath, "utf-8");

        // Create a shelf entry from the imported patch
        const fileName = uri.fsPath.split("/").pop() ?? "Imported";
        const shelfName = fileName.replace(/\.(patch|diff)$/, "");
        await gitService.importPatchAsShelf(shelfName, patchContent);
      }

      notifier.notify(GitDomain.Stash);
      void vscode.window.showInformationMessage(
        `Imported ${fileUris.length} patch${fileUris.length > 1 ? "es" : ""}`,
      );
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to import patches: ${msg}`);
      return { success: false };
    }
  });

  // ─── Branch Sidebar Actions ─────────────────────────────────────────

  messageRouter.handle("createBranchPrompt", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const name = params.branchName as string | undefined;
    const checkout = params.checkout as boolean | undefined;
    const force = params.force as boolean | undefined;
    if (!name) return { success: false };
    return withProgress(messageRouter, async () => {
      await gitService.createBranch(name, "HEAD", force ?? false);
      if (checkout) {
        await gitService.checkout(name);
      }
      notifier.notify(GitDomain.Refs);
      return { success: true };
    });
  });

  messageRouter.handle("compareWithCurrent", async (params) => {
    if (!gitService) return NOT_GIT_REPO;
    const branchName = params.branchName as string;
    if (!branchName) return { success: false };
    // Use VS Code's built-in git diff between current branch and selected
    const currentBranch = await gitService.getCurrentBranch();
    void vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.parse(`${GIT_BRAINS_SCHEME}:/${currentBranch}`),
      vscode.Uri.parse(`${GIT_BRAINS_SCHEME}:/${branchName}`),
      `${currentBranch} ↔ ${branchName}`,
    );
    return { success: true };
  });

  messageRouter.handle("showMyBranches", async () => {
    // Filter branches by current git user
    if (!gitService) return NOT_GIT_REPO;
    void vscode.window.showInformationMessage(
      "Show My Branches: filter applied in branch tree",
    );
    return { success: true };
  });

  messageRouter.handle("fetchAll", async () => {
    if (!gitService) return NOT_GIT_REPO;
    return withProgress(messageRouter, async () => {
      await gitService.fetch();
      gitService.invalidateCache();
      notifier.notify(GitDomain.Refs);
      return { success: true };
    });
  });

  messageRouter.handle("navigateToHead", async (params) => {
    const branchName = params.branchName as string;
    if (!branchName) return { success: false };
    return { success: true };
  });

  // 7. GitWatcher：覆盖所有 workspace folder 里的 git 仓库
  //
  // 要先问 git 每个仓库真正的 .git 目录在哪（worktree / submodule 下它是个
  // 文件、指向别处），所以这里是异步起的；解析不出来的目录当作不是仓库跳过。
  if (allGitServices.length > 0) {
    void (async () => {
      const gitDirs: string[] = [];
      for (const svc of allGitServices) {
        const gitDir = await svc.getGitDir();
        if (gitDir) {
          gitDirs.push(gitDir);
        }
      }
      if (gitDirs.length === 0) {
        return;
      }
      context.subscriptions.push(new GitWatcher(gitDirs, notifier));
    })();
  }

  // 8. Status bar item to quickly open the panel
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.text = "$(git-branch) IDEA Git";
  statusBarItem.tooltip = "Open IDEA Git Graph Panel";
  statusBarItem.command = "git-brains.gitLog.focus";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}

function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescriptreact",
    js: "javascript",
    jsx: "javascriptreact",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    xml: "xml",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    sql: "sql",
    sh: "shellscript",
    bash: "shellscript",
    toml: "toml",
    ini: "ini",
    vue: "vue",
    svelte: "svelte",
  };
  return map[ext.toLowerCase()] ?? "plaintext";
}

export function deactivate() {}

/**
 * Extract the patch section for a specific file from a combined patch.
 * Handles IDEA format (Index: path) and standard git format (diff --git).
 */
function _extractFilePatch(
  patchContent: string,
  filePath: string,
): string | null {
  const lines = patchContent.split("\n");
  let collecting = false;
  const result: string[] = [];

  for (const line of lines) {
    // IDEA format: "Index: <path>"
    if (line.startsWith("Index: ")) {
      if (collecting) break;
      const indexPath = line.substring(7).trim();
      if (indexPath === filePath) {
        collecting = true;
        result.push(line);
      }
      continue;
    }

    // Standard git format: "diff --git a/<path> b/<path>"
    if (line.startsWith("diff --git ")) {
      if (collecting && result.length > 1) {
        // Already collecting from Index: line, this is part of same section
        result.push(line);
        continue;
      }
      if (collecting) break;
      if (line.includes(`a/${filePath}`) || line.includes(`b/${filePath}`)) {
        collecting = true;
        result.push(line);
      }
      continue;
    }

    if (collecting) {
      result.push(line);
    }
  }

  return result.length > 0 ? result.join("\n") : null;
}

/**
 * Parse IDEA patch format to extract base and modified content for a specific file.
 * IDEA patches have:
 * - BaseRevisionTextPatchEP section with <+> containing the original file (escaped)
 * - Standard unified diff section
 */
function parseIdeaPatchForFile(
  patchContent: string,
  filePath: string,
): { baseContent: string; modifiedContent: string } {
  const lines = patchContent.split("\n");
  let inTargetFile = false;
  let inBaseRevision = false;
  let baseContentEscaped = "";
  const diffLines: string[] = [];
  let inDiff = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect file section start
    if (line.startsWith("Index: ")) {
      if (inTargetFile) break; // hit next file
      const indexPath = line.substring(7).trim();
      if (indexPath === filePath) {
        inTargetFile = true;
      }
      continue;
    }

    if (!inTargetFile) continue;

    // Detect BaseRevisionTextPatchEP section
    if (
      line.includes(
        "com.intellij.openapi.diff.impl.patch.BaseRevisionTextPatchEP",
      )
    ) {
      inBaseRevision = true;
      continue;
    }

    // Collect base content (starts with <+>)
    if (inBaseRevision && line.startsWith("<+>")) {
      baseContentEscaped = line.substring(3);
      inBaseRevision = false;
      continue;
    }

    // Skip charset info
    if (line.includes("CharsetEP")) {
      // Next line will be <+>UTF-8 or similar, skip it
      if (i + 1 < lines.length && lines[i + 1].startsWith("<+>")) {
        i++;
      }
      continue;
    }

    // Detect diff start
    if (line.startsWith("--- ") && !inDiff) {
      inDiff = true;
      diffLines.push(line);
      continue;
    }

    if (inDiff) {
      diffLines.push(line);
    }
  }

  // Unescape base content (IDEA uses \n for newlines, \t for tabs in the <+> section)
  const baseContent = baseContentEscaped
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");

  // Apply unified diff to base content to get modified content
  const modifiedContent = applyUnifiedDiff(baseContent, diffLines);

  return { baseContent, modifiedContent };
}

/**
 * Apply a unified diff to base content to produce modified content.
 */
function applyUnifiedDiff(baseContent: string, diffLines: string[]): string {
  if (diffLines.length === 0) return baseContent;

  const baseLines = baseContent.split("\n");
  const result: string[] = [];
  let baseIdx = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];

    // Parse hunk header: @@ -start,count +start,count @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      const oldStart = Number.parseInt(hunkMatch[1], 10) - 1; // 0-indexed

      // Copy lines before this hunk
      while (baseIdx < oldStart) {
        result.push(baseLines[baseIdx]);
        baseIdx++;
      }

      // Process hunk lines
      for (let j = i + 1; j < diffLines.length; j++) {
        const hunkLine = diffLines[j];
        if (
          hunkLine.startsWith("@@") ||
          hunkLine.startsWith("diff ") ||
          hunkLine.startsWith("Index: ")
        ) {
          i = j - 1;
          break;
        }
        if (hunkLine.startsWith("-")) {
          // Removed line — skip in base
          baseIdx++;
        } else if (hunkLine.startsWith("+")) {
          // Added line
          result.push(hunkLine.substring(1));
        } else if (hunkLine.startsWith(" ")) {
          // Context line
          result.push(hunkLine.substring(1));
          baseIdx++;
        } else {
          // End of diff or no-newline marker
          if (hunkLine.startsWith("\\ No newline")) continue;
          i = j - 1;
          break;
        }
        if (j === diffLines.length - 1) {
          i = j;
        }
      }
      continue;
    }

    // Skip --- and +++ lines
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
  }

  // Copy remaining base lines
  while (baseIdx < baseLines.length) {
    result.push(baseLines[baseIdx]);
    baseIdx++;
  }

  return result.join("\n");
}

function getScmResourcePath(arg?: unknown): string | undefined {
  const value = arg as unknown;
  let uri: vscode.Uri | undefined;
  if (value instanceof vscode.Uri) {
    uri = value;
  } else if (value && typeof value === "object") {
    if ("resourceUri" in value) {
      uri = (value as { resourceUri?: vscode.Uri }).resourceUri;
    } else if ("sourceUri" in value) {
      uri = (value as { sourceUri?: vscode.Uri }).sourceUri;
    }
  }
  if (!uri) return undefined;

  return vscode.workspace.asRelativePath(uri, false);
}
