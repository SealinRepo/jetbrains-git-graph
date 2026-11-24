import { Allotment } from "allotment";
import { useCallback, useEffect, useRef, useState } from "react";
import CodiconListFlat from "~icons/codicon/list-flat";
import CodiconListTree from "~icons/codicon/list-tree";
import { bridge } from "../shared/bridge";
import { CommitInfo } from "../shared/components/CommitInfo";
import { FileTree } from "../shared/components/FileTree";
import { DropdownChevronIcon } from "../shared/components/Icons";
import type { Commit, DiffFile } from "../shared/types/git";
import { RemoteBranchSelector } from "./components/RemoteBranchSelector";
import { useDraggableDivider } from "./hooks/useDraggableDivider";
import { formatRemoteBranchLabel } from "./utils/branchUtils";
import "./push.css";

interface PushRejectedState {
  show: boolean;
  branchName: string;
}

function PushRejectedDialog({
  branchName,
  onRebase,
  onMerge,
  onCancel,
  remember,
  onRememberChange,
}: {
  branchName: string;
  onRebase: () => void;
  onMerge: () => void;
  onCancel: () => void;
  remember: boolean;
  onRememberChange: (remember: boolean) => void;
}) {
  return (
    <div className="push-rejected-overlay">
      <div className="push-rejected-dialog">
        <div className="push-rejected-header">
          <span className="push-rejected-icon">⚠️</span>
          <span className="push-rejected-title">Push Rejected</span>
        </div>
        <p className="push-rejected-message">
          Push of the current branch "{branchName}" was rejected. Remote changes
          need to be merged before pushing.
        </p>
        <label className="push-rejected-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => onRememberChange(event.target.checked)}
          />
          <span>Keep this merge method</span>
        </label>
        <div className="push-rejected-actions">
          <button
            type="button"
            className="push-btn push-btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="push-btn push-btn-rebase"
            onClick={onRebase}
          >
            Rebase
          </button>
          <button
            type="button"
            className="push-btn push-btn-merge"
            onClick={onMerge}
          >
            Merge
          </button>
        </div>
      </div>
    </div>
  );
}

export function PushApp() {
  const root = document.getElementById("root");
  const branchName = root?.dataset.branch ?? "";
  const remoteName = root?.dataset.remote ?? "origin";

  const [commits, setCommits] = useState<Commit[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPushMenu, setShowPushMenu] = useState(false);
  const [pushRejected, setPushRejected] = useState<PushRejectedState>({
    show: false,
    branchName: "",
  });
  const [rememberRejectedStrategy, setRememberRejectedStrategy] =
    useState(false);

  // Editable remote branch target state
  const [targetRemote, setTargetRemote] = useState(remoteName);
  const [targetBranch, setTargetBranch] = useState(branchName);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"tree" | "flat">("tree");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const headerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { leftWidthPercent, isDragging, dividerProps } =
    useDraggableDivider(bodyRef);

  useEffect(() => {
    async function load() {
      try {
        const result = (await bridge.request("getAheadCommits", {
          branchName,
          remote: targetRemote,
        })) as { commits: Commit[] } | null;
        const list = result?.commits ?? [];
        setCommits(list);
        if (list.length > 0) {
          setSelectedHash(list[0].hash);
        }
      } catch (err) {
        console.error("Failed to load ahead commits:", err);
      }
    }
    load();
  }, [branchName, targetRemote]);

  useEffect(() => {
    if (!selectedHash) {
      setFiles([]);
      return;
    }
    async function load() {
      try {
        const result = (await bridge.request("getCommitRangeFiles", {
          hashes: [selectedHash],
        })) as DiffFile[] | null;
        setFiles(result ?? []);
      } catch (err) {
        console.error("Failed to load commit files:", err);
      }
    }
    load();
  }, [selectedHash]);

  const handlePush = useCallback(
    async (force = false) => {
      setPushing(true);
      setError(null);
      try {
        const result = (await bridge.request("executePush", {
          branchName,
          remote: targetRemote,
          targetBranch: targetBranch,
          force,
        })) as { data?: { output?: string; isUpToDate?: boolean } };
        setPushing(false);
        const isUpToDate = result?.data?.isUpToDate;
        const message = isUpToDate
          ? "Everything is up to date"
          : `Pushed ${commits.length} commit${commits.length !== 1 ? "s" : ""} to ${targetRemote}/${targetBranch}`;
        // Show VS Code native notification then close
        bridge.request("showInfoNotification", { message }).catch(() => {});
        setTimeout(() => {
          bridge.request("closePushPanel");
        }, 500);
      } catch (err) {
        setPushing(false);
        const msg = err instanceof Error ? err.message : String(err);
        // Detect push rejected due to non-fast-forward
        if (
          msg.includes("non-fast-forward") ||
          msg.includes("[rejected]") ||
          msg.includes("failed to push some refs")
        ) {
          const remembered = localStorage.getItem(
            `jetgit.push-rejected-strategy:${targetRemote}:${targetBranch}`,
          );
          if (remembered === "rebase" || remembered === "merge") {
            setPushing(true);
            try {
              await bridge.request("updateBranch", {
                branchName,
                strategy: remembered,
              });
              await bridge.request("executePush", {
                branchName,
                remote: targetRemote,
                targetBranch,
                force: false,
              });
              const label = remembered === "rebase" ? "Rebased" : "Merged";
              bridge
                .request("showInfoNotification", {
                  message: `${label} and pushed to ${targetRemote}/${targetBranch}`,
                })
                .catch(() => {});
              setTimeout(() => bridge.request("closePushPanel"), 500);
            } catch (retryErr) {
              const retryMsg =
                retryErr instanceof Error ? retryErr.message : String(retryErr);
              setError(retryMsg);
              bridge
                .request("showErrorNotification", { message: retryMsg })
                .catch(() => {});
            } finally {
              setPushing(false);
            }
          } else {
            setPushRejected({ show: true, branchName });
            setError(msg);
          }
        } else {
          setError(msg);
          bridge
            .request("showErrorNotification", { message: msg })
            .catch(() => {});
        }
      }
    },
    [branchName, targetRemote, targetBranch, commits.length],
  );

  const handleRebaseAndPush = useCallback(async () => {
    if (rememberRejectedStrategy) {
      localStorage.setItem(
        `jetgit.push-rejected-strategy:${targetRemote}:${targetBranch}`,
        "rebase",
      );
    }
    setPushRejected({ show: false, branchName: "" });
    setError(null);
    setPushing(true);
    try {
      await bridge.request("updateBranch", { branchName, strategy: "rebase" });
      // After successful rebase, retry push
      await bridge.request("executePush", {
        branchName,
        remote: targetRemote,
        targetBranch: targetBranch,
        force: false,
      });
      setPushing(false);
      const message = `Rebased and pushed to ${targetRemote}/${targetBranch}`;
      bridge.request("showInfoNotification", { message }).catch(() => {});
      setTimeout(() => {
        bridge.request("closePushPanel");
      }, 500);
    } catch (err) {
      setPushing(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      bridge.request("showErrorNotification", { message: msg }).catch(() => {});
    }
  }, [branchName, targetRemote, targetBranch, rememberRejectedStrategy]);

  const handleMergeAndPush = useCallback(async () => {
    if (rememberRejectedStrategy) {
      localStorage.setItem(
        `jetgit.push-rejected-strategy:${targetRemote}:${targetBranch}`,
        "merge",
      );
    }
    setPushRejected({ show: false, branchName: "" });
    setError(null);
    setPushing(true);
    try {
      await bridge.request("updateBranch", { branchName, strategy: "merge" });
      // After successful merge, retry push
      await bridge.request("executePush", {
        branchName,
        remote: targetRemote,
        targetBranch: targetBranch,
        force: false,
      });
      setPushing(false);
      const message = `Merged and pushed to ${targetRemote}/${targetBranch}`;
      bridge.request("showInfoNotification", { message }).catch(() => {});
      setTimeout(() => {
        bridge.request("closePushPanel");
      }, 500);
    } catch (err) {
      setPushing(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      bridge.request("showErrorNotification", { message: msg }).catch(() => {});
    }
  }, [branchName, targetRemote, targetBranch, rememberRejectedStrategy]);

  const handleBranchSelect = useCallback((branch: string) => {
    setTargetBranch(branch);
    setSelectorOpen(false);
  }, []);

  const handleRemoteSelect = useCallback((remote: string) => {
    setTargetRemote(remote);
  }, []);

  const handleSelectorClose = useCallback(() => {
    setSelectorOpen(false);
  }, []);

  const handleLabelClick = useCallback(() => {
    setSelectorOpen((prev) => !prev);
  }, []);

  const selectedCommit = commits.find((c) => c.hash === selectedHash);

  return (
    <div className="push-container">
      {/* Header */}
      <div className="push-header" ref={headerRef}>
        <span className="push-route">
          {branchName} →{" "}
          <span
            className="push-route-target push-route-target--interactive"
            onClick={handleLabelClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleLabelClick();
              }
            }}
          >
            {formatRemoteBranchLabel(targetRemote, targetBranch)}
            <DropdownChevronIcon
              className="push-route-target__indicator"
              size={10}
            />
          </span>
        </span>
        {selectorOpen && (
          <RemoteBranchSelector
            currentRemote={targetRemote}
            currentBranch={targetBranch}
            onRemoteChange={handleRemoteSelect}
            onBranchChange={handleBranchSelect}
            onClose={handleSelectorClose}
          />
        )}
      </div>

      {/* Main content */}
      <div className="push-body" ref={bodyRef}>
        {/* Left: commit list */}
        <div className="push-commits" style={{ width: `${leftWidthPercent}%` }}>
          {commits.length === 0 ? (
            <div className="push-empty">No commits to push</div>
          ) : (
            commits.map((c) => (
              <div
                key={c.hash}
                className={`push-commit-item${selectedHash === c.hash ? " selected" : ""}`}
                onClick={() => setSelectedHash(c.hash)}
              >
                <span className="push-commit-subject">{c.subject}</span>
              </div>
            ))
          )}
        </div>

        {/* Draggable divider */}
        <div
          className={`push-divider${isDragging ? " push-divider--dragging" : ""}`}
          {...dividerProps}
        />

        {/* Right: file list + commit detail (reusing git log's layout) */}
        <div className="push-detail">
          {selectedCommit && (
            <Allotment vertical>
              <Allotment.Pane minSize={60} preferredSize="40%">
                <div
                  style={{
                    height: "100%",
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <div
                    style={{
                      padding: "6px 12px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: "0.8em",
                        opacity: 0.6,
                        textTransform: "uppercase",
                      }}
                    >
                      {files.length} file{files.length !== 1 ? "s" : ""}
                    </span>
                    <span style={{ display: "flex", gap: 2 }}>
                      <button
                        type="button"
                        onClick={() => setViewMode("tree")}
                        style={{
                          background:
                            viewMode === "tree"
                              ? "var(--selected-bg)"
                              : "transparent",
                          border: "none",
                          borderRadius: 3,
                          cursor: "pointer",
                          padding: "2px 4px",
                          display: "flex",
                          alignItems: "center",
                          color: "inherit",
                        }}
                        title="Tree View"
                      >
                        <CodiconListTree />
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewMode("flat")}
                        style={{
                          background:
                            viewMode === "flat"
                              ? "var(--selected-bg)"
                              : "transparent",
                          border: "none",
                          borderRadius: 3,
                          cursor: "pointer",
                          padding: "2px 4px",
                          display: "flex",
                          alignItems: "center",
                          color: "inherit",
                        }}
                        title="Flat List"
                      >
                        <CodiconListFlat />
                      </button>
                    </span>
                  </div>
                  <div
                    style={{ flex: 1, overflow: "auto", overflowX: "hidden" }}
                  >
                    <FileTree
                      files={files}
                      viewMode={viewMode}
                      selectedFiles={[]}
                      onFileClick={(_e, file) => {
                        if (selectedHash) {
                          bridge.request("openDiffEditor", {
                            commit: selectedHash,
                            filePath: file.newPath || file.oldPath,
                            file,
                          });
                        }
                      }}
                      collapsed={collapsed}
                      onToggle={(key) =>
                        setCollapsed((prev) => ({
                          ...prev,
                          [key]: !prev[key],
                        }))
                      }
                    />
                  </div>
                </div>
              </Allotment.Pane>
              <Allotment.Pane minSize={60}>
                <div style={{ height: "100%", overflow: "auto", padding: 12 }}>
                  <CommitInfo commit={selectedCommit} />
                </div>
              </Allotment.Pane>
            </Allotment>
          )}
          {!selectedCommit && (
            <div style={{ padding: 12, opacity: 0.5 }}>No commits selected</div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="push-footer">
        {error && <span className="push-error">{error}</span>}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="push-btn push-btn-secondary"
          onClick={() => bridge.request("closePushPanel")}
          disabled={pushing}
        >
          Cancel
        </button>
        <div className="push-split-btn">
          <button
            type="button"
            className="push-btn push-btn-primary push-split-main"
            onClick={() => handlePush(false)}
            disabled={pushing || commits.length === 0}
          >
            {pushing ? "Pushing..." : "Push"}
          </button>
          <button
            type="button"
            className="push-btn push-btn-primary push-split-arrow"
            onClick={() => setShowPushMenu(!showPushMenu)}
            disabled={pushing || commits.length === 0}
          >
            <DropdownChevronIcon />
          </button>
          {showPushMenu && (
            <>
              <div
                className="push-menu-backdrop"
                onClick={() => setShowPushMenu(false)}
              />
              <div className="push-menu">
                <button
                  type="button"
                  className="push-menu-item"
                  onClick={() => {
                    setShowPushMenu(false);
                    handlePush(true);
                  }}
                >
                  Force Push
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {pushing && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            zIndex: 10000,
            overflow: "hidden",
            background: "rgba(0, 122, 204, 0.15)",
          }}
        >
          <div
            style={{
              height: "100%",
              width: "40%",
              background:
                "linear-gradient(90deg, transparent, #007acc 30%, #3794ff 70%, transparent)",
              animation: "progress-slide 1s infinite linear",
            }}
          />
          <style>
            {`@keyframes progress-slide {
              0% { transform: translateX(-100%); }
              100% { transform: translateX(250%); }
            }`}
          </style>
        </div>
      )}

      {/* Push Rejected Dialog */}
      {pushRejected.show && (
        <PushRejectedDialog
          branchName={pushRejected.branchName}
          onRebase={handleRebaseAndPush}
          onMerge={handleMergeAndPush}
          onCancel={() => setPushRejected({ show: false, branchName: "" })}
          remember={rememberRejectedStrategy}
          onRememberChange={setRememberRejectedStrategy}
        />
      )}
    </div>
  );
}
