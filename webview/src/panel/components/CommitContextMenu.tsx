import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { bridge, bridgeWithProgress } from "../../shared/bridge";
import {
  BranchIcon,
  CherryPickIcon,
  CopyIcon,
  RollbackIcon,
  TagIcon,
} from "../../shared/components/Icons";
import { usePanelStore } from "../../shared/store/panel-store";
import type { Commit } from "../../shared/types/git";

interface CommitContextMenuProps {
  x: number;
  y: number;
  commit: Commit;
  onClose: () => void;
  onCreateBranch?: (hash: string, defaultName: string) => void;
}

export function CommitContextMenu({
  x,
  y,
  commit,
  onClose,
  onCreateBranch,
}: CommitContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const submenuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentBranch = usePanelStore((s) => s.currentBranch);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [isRebasing, setIsRebasing] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isCherryPicking, setIsCherryPicking] = useState(false);
  const [resetSubmenu, setResetSubmenu] = useState<{
    top: number;
    left: number;
  } | null>(null);

  // Query rebase/merge/cherry-pick state to determine if Drop Commit should be disabled
  useEffect(() => {
    const fetchRepoState = async () => {
      try {
        const [rebaseState, mergeState, cherryPickState] = await Promise.all([
          bridge.request("getRebaseState") as Promise<{ isRebasing: boolean }>,
          bridge.request("getMergeState") as Promise<{ isMerging: boolean }>,
          bridge.request("getCherryPickState") as Promise<{
            isCherryPicking: boolean;
          }>,
        ]);
        setIsRebasing(rebaseState?.isRebasing ?? false);
        setIsMerging(mergeState?.isMerging ?? false);
        setIsCherryPicking(cherryPickState?.isCherryPicking ?? false);
      } catch {
        // If we can't determine state, leave as not disabled
      }
    };
    fetchRepoState();
  }, []);

  // Adjust position after first render
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;

      let top = y;
      let left = x;

      if (top + rect.height > viewportH) {
        const above = y - rect.height;
        if (above >= 4) {
          top = above;
        } else {
          top = Math.max(4, viewportH - rect.height - 4);
        }
      }
      if (left + rect.width > viewportW) {
        left = Math.max(4, viewportW - rect.width - 4);
      }

      setPosition({ top, left });
    });
  }, [x, y]);

  useEffect(() => {
    const isInsideMenu = (target: EventTarget | null) =>
      target instanceof Node &&
      Boolean(
        menuRef.current?.contains(target) ||
          submenuRef.current?.contains(target),
      );
    const handleClickOutside = (e: MouseEvent) => {
      if (!isInsideMenu(e.target)) onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleBlur = () => onClose();
    const handleScroll = (e: Event) => {
      if (!isInsideMenu(e.target)) onClose();
    };
    const handleContextMenu = (e: MouseEvent) => {
      if (!isInsideMenu(e.target)) onClose();
    };
    document.addEventListener("mousedown", handleClickOutside, true);
    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleBlur);
    return () => {
      if (submenuCloseTimer.current) clearTimeout(submenuCloseTimer.current);
      document.removeEventListener("mousedown", handleClickOutside, true);
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleBlur);
    };
  }, [onClose]);

  const shortHash = commit.shortHash || commit.hash.slice(0, 8);

  const handleCopyHash = async () => {
    onClose();
    try {
      await bridge.request("copyToClipboard", { text: commit.hash });
    } catch (err) {
      console.error("Copy failed:", err);
    }
  };

  const handleCopyMessage = async () => {
    onClose();
    try {
      const message = commit.body
        ? `${commit.subject}\n\n${commit.body}`
        : commit.subject;
      await bridge.request("copyToClipboard", { text: message });
    } catch (err) {
      console.error("Copy commit message failed:", err);
    }
  };

  const handleCherryPick = async () => {
    onClose();
    try {
      await bridgeWithProgress("cherryPick", { hash: commit.hash });
      void bridge
        .request("showInfoNotification", {
          message: `Cherry-pick ${shortHash} completed successfully`,
        })
        .catch((err) => console.error("Cherry-pick notification failed:", err));
    } catch (err) {
      console.error("Cherry-pick failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      void bridge
        .request("showErrorNotification", {
          message: `Cherry-pick failed: ${message}`,
        })
        .catch((notificationError) =>
          console.error("Cherry-pick notification failed:", notificationError),
        );
    }
  };

  const handleCheckoutRevision = async () => {
    onClose();
    try {
      await bridgeWithProgress("checkoutCommit", { hash: commit.hash });
    } catch (err) {
      console.error("Checkout revision failed:", err);
    }
  };

  const handleResetHard = async () => {
    onClose();
    const result = (await bridge.request("showConfirmMessage", {
      message: `Reset '${currentBranch}' to ${shortHash} (hard)? This will discard all uncommitted changes.`,
      confirmLabel: "Reset",
    })) as { confirmed: boolean };
    if (!result.confirmed) return;
    try {
      await bridgeWithProgress("resetToCommit", {
        hash: commit.hash,
        mode: "hard",
      });
    } catch (err) {
      console.error("Reset failed:", err);
    }
  };

  const handleResetMixed = async () => {
    onClose();
    try {
      await bridgeWithProgress("resetToCommit", {
        hash: commit.hash,
        mode: "mixed",
      });
    } catch (err) {
      console.error("Reset failed:", err);
    }
  };

  const handleResetSoft = async () => {
    onClose();
    try {
      await bridgeWithProgress("resetToCommit", {
        hash: commit.hash,
        mode: "soft",
      });
    } catch (err) {
      console.error("Reset failed:", err);
    }
  };

  const handleRevert = async () => {
    onClose();
    try {
      await bridgeWithProgress("revertCommit", { hash: commit.hash });
    } catch (err) {
      console.error("Revert failed:", err);
    }
  };

  const handleDropCommit = async () => {
    onClose();
    try {
      const result = (await bridge.request("showConfirmMessage", {
        message: `Drop commit ${shortHash} "${commit.subject}"?\n\nThis will remove the commit from history but keep its changes as unstaged modifications.\n\nThis operation cannot be undone.`,
        confirmLabel: "Drop Commit",
      })) as { confirmed: boolean };
      if (!result.confirmed) return;
      await bridgeWithProgress("dropCommit", { hash: commit.hash });
    } catch (err) {
      console.error("Drop commit failed:", err);
    }
  };

  const handleNewBranch = async () => {
    onClose();
    if (onCreateBranch) {
      onCreateBranch(commit.hash, "");
      return;
    }
    // Fallback to showInputBox if no dialog handler provided
    const result = (await bridge.request("showInputBox", {
      prompt: `Create new branch from ${shortHash}:`,
      placeHolder: "branch-name",
    })) as { value: string | null };
    if (!result.value || !result.value.trim()) return;
    try {
      await bridge.request("createBranchFromCommit", {
        branchName: result.value.trim(),
        hash: commit.hash,
      });
    } catch (err) {
      console.error("Create branch failed:", err);
    }
  };

  const handleNewTag = async () => {
    onClose();
    const result = (await bridge.request("showInputBox", {
      prompt: `Create tag at ${shortHash}:`,
      placeHolder: "tag-name",
    })) as { value: string | null };
    if (!result.value || !result.value.trim()) return;
    try {
      await bridge.request("createTag", {
        tagName: result.value.trim(),
        hash: commit.hash,
      });
    } catch (err) {
      console.error("Create tag failed:", err);
    }
  };

  const filter = usePanelStore((s) => s.filter);
  const selectCommit = usePanelStore((s) => s.selectCommit);

  const keepResetSubmenuOpen = () => {
    if (submenuCloseTimer.current) clearTimeout(submenuCloseTimer.current);
    submenuCloseTimer.current = null;
  };

  const scheduleResetSubmenuClose = () => {
    if (submenuCloseTimer.current) clearTimeout(submenuCloseTimer.current);
    submenuCloseTimer.current = setTimeout(() => {
      setResetSubmenu(null);
      submenuCloseTimer.current = null;
    }, 120);
  };

  const handleShowInGitLog = () => {
    onClose();
    // Clear file filter and select this commit in the full log
    usePanelStore.getState().setFilter({ file: "" });
    // After refresh, select this commit
    setTimeout(() => {
      selectCommit(commit.hash);
    }, 500);
  };

  // Drop Commit is disabled when in detached HEAD, rebasing, merging, or cherry-picking
  const isDropCommitDisabled =
    !currentBranch || isRebasing || isMerging || isCherryPicking;

  const items: {
    label: string;
    action: () => void;
    separator?: boolean;
    icon?: React.ReactNode;
    disabled?: boolean;
    children?: { label: string; action: () => void; icon?: React.ReactNode }[];
  }[] = [
    {
      label: `Copy Revision Number`,
      action: handleCopyHash,
      icon: <CopyIcon />,
    },
    {
      label: "Copy Commit Message",
      action: handleCopyMessage,
      icon: <CopyIcon />,
    },
    {
      label: "Cherry-Pick",
      action: handleCherryPick,
      icon: <CherryPickIcon />,
    },
    { label: "", action: () => {}, separator: true },
    { label: "Checkout Revision", action: handleCheckoutRevision },
    { label: "", action: () => {}, separator: true },
    {
      label: "Reset",
      action: () => {},
      icon: <RollbackIcon />,
      children: [
        { label: "Reset to Here (Mixed)...", action: handleResetMixed },
        { label: "Reset to Here (Soft)...", action: handleResetSoft },
        { label: "Reset to Here (Hard)...", action: handleResetHard },
      ],
    },
    { label: "Revert Commit", action: handleRevert, icon: <RollbackIcon /> },
    {
      label: "Drop Commit",
      action: handleDropCommit,
      icon: <RollbackIcon />,
      disabled: isDropCommitDisabled,
    },
    { label: "", action: () => {}, separator: true },
    { label: "New Branch...", action: handleNewBranch, icon: <BranchIcon /> },
    { label: "New Tag...", action: handleNewTag, icon: <TagIcon /> },
  ];

  // Add "Show in Git Log" when file filter is active
  if (filter.file) {
    items.push({ label: "", action: () => {}, separator: true });
    items.push({
      label: "Show in Git Log",
      action: handleShowInGitLog,
      icon: <BranchIcon />,
    });
  }

  const menu = (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: position ? position.top : -9999,
        left: position ? position.left : -9999,
        zIndex: 9999,
        background: "var(--vscode-menu-background, #1e1e1e)",
        border: "1px solid var(--vscode-menu-border, #454545)",
        borderRadius: 4,
        padding: "4px 0",
        minWidth: 200,
        maxHeight: "calc(100vh - 8px)",
        overflowY: "auto",
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        visibility: position ? "visible" : "hidden",
      }}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div
            key={`sep-${i}`}
            style={{
              height: 1,
              background: "var(--vscode-menu-separatorBackground, #454545)",
              margin: "4px 0",
            }}
          />
        ) : item.children ? (
          <div
            key={item.label}
            onMouseEnter={(e) => {
              keepResetSubmenuOpen();
              const rect = e.currentTarget.getBoundingClientRect();
              const width = 220;
              const height = (item.children?.length ?? 0) * 32 + 8;
              setResetSubmenu({
                top: Math.min(rect.top, window.innerHeight - height - 4),
                left:
                  rect.right + width <= window.innerWidth
                    ? rect.right - 2
                    : rect.left - width + 2,
              });
            }}
            onMouseLeave={scheduleResetSubmenuClose}
            style={{
              padding: "6px 12px",
              cursor: "pointer",
              color: "var(--vscode-menu-foreground, #ccc)",
              fontSize: "13px",
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
            onMouseOver={(e) => {
              (e.currentTarget as HTMLElement).style.background =
                "var(--vscode-list-hoverBackground, #2a2d2e)";
            }}
            onMouseOut={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            <span style={{ width: 16, flexShrink: 0, opacity: 0.7 }}>
              {item.icon ?? null}
            </span>
            {item.label}
            <span style={{ marginLeft: "auto", opacity: 0.7 }}>›</span>
          </div>
        ) : (
          <div
            key={item.label}
            onClick={item.disabled ? undefined : item.action}
            style={{
              padding: "6px 12px",
              cursor: item.disabled ? "default" : "pointer",
              opacity: item.disabled ? 0.5 : 1,
              color: "var(--vscode-menu-foreground, #ccc)",
              fontSize: "13px",
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
            onMouseEnter={(e) => {
              if (!item.disabled) {
                (e.currentTarget as HTMLElement).style.background =
                  "var(--vscode-list-hoverBackground, #2a2d2e)";
                (e.currentTarget as HTMLElement).style.color =
                  "var(--vscode-menu-selectionForeground, #fff)";
              }
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
              (e.currentTarget as HTMLElement).style.color =
                "var(--vscode-menu-foreground, #ccc)";
            }}
          >
            <span style={{ width: 16, flexShrink: 0, opacity: 0.7 }}>
              {item.icon ?? null}
            </span>
            {item.label}
          </div>
        ),
      )}
    </div>
  );

  const submenu = resetSubmenu && (
    <div
      ref={submenuRef}
      style={{
        position: "fixed",
        top: resetSubmenu.top,
        left: resetSubmenu.left,
        zIndex: 10000,
        minWidth: 220,
        padding: "4px 0",
        background: "var(--vscode-menu-background, #1e1e1e)",
        border: "1px solid var(--vscode-menu-border, #454545)",
        borderRadius: 4,
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
      }}
      onMouseEnter={keepResetSubmenuOpen}
      onMouseLeave={scheduleResetSubmenuClose}
    >
      {items
        .find((item) => item.label === "Reset")
        ?.children?.map((child) => (
          <div
            key={child.label}
            onClick={child.action}
            style={{
              padding: "6px 12px",
              cursor: "pointer",
              color: "var(--vscode-menu-foreground, #ccc)",
              fontSize: "13px",
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background =
                "var(--vscode-list-hoverBackground, #2a2d2e)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            {child.label}
          </div>
        ))}
    </div>
  );

  return createPortal(
    <>
      {menu}
      {submenu}
    </>,
    document.body,
  );
}
