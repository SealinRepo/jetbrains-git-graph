import { useCallback, useState } from "react";
import { bridge } from "../../shared/bridge";
import {
  AddIcon,
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

      {/* Changelist quick controls — always visible so users discover the
          feature without having to right-click anything first. Even when no
          user changelist exists, the dropdown still shows the default as
          "(no active changelist)" and the + button can create one inline. */}
      <ChangelistControls />

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

/* ─── Changelist controls ──────────────────────────────────────── */

function ChangelistControls() {
  const changelists = useCommitStore((s) => s.changelists);
  const activeId = useCommitStore((s) => s.activeChangelistId);
  const defaultId = useCommitStore((s) => s.defaultChangelistId);
  const createChangelist = useCommitStore((s) => s.createChangelist);
  const setActive = useCommitStore((s) => s.setActiveChangelist);

  const handleNew = () => {
    const name = window.prompt("New changelist name:");
    if (!name) return;
    void createChangelist(name);
  };

  // 显示当前激活列表的名字；没显式激活时回退到默认列表的标签。
  const activeList = changelists.find((c) => c.id === activeId);
  const defaultList = changelists.find((c) => c.id === defaultId);
  const dropdownLabel = activeList
    ? activeList.name
    : defaultList
      ? `(active: ${defaultList.name})`
      : "(active: Changes)";

  return (
    <>
      <div className="commit-toolbar-changelist-dropdown">
        <label htmlFor="commit-toolbar-active-changelist">Active:</label>
        <select
          id="commit-toolbar-active-changelist"
          value={activeId ?? defaultId ?? ""}
          onChange={(e) => void setActive(e.target.value)}
          title={dropdownLabel}
        >
          {changelists.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.isDefault ? " (default)" : ""}
            </option>
          ))}
        </select>
      </div>
      <Tooltip text="New Changelist">
        <button
          type="button"
          className="commit-toolbar-btn"
          onClick={handleNew}
        >
          <AddIcon />
        </button>
      </Tooltip>
    </>
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
