import * as vscode from "vscode";
import type { ChangelistService } from "./changelistService";

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return !(a[1] < b[0] || b[1] < a[0]);
}

function computeChangedRange(
  event: vscode.TextDocumentChangeEvent,
): [number, number] | null {
  if (event.contentChanges.length === 0) return null;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const c of event.contentChanges) {
    const lineStart = c.range.start.line;
    const lineEnd = c.range.end.line;
    if (lineStart < start) start = lineStart;
    if (lineEnd > end) end = lineEnd;
  }
  // 转为 1-indexed
  return [start + 1, end + 1];
}

export function registerConflictListener(
  cs: ChangelistService,
): vscode.Disposable {
  return vscode.workspace.onDidChangeTextDocument(async (event) => {
    if (!event.document.uri.scheme.startsWith("file")) return;
    const filePath = vscode.workspace.asRelativePath(event.document.uri, false);
    if (!filePath || filePath.startsWith("..")) return;

    const assignment = cs.getAssignment(filePath);
    if (!assignment) return;
    const activeId = cs.getState().activeChangelistId;

    // 整文件分配 + 非活动
    if (!assignment.hunks?.length && assignment.changelistId !== activeId) {
      await handleInactiveFileEdit(cs, filePath);
      return;
    }

    // hunk 分配 + 改动落在非活动 hunk 内
    if (assignment.hunks?.length) {
      const changed = computeChangedRange(event);
      if (!changed) return;
      const offending = assignment.hunks.filter(
        (h) =>
          h.changelistId !== activeId &&
          rangesOverlap(changed, [h.startLine, h.endLine]),
      );
      if (offending.length) {
        await handleInactiveHunkEdit(cs, filePath, offending);
      }
    }
  });
}

async function handleInactiveFileEdit(
  cs: ChangelistService,
  filePath: string,
): Promise<void> {
  const settings = cs.getSettings();
  switch (settings.conflictBehavior) {
    case "ignore":
      return;
    case "move": {
      await cs.moveFileToChangelist(filePath, cs.getState().activeChangelistId);
      void vscode.window.showInformationMessage(
        `已将 "${filePath}" 移入活动变更列表`,
      );
      return;
    }
    case "switch": {
      const a = cs.getAssignment(filePath);
      if (a) {
        await cs.setActiveChangelist(a.changelistId);
        void vscode.window.showInformationMessage(
          `已切换活动变更列表到文件所属列表`,
        );
      }
      return;
    }
    case "prompt": {
      const a = cs.getAssignment(filePath);
      const choice = await vscode.window.showWarningMessage(
        `"${filePath}" 属于非活动变更列表。处理方式？`,
        { modal: true },
        "移入活动列表",
        "切换活动列表",
        "忽略",
      );
      if (choice === "移入活动列表") {
        await cs.moveFileToChangelist(
          filePath,
          cs.getState().activeChangelistId,
        );
      } else if (choice === "切换活动列表" && a) {
        await cs.setActiveChangelist(a.changelistId);
      }
      return;
    }
  }
}

async function handleInactiveHunkEdit(
  cs: ChangelistService,
  filePath: string,
  offending: Array<{ startLine: number; endLine: number; changelistId: string }>,
): Promise<void> {
  const settings = cs.getSettings();
  const activeId = cs.getState().activeChangelistId;
  const existing = cs.getState().assignments[filePath];
  if (!existing) return;
  const hunks = existing.hunks ?? [];

  if (settings.conflictBehavior === "ignore") return;

  if (
    settings.conflictBehavior === "move" ||
    settings.conflictBehavior === "switch"
  ) {
    const updated = hunks.map((h) =>
      offending.some(
        (o) => o.startLine === h.startLine && o.endLine === h.endLine,
      )
        ? { ...h, changelistId: activeId }
        : h,
    );
    await cs.assignHunks(filePath, updated);
    return;
  }

  // prompt 模式
  const choice = await vscode.window.showWarningMessage(
    `"${filePath}" 中有 ${offending.length} 个非活动 hunk 被修改。处理方式？`,
    { modal: true },
    "把 hunk 移入活动列表",
    "忽略",
  );
  if (choice === "把 hunk 移入活动列表") {
    const updated = hunks.map((h) =>
      offending.some(
        (o) => o.startLine === h.startLine && o.endLine === h.endLine,
      )
        ? { ...h, changelistId: activeId }
        : h,
    );
    await cs.assignHunks(filePath, updated);
  }
}
