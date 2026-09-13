import * as vscode from "vscode";
import {
  GitDomain as D,
  type GitDomain,
  type GitStateSink,
} from "../state/domains";
import { DebouncedSet } from "../utils/debouncedSet";
import { classifyGitPath, isInsideGitDir } from "./classify";

/** 事件停下来多久之后刷新 */
const DEBOUNCE_MS = 300;
/** 事件持续不断时，最多憋多久必须刷一次，避免被饿死 */
const MAX_WAIT_MS = 2000;

const WORKTREE_ONLY: readonly GitDomain[] = [D.Worktree];

/**
 * 监听 git 状态变化，按域通知出去。
 *
 * 只用两个 FileSystemWatcher，因为需要拆开的理由只有一个——两者对
 * `files.watcherExclude` 的要求正好相反（见下面两个方法的注释）。除此之外
 * 一律靠 classify.ts 里的纯函数区分，不靠加 watcher。
 */
export class GitWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private readonly pending: DebouncedSet<GitDomain>;

  /**
   * @param gitDirs 每个仓库真正的 .git 目录绝对路径（由 GitService.getGitDir
   *                解析，worktree / submodule 下它不等于 <root>/.git）
   */
  constructor(gitDirs: readonly string[], sink: GitStateSink) {
    this.pending = new DebouncedSet<GitDomain>(
      (domains) => sink.notify(...domains),
      DEBOUNCE_MS,
      MAX_WAIT_MS,
    );

    for (const gitDir of gitDirs) {
      this.watchGitDir(gitDir);
    }
    this.watchWorkspaceFiles();
    this.watchEditorSaves();
  }

  /**
   * 源 A：.git 内部的元数据。
   *
   * 必须用 Uri 作为 base——这样建出来的是独立 watcher，不受
   * `files.watcherExclude` 影响。用户很可能配了 `**\/.git/**` 把整个 .git
   * 排掉（常见的性能优化），那样字符串 pattern 会一个事件都收不到。
   * 代价是默认的 `**\/.git/objects/**` 排除也保护不到，噪声要自己在
   * classifyGitPath 里挡。
   */
  private watchGitDir(gitDir: string): void {
    const base = vscode.Uri.file(gitDir);
    const prefix = `${base.path}/`;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(base, "**"),
    );

    const onEvent = (uri: vscode.Uri) => {
      // uri.path 始终是 / 分隔的，Windows 上也是；fsPath 不是，别用
      if (!uri.path.startsWith(prefix)) {
        return;
      }
      this.pending.add(classifyGitPath(uri.path.slice(prefix.length)));
    };

    watcher.onDidCreate(onEvent);
    watcher.onDidChange(onEvent);
    watcher.onDidDelete(onEvent);
    this.disposables.push(watcher);
  }

  /**
   * 源 B：工作区文件本身。改一个文件不会碰 .git 里的任何东西，所以这条路
   * 是工作区改动唯一的信号来源。
   *
   * 必须用字符串 pattern——这样 VSCode 会复用已有的 workspace watcher 并
   * 尊重 `files.watcherExclude`（默认已排除 node_modules），增量开销只是
   * 事件分发。换成 RelativePattern 就会新建一个不受排除约束的 watcher，
   * 大仓库下会被构建产物淹掉。和源 A 的要求正好相反，这里最容易写错。
   *
   * 字符串 pattern 覆盖所有 workspace folder，所以一个就够，不用按仓库建。
   */
  private watchWorkspaceFiles(): void {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");

    const onEvent = (uri: vscode.Uri) => {
      // .git 内的变化交给源 A，免得同一次变化被记两次
      if (isInsideGitDir(uri.path)) {
        return;
      }
      this.pending.add(WORKTREE_ONLY);
    };

    watcher.onDidCreate(onEvent);
    watcher.onDidChange(onEvent);
    watcher.onDidDelete(onEvent);
    this.disposables.push(watcher);
  }

  /**
   * 源 C：编辑器内保存。源 B 已经覆盖了这种情况，留着是因为文件系统事件有
   * 几十到几百毫秒延迟，这条路更跟手，成本几乎为零。
   */
  private watchEditorSaves(): void {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(() =>
        this.pending.add(WORKTREE_ONLY),
      ),
    );
  }

  dispose(): void {
    this.pending.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
