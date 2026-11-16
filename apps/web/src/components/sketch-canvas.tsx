'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The sketch, on a canvas you can move around.
 *
 * A board of states is much wider than a dialog, and a single phone screen is much taller: at "fit"
 * you can see the shape of the whole thing, and at 1:1 you can read the small print in a frame. So the
 * picture is drawn at its own pixel size and transformed — never re-laid-out — which keeps every
 * percentage-positioned marker exactly on the pixels it was measured against.
 *
 * Drag to pan, wheel to zoom (toward the pointer, so the thing you are looking at stays put), and the
 * buttons for fit, 1:1, and in-between.
 */
export function SketchCanvas({
  width,
  height,
  label,
  controls,
  children,
}: {
  width: number;
  height: number;
  label: string;
  /** The state and component chips, drawn as a bar under the canvas. */
  controls?: ReactNode;
  children: ReactNode;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // The pane's own size decides what "fit" means, and it changes when the window does.
  useLayoutEffect(() => {
    const node = paneRef.current;
    if (!node) return;
    const measure = (): void => setPane({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // A different screen is a different board: start again at "fit".
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [width, height, label]);

  const fit = pane.width > 0 && pane.height > 0 ? Math.min((pane.width - 32) / width, (pane.height - 32) / height) : 1;
  const scale = fit * zoom;

  const zoomBy = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      setZoom((current) => {
        const next = Math.min(8, Math.max(0.2, current * factor));
        const pane_ = paneRef.current;
        if (at && pane_) {
          // Keep the point under the cursor where it is: zooming toward the middle of the pane makes
          // anything you were reading slide away.
          const rect = pane_.getBoundingClientRect();
          const centreX = rect.width / 2;
          const centreY = rect.height / 2;
          const before = fit * current;
          const after = fit * next;
          const stageX = (at.x - centreX - pan.x) / before;
          const stageY = (at.y - centreY - pan.y) / before;
          setPan({ x: at.x - centreX - stageX * after, y: at.y - centreY - stageY * after });
        }
        return next;
      });
    },
    [fit, pan.x, pan.y],
  );

  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    zoomBy(Math.exp(-event.deltaY * 0.0015), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={paneRef}
        data-sketch-pane
        onWheel={onWheel}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (!state || state.pointerId !== event.pointerId) return;
          const dx = event.clientX - state.startX;
          const dy = event.clientY - state.startY;
          // A few pixels of slop, so a click on a marker is not read as the start of a pan.
          if (!dragging && Math.abs(dx) + Math.abs(dy) > 4) setDragging(true);
          if (dragging || Math.abs(dx) + Math.abs(dy) > 4) setPan({ x: state.panX + dx, y: state.panY + dy });
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId === event.pointerId) event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
          setDragging(false);
        }}
        className={cn(
          'bg-muted/30 relative min-h-0 flex-1 touch-none overflow-hidden',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
      >
        {pane.width > 0 ? (
          <div
            className="absolute top-1/2 left-1/2 rounded-md border bg-white shadow-sm"
            style={{
              width,
              height,
              transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            }}
          >
            {children}
          </div>
        ) : null}

        {/* The zoom controls float over the canvas: they belong to it, not to the page. */}
        <div className="bg-background/90 absolute right-3 bottom-3 flex items-center gap-1 rounded-md border p-1 shadow-sm backdrop-blur">
          <button type="button" className="hover:bg-muted rounded px-2 py-1 text-xs" onClick={() => zoomBy(1 / 1.25)} aria-label="缩小">
            −
          </button>
          <span className="text-muted-foreground w-12 text-center font-mono text-[11px] tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <button type="button" className="hover:bg-muted rounded px-2 py-1 text-xs" onClick={() => zoomBy(1.25)} aria-label="放大">
            +
          </button>
          <button
            type="button"
            className="hover:bg-muted rounded px-2 py-1 text-xs"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            适应
          </button>
          <button
            type="button"
            className="hover:bg-muted rounded px-2 py-1 text-xs"
            onClick={() => {
              setZoom(1 / fit);
              setPan({ x: 0, y: 0 });
            }}
          >
            1:1
          </button>
        </div>
      </div>
      {controls ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2">{controls}</div> : null}
    </div>
  );
}
