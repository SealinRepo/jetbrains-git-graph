import { type RefObject, useCallback, useRef, useState } from "react";
import { bridge, bridgeWithProgress } from "../../shared/bridge";
import {
  AddIcon,
  ChevronLeftIcon,
  CollapseAllIcon,
  DeleteIcon,
  DiffIcon,
  ExpandAllIcon,
  FetchIcon,
  LocateIcon,
  SearchIcon,
  SettingsIcon,
  StarIcon,
  UpdateIcon,
} from "../../shared/components/Icons";
import { Tooltip } from "../../shared/components/Tooltip";
import "../../shared/components/Tooltip.css";
import { usePanelStore } from "../../shared/store/panel-store";

export function BranchSidebar({
  onTogglePanel,
  onNewBranch,
}: {
  onTogglePanel?: () => void;
  onNewBranch?: (branchName: string) => void;
} = {}) {
  const selectedBranches = usePanelStore((s) => s.selectedBranches);
  const selectedBranch =
    selectedBranches.length === 1 ? selectedBranches[0] : null;
  const branches = usePanelStore((s) => s.branches);
  const isSelectedBranchRemote =
    branches.find((b) => b.name === selectedBranch)?.isRemote ?? false;

  const handleNewBranch = useCallback(() => {
    if (!selectedBranch) return;
    onNewBranch?.(selectedBranch);
  }, [onNewBranch, selectedBranch]);

  const handleUpdateSelected = useCallback(async () => {
    if (!selectedBranch) return;
    try {
      await bridgeWithProgress("updateBranch", { branchName: selectedBranch });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bridge.request("showErrorNotification", { message: msg }).catch(() => {});
    }
  }, [selectedBranch]);

  const handleDeleteBranch = useCallback(async () => {
    if (!selectedBranch) return;
    const result = (await bridge.request("showConfirmMessage", {
      message: `Delete branch '${selectedBranch}'?`,
      confirmLabel: "Delete",
    })) as { confirmed: boolean };
    if (!result.confirmed) return;
    try {
      await bridgeWithProgress("deleteBranch", {
        branchName: selectedBranch,
        isRemote: isSelectedBranchRemote,
        force: false,
      });
    } catch (_err) {
      // 未完全合并时，git branch -d 会失败，这里改用 -D 强制删除前再确认一次
      const forceResult = (await bridge.request("showConfirmMessage", {
        message: `Branch '${selectedBranch}' is not fully merged. Force delete?`,
        confirmLabel: "Force Delete",
      })) as { confirmed: boolean };
      if (forceResult.confirmed) {
        try {
          await bridgeWithProgress("deleteBranch", {
            branchName: selectedBranch,
            isRemote: isSelectedBranchRemote,
            force: true,
          });
        } catch (err2) {
          const msg = err2 instanceof Error ? err2.message : String(err2);
          bridge
            .request("showErrorNotification", { message: msg })
            .catch(() => {});
        }
      }
    }
  }, [selectedBranch, isSelectedBranchRemote]);

  const handleCompareWithCurrent = useCallback(() => {
    if (selectedBranch) {
      bridge.request("compareWithCurrent", { branchName: selectedBranch });
    }
  }, [selectedBranch]);

  const handleShowMyBranches = useCallback(() => {
    bridge.request("showMyBranches");
  }, []);

  const handleFetch = useCallback(() => {
    bridge.request("fetchAll");
  }, []);

  const handleNavigateToHead = useCallback(() => {
    if (selectedBranch) {
      bridge.request("navigateToHead", { branchName: selectedBranch });
    }
  }, [selectedBranch]);

  const handleExpandAll = useCallback(() => {
    window.dispatchEvent(new CustomEvent("branch-tree-expand-all"));
  }, []);

  const handleCollapseAll = useCallback(() => {
    window.dispatchEvent(new CustomEvent("branch-tree-collapse-all"));
  }, []);

  return (
    <div className="branch-sidebar">
      {onTogglePanel && (
        <Tooltip text="Hide Branches">
          <button
            type="button"
            className="branch-sidebar-btn"
            onClick={onTogglePanel}
          >
            <ChevronLeftIcon />
          </button>
        </Tooltip>
      )}
      <Tooltip text="New Branch">
        <button
          type="button"
          className="branch-sidebar-btn"
          onClick={handleNewBranch}
          disabled={!selectedBranch}
        >
          <AddIcon />
        </button>
      </Tooltip>
      <Tooltip text="Update Selected">
        <button
          type="button"
          className="branch-sidebar-btn"
          onClick={handleUpdateSelected}
          disabled={!selectedBranch}
        >
          <UpdateIcon />
        </button>
      </Tooltip>
      <Tooltip text="Delete Branch">
        <button
          type="button"
          className="branch-sidebar-btn"
          onClick={handleDeleteBranch}
          disabled={!selectedBranch}
        >
          <DeleteIcon />
        </button>
      </Tooltip>
      <Tooltip text="Compare with Current">
        <button
          type="button"
          className="branch-sidebar-btn"
          onClick={handleCompareWithCurrent}
          disabled={!selectedBranch}
        >
          <DiffIcon />
        </button>
      </Tooltip>
      <Tooltip text="Show My Branches">
        <button
          type="button"
          className="branch-sidebar-btn"
          onClick={handleShowMyBranches}
        >
          <SearchIcon />
        </button>
      </Tooltip>
      <Tooltip text="Fetch">
        <button
          type="button"
          className="branch-sidebar-btn"
          onClick={handleFetch}
        >
          <FetchIcon />
        </button>
      </Tooltip>
      {/* StarIcon：favorite 图标，收藏分支功能未实现，先保留图标占位，按钮暂时禁用 */}
      <Tooltip text="Mark/Unmark As Favorite">
        <button type="button" className="branch-sidebar-btn" disabled>
          <StarIcon />
        </button>
      </Tooltip>
      <Tooltip text="Navigate Log to Selected Branch Head">
        <button
          type="button"
          className="branch-sidebar-btn"
          onClick={handleNavigateToHead}
          disabled={!selectedBranch}
        >
          <LocateIcon />
        </button>
      </Tooltip>
      <SettingsButton />

      <div className="branch-sidebar-spacer" />

      <Tooltip text="Expand All">
        <button
          type="button"
          className="branch-sidebar-btn"
          onClick={handleExpandAll}
        >
          <ExpandAllIcon />
        </button>
      </Tooltip>
      <Tooltip text="Collapse All">
        <button
          type="button"
          className="branch-sidebar-btn"
          onClick={handleCollapseAll}
        >
          <CollapseAllIcon />
        </button>
      </Tooltip>
    </div>
  );
}

/* ─── Settings Button with Dropdown ──────────────────────────────── */

function SettingsButton() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <Tooltip text="Settings">
        <button
          type="button"
          className="branch-sidebar-btn"
          ref={btnRef}
          onClick={() => setOpen(!open)}
        >
          <SettingsIcon />
        </button>
      </Tooltip>
      {open && (
        <SettingsMenu onClose={() => setOpen(false)} triggerRef={btnRef} />
      )}
    </>
  );
}

function SettingsMenu({
  onClose,
  triggerRef,
}: {
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const branchGroupByDirectory = usePanelStore((s) => s.branchGroupByDirectory);
  const toggleBranchGroupByDirectory = usePanelStore(
    (s) => s.toggleBranchGroupByDirectory,
  );

  const menuRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const handleClick = (e: MouseEvent) => {
        const target = e.target as Node;
        if (node.contains(target)) return;
        if (triggerRef.current?.contains(target)) return;
        onClose();
      };
      const handleKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
      return () => {
        document.removeEventListener("mousedown", handleClick);
        document.removeEventListener("keydown", handleKey);
      };
    },
    [onClose, triggerRef],
  );

  return (
    <div
      ref={menuRef}
      className="commit-context-menu"
      style={{
        position: "fixed",
        left: 40,
        top: "50%",
        zIndex: 1000,
      }}
    >
      <div className="commit-context-menu-header">On Single Click</div>
      {/* 以下两项尚未实现（点击不会有任何效果），先禁用避免误导 */}
      <button
        type="button"
        className="commit-context-menu-item"
        disabled
        style={{ opacity: 0.5, cursor: "default" }}
      >
        <span>Update Branch Filter (未实现)</span>
      </button>
      <button
        type="button"
        className="commit-context-menu-item"
        disabled
        style={{ opacity: 0.5, cursor: "default" }}
      >
        <span>Navigate Log to Branch Head (未实现)</span>
      </button>
      <div className="commit-context-menu-separator" />
      <button
        type="button"
        className="commit-context-menu-item"
        onClick={() => {
          toggleBranchGroupByDirectory();
          onClose();
        }}
      >
        <span>{branchGroupByDirectory ? "✓ " : ""}Group by Directory</span>
      </button>
      <button
        type="button"
        className="commit-context-menu-item"
        disabled
        style={{ opacity: 0.5, cursor: "default" }}
      >
        <span>Show Tags (未实现)</span>
      </button>
    </div>
  );
}
