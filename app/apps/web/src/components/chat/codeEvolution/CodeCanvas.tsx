import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { frameCamera } from "./frameCamera";
import type { CodeMaterial, CodeNode } from "./material";
import { usePresentationState } from "~/presentationStore";
import { PRESENTATION_GRAPH_LAYOUT_DEFAULTS } from "@t3tools/contracts";
import { Button } from "../../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../../ui/tooltip";

/** Retained layout coordinates are presentation input, never live source
 * offsets. SVG clipping culls offscreen nodes and edges, with no animation loop. */
export function CodeCanvas({
  material,
  selected,
  onSelect,
  camera,
  onCamera: setCamera,
  autoFit,
  onInitialize,
}: {
  readonly material: CodeMaterial;
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
  readonly camera: { x: number; y: number; scale: number };
  readonly autoFit: boolean;
  readonly onInitialize: () => void;
  readonly onCamera: React.Dispatch<React.SetStateAction<{ x: number; y: number; scale: number }>>;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const drag = useRef<{
    x: number;
    y: number;
    pointerId: number;
    target: HTMLDivElement;
    camera: typeof camera;
    last: typeof camera;
  } | null>(null);
  const [updates] = useState(() =>
    frameCamera<typeof camera>((value) => {
      if (drag.current) drag.current.last = value;
      committed.current.setCamera(value);
    }),
  );
  const committed = useRef({ camera, material, setCamera, onSelect });
  const finishDrag = (flush: boolean) => {
    if (flush) updates.flush();
    else updates.cancel();
    const active = drag.current;
    drag.current = null;
    if (active?.target.hasPointerCapture?.(active.pointerId)) {
      active.target.releasePointerCapture(active.pointerId);
    }
  };
  useLayoutEffect(() => {
    const previous = committed.current;
    const active = drag.current;
    const changed =
      previous.camera.x !== camera.x ||
      previous.camera.y !== camera.y ||
      previous.camera.scale !== camera.scale;
    if (
      previous.material !== material ||
      (active &&
        changed &&
        (active.last.x !== camera.x ||
          active.last.y !== camera.y ||
          active.last.scale !== camera.scale))
    ) {
      finishDrag(false);
    }
    committed.current = { camera, material, setCamera, onSelect };
  });
  useLayoutEffect(() => () => finishDrag(false), []);
  const selectNode = useCallback((id: string) => committed.current.onSelect(id), []);
  const panTo = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    updates.queue({
      ...start.camera,
      x: start.camera.x - (event.clientX - start.x) / start.camera.scale,
      y: start.camera.y - (event.clientY - start.y) / start.camera.scale,
    });
  };
  const presentation = usePresentationState();
  const geometry = presentation?.config.layout.graph ?? PRESENTATION_GRAPH_LAYOUT_DEFAULTS;
  const sx = geometry.nodeWidth / 240,
    sy = geometry.nodeHeight / 76;
  const nodes = useMemo(
    () =>
      material.graph.nodes.map((n) => ({
        ...n,
        x: n.x * sx,
        y: n.y * sy,
        w: n.w * sx,
        h: n.h * sy,
      })),
    [material, sx, sy],
  );
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const edges = useMemo(
    () =>
      material.graph.edges.flatMap((edge) => {
        const a = byId.get(edge.source),
          b = byId.get(edge.target);
        return a && b
          ? [
              {
                ...edge,
                path: `M ${a.x + a.w} ${a.y + 24} C ${a.x + a.w + 40} ${a.y + 24},${b.x - 40} ${b.y + 24},${b.x} ${b.y + 24}`,
              },
            ]
          : [];
      }),
    [material, byId],
  );
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new ResizeObserver((entries) => {
      const bounds = entries[0]?.contentRect;
      if (bounds) setViewport({ width: bounds.width, height: bounds.height });
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  const fit = (node?: CodeNode) => {
    const rects = node ? [node] : nodes;
    if (!rects.length) return;
    const x = Math.min(...rects.map((n) => n.x)),
      y = Math.min(...rects.map((n) => n.y));
    const w = Math.max(...rects.map((n) => n.x + n.w)) - x,
      h = Math.max(...rects.map((n) => n.y + n.h)) - y;
    const scale = Math.min(
      3,
      Math.max(0.1, Math.min((viewport.width - 40) / w, (viewport.height - 40) / h)),
    );
    finishDrag(false);
    setCamera({ x: x - 20 / scale, y: y - 20 / scale, scale });
  };
  useEffect(() => {
    if (autoFit && viewport.width > 0 && viewport.height > 0 && nodes.length) {
      fit();
      onInitialize();
    }
  }, [autoFit, viewport.width, viewport.height, nodes]);
  const visible = nodes.filter(
    (n) =>
      n.x + n.w >= camera.x &&
      n.y + n.h >= camera.y &&
      n.x <= camera.x + viewport.width / camera.scale &&
      n.y <= camera.y + viewport.height / camera.scale,
  );
  const shown = new Set(visible.map((n) => n.id));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <Button variant="ghost" size="xs" onClick={() => fit()}>
          Fit graph
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!selected}
          onClick={() => {
            if (selected) fit(byId.get(selected));
          }}
        >
          Focus node
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            finishDrag(false);
            setCamera((c) => ({ ...c, scale: Math.min(3, c.scale * 1.25) }));
          }}
          aria-label="Zoom in"
        >
          +
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            finishDrag(false);
            setCamera((c) => ({ ...c, scale: Math.max(0.1, c.scale / 1.25) }));
          }}
          aria-label="Zoom out"
        >
          −
        </Button>
        <span className="ml-auto text-3xs text-muted-foreground">
          {Math.round(camera.scale * 100)}% · drag to pan
        </span>
      </div>
      <div
        ref={element}
        className="relative min-h-48 flex-1 overflow-hidden bg-background"
        data-code-canvas
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as Element).closest("[data-code-node]")) return;
          finishDrag(true);
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            pointerId: event.pointerId,
            target: event.currentTarget,
            camera,
            last: camera,
          };
        }}
        onPointerMove={panTo}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          panTo(event);
          finishDrag(true);
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointerId === event.pointerId) finishDrag(true);
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.pointerId === event.pointerId) finishDrag(true);
        }}
      >
        <svg width="100%" height="100%" aria-label="Recorded code structure" role="group">
          <g transform={`scale(${camera.scale}) translate(${-camera.x} ${-camera.y})`}>
            {edges
              .filter((e) => shown.has(e.source) || shown.has(e.target))
              .map((e) => (
                <path
                  key={e.id}
                  d={e.path}
                  stroke="var(--color-primary)"
                  opacity="0.45"
                  fill="none"
                  strokeWidth="1.5"
                />
              ))}
            {[...visible]
              .sort((a, b) => (a.kind === "module" ? -1 : 0) - (b.kind === "module" ? -1 : 0))
              .map((n) => (
                <CodeCanvasNode
                  key={n.id}
                  n={n}
                  selected={selected === n.id}
                  onSelect={selectNode}
                />
              ))}
          </g>
        </svg>
      </div>
      <p className="border-t border-border px-3 py-1.5 text-3xs text-muted-foreground">
        {nodes.length} recorded nodes · {material.graph.edges.length} syntactic import edges · no
        type-checked call graph
      </p>
    </div>
  );
}

const CodeCanvasNode = memo(function CodeCanvasNode({
  n,
  selected,
  onSelect,
}: {
  readonly n: CodeNode;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <g
            role="button"
            tabIndex={0}
            aria-label={`${n.kind}: ${n.name}`}
            aria-pressed={selected}
            onClick={() => onSelect(n.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(n.id);
              }
            }}
            className="cursor-pointer"
            data-code-node={n.id}
            data-code-selected={selected ? "true" : "false"}
          />
        }
      >
        <rect
          x={n.x}
          y={n.y}
          width={n.w}
          height={n.h}
          rx={n.kind === "module" ? 8 : 4}
          fill={n.kind === "module" ? "var(--color-muted)" : "var(--color-card)"}
          fillOpacity={n.kind === "module" ? 0.4 : 1}
          stroke={selected ? "var(--color-primary)" : "var(--color-border)"}
          strokeWidth={selected ? 2 : 1}
        />
        <text
          x={n.x + 8}
          y={n.y + Math.min(18, n.h - 3)}
          fill="var(--color-foreground)"
          fontSize={n.kind === "module" ? 12 : Math.min(11, n.h - 3)}
          fontFamily="var(--font-mono)"
        >
          {n.name.slice(0, Math.max(8, Math.floor(n.w / 7) - 2))}
        </text>
        {n.kind === "file" ? (
          <text x={n.x + 8} y={n.y + 36} fill="var(--color-muted-foreground)" fontSize="9">
            {n.diagnosticCount ?? 0} diagnostics
          </text>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup>
        {n.kind} · {n.path}
        {n.line ? `:${n.line}` : ""}
        <br />
        {n.signature ?? n.name}
      </TooltipPopup>
    </Tooltip>
  );
});
