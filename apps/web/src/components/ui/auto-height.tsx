"use client";
import { useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";

/**
 * A box that glides to its content's new height: when what is inside grows or shrinks (another month, a list that fills or
 * empties), it eases to the new size instead of jumping, and everything below follows. Instant with reduced motion (globals.css).
 */
export function AutoHeight({ children, className }: { children: React.ReactNode; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // flow-root keeps a child's margins inside, so the measured height is the height shown.
  return <div className={clsx("vso-auto-height", className)} style={height === null ? undefined : { height }}><div ref={inner} className="flow-root">{children}</div></div>;
}
