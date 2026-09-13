import { useCallback, useState } from "react";
import { bridge } from "../../shared/bridge";
import {
  CheckIcon,
  CollapseAllIcon,
  DiffIcon,
  ExpandAllIcon,
  PullIcon,
  PushIcon,
  RollbackIcon,
  ShelveIcon,
  ViewOptionsIcon,
} from "../../shared/components/Icons";
import { Tooltip } from "../../shared/components/Tooltip";
import "../../shared/components/Tooltip.css";
import { useCommitStore } from "../../shared/store/commit-store";

interface ToolbarProps {
  onShelve: () => void;
  onRollback: () => void;
  hasChanges: boolean;
}

export function Toolbar({ onShelve, onRollback, hasChanges }: ToolbarProps) {
  const [showViewMenu, setShowViewMenu] = useState(false);
  const { expandedGroups, toggleGroup, expandAllDirs } = useCommitStore();

  const handleExpandAll = useCallback(() => {
    // Expand file groups
    const groups = ["changes", "unversioned"];
    for (const g of groups) {
      if (!expandedGroups.has(g)) {
        toggleGroup(g);
      }
    }
    // Expand all directories in tree view
    expandAllDirs();
  }, [expandedGroups, toggleGroup, expandAllDirs]);

  const handleCollapseAll = useCallback(() => {
    // Collapse file groups
    const groups = ["changes", "unversioned"];
    for (const g of groups) {
      if (expandedGroups.has(g)) {
        toggleGroup(g);
      }
    }
  }, [expandedGroups, toggleGroup]);

  return (
    <div className="commit-toolbar">
      <Tooltip text="Rollback">
        <button
          type="button"
          className="commit-toolbar-btn"
          onClick={onRollback}
          disabled={!hasChanges}
        >
          <RollbackIcon />
        </button>
      </Tooltip>
      <Tooltip text="Shelve Changes">
        <button
          type="button"
          className="commit-toolbar-btn"
          onClick={onShelve}
          disabled={!hasChanges}
        >
          <ShelveIcon />
        </button>
      </Tooltip>
      <Tooltip text="Show Diff">
        <button
          type="button"
          className="commit-toolbar-btn"
          disabled={!hasChanges}
        >
          <DiffIcon />
        </button>
      </Tooltip>
      <Tooltip text="Update">
        <button
          type="button"
          className="commit-toolbar-btn"
          style={{ opacity: 1 }}
          onClick={() => bridge.request("updateBranch", {})}
        >
          <PullIcon />
        </button>
      </Tooltip>
      <Tooltip text="Push...">
        <button
          type="button"
          className="commit-toolbar-btn"
          style={{ opacity: 1 }}
          onClick={() => bridge.request("openPushPanel")}
        >
          <PushIcon />
        </button>
      </Tooltip>

      <div className="commit-toolbar-spacer" />

      <div style={{ position: "relative" }}>
        <Tooltip text="View Options">
          <button
            type="button"
            className="commit-toolbar-btn"
            onClick={() => setShowViewMenu(!showViewMenu)}
          >
            <ViewOptionsIcon />
          </button>
        </Tooltip>
        {showViewMenu && (
          <ViewOptionsMenu onClose={() => setShowViewMenu(false)} />
        )}
      </div>
      <Tooltip text="Expand All">
        <button
          type="button"
          className="commit-toolbar-btn"
          onClick={handleExpandAll}
        >
          <ExpandAllIcon />
        </button>
      </Tooltip>
      <Tooltip text="Collapse All">
        <button
          type="button"
          className="commit-toolbar-btn"
          onClick={handleCollapseAll}
        >
          <CollapseAllIcon />
        </button>
      </Tooltip>
    </div>
  );
}

/* ─── View Options Menu ──────────────────────────────────────────── */

function ViewOptionsMenu({ onClose }: { onClose: () => void }) {
  const {
    groupByDirectory,
    toggleGroupByDirectory,
    showUnversioned,
    toggleShowUnversioned,
  } = useCommitStore();

  return (
    <>
      {/* Backdrop to close */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 999 }}
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      />
      <div
        className="commit-context-menu"
        style={{
          position: "absolute",
          top: "100%",
          right: 0,
          marginTop: 4,
          zIndex: 1000,
        }}
      >
        <div className="commit-context-menu-header">Group By</div>
        <button
          type="button"
          className="commit-context-menu-item"
          onClick={() => {
            toggleGroupByDirectory();
            onClose();
          }}
        >
          <span className="commit-context-menu-icon">
            {groupByDirectory && <CheckIcon />}
          </span>
          <span>Directory</span>
          <span className="commit-context-menu-shortcut">^P</span>
        </button>
        <div className="commit-context-menu-separator" />
        <div className="commit-context-menu-header">Show</div>
        <button
          type="button"
          className="commit-context-menu-item"
          onClick={() => {
            toggleShowUnversioned();
            onClose();
          }}
        >
          <span className="commit-context-menu-icon">
            {showUnversioned && <CheckIcon />}
          </span>
          <span>Unversioned Files</span>
        </button>
      </div>
    </>
  );
}
