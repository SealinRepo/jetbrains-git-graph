import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";

export function useSubmenuDirection(isOpen: boolean) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ opensLeft: false, overlap: 0 });

  useLayoutEffect(() => {
    if (!isOpen) {
      setPlacement({ opensLeft: false, overlap: 0 });
      return;
    }

    const trigger = triggerRef.current;
    const submenu = trigger?.querySelector<HTMLElement>(
      ".commit-context-submenu",
    );
    if (!trigger || !submenu) return;

    const triggerRect = trigger.getBoundingClientRect();
    const submenuWidth = submenu.getBoundingClientRect().width;
    const gap = 2;
    const viewportPadding = 4;
    const rightSpace = Math.max(
      0,
      window.innerWidth - triggerRect.right - gap - viewportPadding,
    );
    const leftSpace = Math.max(0, triggerRect.left - gap - viewportPadding);
    const opensLeft = rightSpace < submenuWidth && leftSpace > rightSpace;
    const availableSpace = opensLeft ? leftSpace : rightSpace;
    setPlacement({
      opensLeft,
      overlap: Math.max(0, submenuWidth - availableSpace),
    });
  }, [isOpen]);

  const submenuStyle = {
    "--submenu-overlap": `${placement.overlap}px`,
  } as CSSProperties;

  return { triggerRef, opensLeft: placement.opensLeft, submenuStyle };
}
