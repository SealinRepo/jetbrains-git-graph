# Claude Code 项目指南

## 项目结构

```
shared/                 主机与 Webview 共用的通信协议 (protocol.ts)
src/                    扩展主机 (TypeScript + Node.js)
  ├── extension.ts        入口文件，命令注册 & MessageRouter 处理器
  ├── git/                Git CLI 封装 (gitService 门面 + gitService/ 子模块, graphLayout, types)
  ├── messages/           MessageRouter
  ├── state/              git 状态分域 (domains) + 唯一广播出口 (gitStateNotifier)
  ├── watchers/           GitWatcher (监听 .git 与工作区) + classify (路径→域的纯函数)
  ├── utils/              DebouncedSet (防抖聚合)
  └── views/              Webview 管理器 (mergeEditorManager, conflictsManager, diffEditorManager, pushPanel, rollbackPanel, html)
webview/                Webview 前端 (React 19 + Vite)
  └── src/
      ├── panel/          Git Log 面板 (Graph, CommitList, BranchTree, DetailPanel)
      ├── commit/         Commit 面板 (含 Shelf/IDEA Shelf)
      ├── conflicts/      冲突列表页 + 三方合并编辑器
      ├── push/           Push 对话框
      ├── rollback/       Rollback 面板
      ├── shared/         共享模块 (bridge, store, hooks, components, theme)
      └── main.tsx        路由入口 (模式: panel | merge | conflicts | commit | push | rollback)
```

## 代码规范

### 格式化与 Lint

- 格式化/Lint 工具：`biome check`（配置见 biome.json）
- 发布前必须通过 `pnpm run compile`（check-types + lint + esbuild）

### 技术栈

- **扩展主机**：TypeScript, Node.js, child_process (execFile), esbuild
- **Webview**：React 19, Zustand, allotment, @tanstack/react-virtual, shiki, diff, node-diff3
- **通信方式**：postMessage 请求-响应 + 事件广播 (MessageRouter)
- **图形渲染**：SVG + DOM（非 Canvas）
- **包管理器**：pnpm（monorepo，pnpm-workspace.yaml）

### 关键设计决策

- 直接调用 Git CLI（不使用 simple-git），自定义 `\x00` 分隔符解析
- 自研图形布局算法（贪心车道分配 + LaneSnapshot）
- 三方合并使用 node-diff3，二方 diff 使用 diff 库
- 所有 Webview 共用单一 MessageRouter 架构，消息类型定义唯一来源是 `shared/protocol.ts`
- GUI 不持有持久状态：靠 GitWatcher 监听 `.git` 与工作区文件变化 → 归类为域 → 缓存失效 → 域内整体重拉，没有乐观更新
- git 状态变更按 `refs` / `worktree` / `stash` / `operation` 四个域广播，各面板只重拉自己关心的部分；域的划分与挑选原则见 `src/state/domains.ts`，所有失效+广播统一走 `GitStateNotifier`

详细设计动机见 [ARCHITECTURE.md](ARCHITECTURE.md)（含通信/数据流拓扑图）。

### 版本锁定

- 不要主动升级 React 或 Vite 版本

## 构建命令

```bash
pnpm run compile          # 扩展：check-types + lint + esbuild
pnpm run build:web        # Webview：tsc + vite build
pnpm run build            # 以上两者
pnpm run watch            # 开发模式（esbuild + tsc + vite 并行 watch）
pnpm run package          # 生产构建（用于 vsce publish）
```
