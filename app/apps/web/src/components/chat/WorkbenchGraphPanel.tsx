/**
 * Read-only recorded Work/Context graph panel (Dokkabi R4, bounded explorer).
 *
 * One authenticated keyed explore query serves the displayed page; polling
 * runs only while the panel is visible AND mounted (closing the surface or
 * hiding the panel unsubscribes the atom, stopping the 5 s refresh). Pages
 * are bounded (100 nodes / 1536 edges) with page / literal search / one-hop
 * neighbors / Back controls and a pinned snapshot. A failed refresh keeps
 * the same scope's last valid graph rendered and labeled stale; a fresh
 * response that rewinds an independent head or replaces the session never
 * renders as a replacement — the last validated graph stays, carrying an
 * explicit quarantine error. A scope change (thread/instance/type) never
 * inherits data, selection or camera — ChatView keys this panel by scope.
 * Positions are deterministic view preferences from the pure layout module,
 * never execution instructions, so identical recorded input keeps node
 * positions stable across polls.
 */
import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  CrosshairIcon,
  MaximizeIcon,
  MinusIcon,
  NetworkIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderWorkbenchGraph,
  ProviderWorkbenchGraphExplore,
  ThreadId,
  WorkbenchGraphType,
} from "@t3tools/contracts";
import {
  PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
  WORKBENCH_GRAPH_SEARCH_MAX_LENGTH,
} from "@t3tools/contracts";

import { useWorkbenchGraphExplore } from "~/state/workbenchExplorer";
import { workbenchGraphScopeKey } from "~/state/workbenchGraph";
import { usePresentationState } from "~/presentationStore";
import { usePresentationSurfaceRef } from "~/presentationSurfaceHooks";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { sourceRefLabel } from "./WorkbenchContextBar.logic";
import {
  coverageLabel,
  edgeLegend,
  edgeStyleFor,
  nodeKindLabel,
  nodeStatusTone,
} from "./WorkbenchGraphPanel.logic";
import {
  adoptGraphExplorePin,
  backGraphExplore,
  graphExploreSummary,
  graphPageCapacity,
  graphViewOfExplore,
  initialGraphExploreNav,
  navigateGraphExplore,
  neighborsQuery,
  pageQuery,
  refreshGraphExplore,
  resolveGraphExplorePanel,
  searchQuery,
  withGraphOffset,
  type GraphExploreNav,
  type RetainedGraphExplore,
} from "./graphExplorer.logic";
import {
  edgeAnchors,
  edgeLaneAnchor,
  layoutGraph,
  stabilizeLayout,
  type GraphLayoutOptions,
} from "./graphLayout";

const CAMERA_SCALE_MIN = 0.2;
const CAMERA_SCALE_MAX = 3;
const CAMERA_SCALE_STEP = 1.25;
/** Perpendicular spacing between parallel relations sharing endpoints. */
const EDGE_LANE_SPACING = 8;

const clampScale = (scale: number): number =>
  Math.min(CAMERA_SCALE_MAX, Math.max(CAMERA_SCALE_MIN, scale));

/** Resolved runtime geometry: the host-normalized config, or the one shared
 * JSON fallback when no presentation state has arrived yet. No second set of
 * magic defaults lives in the renderer. */
function useGraphLayoutOptions(): GraphLayoutOptions {
  const presentation = usePresentationState();
  return presentation?.config.layout.graph ?? PRESENTATION_GRAPH_LAYOUT_DEFAULTS;
}

function PanelMessage({
  title,
  detail,
  errors,
}: {
  readonly title: string;
  readonly detail?: string | undefined;
  readonly errors?: readonly string[] | undefined;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail ? <p className="max-w-[46ch] text-xs text-muted-foreground">{detail}</p> : null}
      {errors && errors.length > 0 ? (
        <ul className="mt-1 max-w-[52ch] list-disc pl-5 text-left text-xs text-destructive">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function GraphStateChip({ graph }: { readonly graph: ProviderWorkbenchGraph }) {
  const body = graph.graph;
  return (
    <span
      className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs uppercase tracking-wide text-muted-foreground"
      data-graph-state={body.state}
    >
      {body.state}
      {body.mode !== null ? ` · ${body.mode}` : ""}
    </span>
  );
}

/**
 * The recorded graph canvas: SVG edges under HTML node buttons inside one
 * deterministic world. Nodes are buttons (pointer + keyboard selection); the
 * compact tooltip is pure CSS on hover/focus; the camera is a scale plus the
 * container's own scrolling — presentation state only, never graph truth.
 * Parallel relations sharing endpoints get perpendicular lanes so
 * blocked_by/flows never overpaint each other.
 */
function GraphCanvas({
  graph,
  options,
  layoutEpoch,
  scale,
  selectedNodeId,
  onSelectNode,
  canvasRef,
  worldRef,
}: {
  readonly graph: ProviderWorkbenchGraph;
  readonly options: GraphLayoutOptions;
  readonly layoutEpoch: number;
  readonly scale: number;
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (nodeId: string | null) => void;
  readonly canvasRef: React.RefObject<HTMLDivElement | null>;
  readonly worldRef: React.RefObject<HTMLDivElement | null>;
}) {
  // Keep every input that can affect layout order in the key. Display state,
  // labels, evidence and recorded cursors still render from the latest graph.
  const topology = {
    nodes: graph.graph.nodes.map((node) => ({ id: node.id, kind: node.kind })),
    edges: graph.graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    mode: graph.graphType === "work" ? ("work" as const) : ("context" as const),
  };
  const topologyKey = JSON.stringify(topology);
  const signature = JSON.stringify([
    options.direction,
    options.nodeWidth,
    options.nodeHeight,
    options.rankGap,
    options.siblingGap,
    options.canvasPadding,
    layoutEpoch,
  ]);
  // React render state owns the retained layout. A discarded concurrent render
  // cannot update a mutable cache or change the next committed coordinates.
  const [committed, setCommitted] = useState(() => ({
    signature,
    topologyKey,
    layout: layoutGraph(topology, options),
  }));
  let layout = committed.layout;
  if (committed.topologyKey !== topologyKey || committed.signature !== signature) {
    layout = stabilizeLayout({
      fresh: layoutGraph(topology, options),
      previous: committed.layout.positions,
      reset: committed.signature !== signature,
      options,
    });
    setCommitted({ signature, topologyKey, layout });
  }
  // Deterministic traversal order for keyboard selection: rank, then slot.
  const orderedNodeIds = useMemo(
    () =>
      [...graph.graph.nodes]
        .map((node) => ({ id: node.id, position: layout.positions.get(node.id) }))
        .filter(
          (entry): entry is { id: string; position: NonNullable<typeof entry.position> } =>
            entry.position !== undefined,
        )
        .sort(
          (left, right) =>
            left.position.rank - right.position.rank ||
            left.position.order - right.position.order ||
            left.id.localeCompare(right.id),
        )
        .map((entry) => entry.id),
    [graph, layout],
  );
  // Lane assignment: edges sharing an endpoint pair (either direction) get
  // symmetric perpendicular offsets so distinct relations stay distinct.
  const laneAnchors = useMemo(() => {
    const groupOf = new Map<string, { lane: number; count: number }>();
    const groups = new Map<string, number>();
    const keyOf = (from: string, to: string): string =>
      from <= to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
    for (const edge of graph.graph.edges) {
      const key = keyOf(edge.from, edge.to);
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    const anchors = new Map<string, { x1: number; y1: number; x2: number; y2: number }>();
    for (const edge of graph.graph.edges) {
      const key = keyOf(edge.from, edge.to);
      const lane = seen.get(key) ?? 0;
      seen.set(key, lane + 1);
      groupOf.set(edge.id, { lane, count: groups.get(key) ?? 1 });
      const from = layout.positions.get(edge.from);
      const to = layout.positions.get(edge.to);
      if (from === undefined || to === undefined) continue;
      anchors.set(
        edge.id,
        edgeLaneAnchor(
          edgeAnchors(from, to, options),
          lane,
          groups.get(key) ?? 1,
          EDGE_LANE_SPACING,
        ),
      );
    }
    return { anchors, groups };
  }, [graph, layout, options]);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusNode = useCallback((nodeId: string) => {
    nodeRefs.current.get(nodeId)?.focus();
  }, []);
  const handleCanvasClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // Clicking empty canvas (not a node) clears the selection; clicking a
      // node selects it — pointer selection never toggles itself off, because
      // focus already selected the node before the click resolved.
      if ((event.target as HTMLElement).closest("[data-graph-node]") === null) {
        onSelectNode(null);
      }
    },
    [onSelectNode],
  );
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (!forward && !backward) return;
      const current = selectedNodeId === null ? -1 : orderedNodeIds.indexOf(selectedNodeId);
      const nextIndex = forward
        ? Math.min(orderedNodeIds.length - 1, current + 1)
        : Math.max(0, current - 1);
      const nextId = orderedNodeIds[nextIndex];
      if (nextId === undefined || nextId === selectedNodeId) return;
      event.preventDefault();
      onSelectNode(nextId);
      focusNode(nextId);
    },
    [focusNode, onSelectNode, orderedNodeIds, selectedNodeId],
  );

  return (
    <div
      ref={canvasRef}
      tabIndex={0}
      role="group"
      aria-label="Recorded graph canvas"
      className="relative h-full min-h-0 w-full overflow-auto bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
      onKeyDown={handleKeyDown}
      onClick={handleCanvasClick}
      data-graph-canvas="true"
    >
      {/* Sizer keeps the scrollable area equal to the scaled world; the
          world itself carries the camera transform. */}
      <div style={{ width: layout.width * scale, height: layout.height * scale }}>
        <div
          ref={worldRef}
          className="relative"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
          }}
          data-graph-world="true"
        >
          <svg
            className="pointer-events-none absolute inset-0"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
            data-graph-edges="true"
          >
            <defs>
              {(
                [
                  ["edge-contains", "var(--color-muted-foreground)"],
                  ["edge-blocked-by", "var(--color-amber-500)"],
                  ["edge-flows", "var(--color-primary)"],
                  ["edge-context", "var(--color-accent-foreground)"],
                ] as const
              ).map(([id, color]) => (
                <marker
                  key={id}
                  id={id}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 9 5 L 0 9 z" fill={color} fillOpacity="0.7" />
                </marker>
              ))}
            </defs>
            {graph.graph.edges.map((edge) => {
              const anchors = laneAnchors.anchors.get(edge.id);
              if (anchors === undefined) return null;
              const style = edgeStyleFor(edge.kind);
              const markerId =
                edge.kind === "contains"
                  ? "edge-contains"
                  : edge.kind === "blocked_by"
                    ? "edge-blocked-by"
                    : edge.kind === "flows"
                      ? "edge-flows"
                      : "edge-context";
              return (
                <g key={edge.id}>
                  <line
                    x1={anchors.x1}
                    y1={anchors.y1}
                    x2={anchors.x2}
                    y2={anchors.y2}
                    strokeWidth={1.5}
                    strokeDasharray={style.dash ?? undefined}
                    fill="none"
                    className={style.className}
                    markerEnd={`url(#${markerId})`}
                    data-graph-edge={edge.id}
                    data-graph-edge-kind={edge.kind}
                  />
                  {edge.kind === "flows" && edge.artifact !== null ? (
                    <text
                      x={(anchors.x1 + anchors.x2) / 2}
                      y={(anchors.y1 + anchors.y2) / 2 - 4}
                      textAnchor="middle"
                      className="fill-muted-foreground font-mono"
                      fontSize={9}
                      data-graph-edge-artifact={edge.artifact}
                    >
                      {edge.artifact}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          {graph.graph.nodes.map((node) => {
            const position = layout.positions.get(node.id);
            if (position === undefined) return null;
            const selected = selectedNodeId === node.id;
            return (
              // The portaled Tooltip primitive keeps the compact hover AND
              // focus description visible outside the node rectangle and the
              // scrolling canvas — no clipped in-node tooltip.
              <Tooltip key={node.id}>
                <TooltipTrigger
                  render={
                    <button
                      ref={(element) => {
                        if (element === null) nodeRefs.current.delete(node.id);
                        else nodeRefs.current.set(node.id, element);
                      }}
                      type="button"
                      tabIndex={-1}
                      aria-pressed={selected}
                      onClick={() => onSelectNode(node.id)}
                      onFocus={() => onSelectNode(node.id)}
                      className={cn(
                        "group absolute flex flex-col items-start gap-0.5 overflow-hidden rounded-md border bg-card px-2 py-1.5 text-left shadow-sm transition-colors",
                        "hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                        node.provenance === "unresolved"
                          ? "border-dashed border-muted-foreground/60"
                          : "border-border",
                        selected && "border-primary ring-1 ring-primary",
                      )}
                      style={{
                        left: position.x,
                        top: position.y,
                        width: options.nodeWidth,
                        height: options.nodeHeight,
                      }}
                      data-graph-node={node.id}
                      data-graph-node-kind={node.kind}
                      data-graph-node-status={node.status ?? "none"}
                      data-graph-selected={selected ? "true" : "false"}
                    />
                  }
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span className="shrink-0 rounded bg-muted px-1 py-px font-mono text-3xs uppercase tracking-wide text-muted-foreground">
                      {nodeKindLabel(node.kind)}
                    </span>
                    {node.status !== null ? (
                      <span
                        className={cn(
                          "shrink-0 font-mono text-3xs uppercase tracking-wide",
                          nodeStatusTone(node.status),
                        )}
                      >
                        {node.status}
                      </span>
                    ) : null}
                  </span>
                  <span className="line-clamp-2 w-full text-xs leading-snug text-foreground">
                    {node.label}
                  </span>
                </TooltipTrigger>
                <TooltipPopup side="top" className="max-w-64">
                  <span className="text-xs font-medium text-popover-foreground">{node.label}</span>
                  <span className="font-mono text-3xs text-muted-foreground">
                    {nodeKindLabel(node.kind)}
                    {node.status !== null ? ` · ${node.status}` : ""} · {node.provenance}
                  </span>
                  {node.sources[0] !== undefined ? (
                    <span className="font-mono text-3xs text-muted-foreground">
                      {sourceRefLabel(node.sources[0])}
                      {node.sources.length > 1 ? ` +${node.sources.length - 1}` : ""}
                    </span>
                  ) : null}
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GraphLegend({ graph }: { readonly graph: ProviderWorkbenchGraph }) {
  const kinds = edgeLegend(graph.graph.edges.map((edge) => edge.kind));
  if (kinds.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-1.5 text-3xs text-muted-foreground"
      data-graph-legend="true"
    >
      {kinds.map((kind) => {
        const style = edgeStyleFor(kind);
        return (
          <span key={kind} className="flex items-center gap-1" data-graph-legend-kind={kind}>
            <svg width="20" height="6" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="20"
                y2="3"
                strokeWidth={1.5}
                strokeDasharray={style.dash ?? undefined}
                className={style.className}
              />
            </svg>
            {kind}
            {kind === "flows" ? " (artifact)" : ""}
          </span>
        );
      })}
    </div>
  );
}

function GraphInspector({
  graph,
  selectedNodeId,
}: {
  readonly graph: ProviderWorkbenchGraph;
  readonly selectedNodeId: string | null;
}) {
  const node =
    selectedNodeId === null
      ? null
      : (graph.graph.nodes.find((entry) => entry.id === selectedNodeId) ?? null);
  if (node === null) {
    return (
      <p
        className="border-t border-border px-3 py-2 text-xs text-muted-foreground"
        data-graph-inspector="empty"
      >
        Select a node to inspect its recorded evidence, provenance and conditions.
      </p>
    );
  }
  return (
    <div
      className="max-h-56 shrink-0 overflow-y-auto border-t border-border px-3 py-2 text-xs"
      data-graph-inspector={node.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs uppercase tracking-wide text-muted-foreground">
          {nodeKindLabel(node.kind)}
        </span>
        {node.status !== null ? (
          <span
            className={cn("font-mono text-3xs uppercase", nodeStatusTone(node.status))}
            data-graph-inspector-status={node.status}
          >
            {node.status}
          </span>
        ) : null}
        <span className="font-mono text-3xs text-muted-foreground">{node.provenance}</span>
      </div>
      <p className="mt-1 font-mono text-3xs break-all text-muted-foreground">{node.id}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{node.label}</p>
      {node.details.length > 0 ? (
        <dl className="mt-1.5 flex flex-col gap-0.5" data-graph-inspector-details="true">
          {node.details.map((detail) => (
            <div key={`${detail.name}:${detail.value}`} className="flex gap-2">
              <dt className="shrink-0 font-medium text-foreground">{detail.name}</dt>
              <dd className="min-w-0 break-words text-muted-foreground">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {node.bodyDigest !== null ? (
        <p className="mt-1.5 font-mono text-3xs text-muted-foreground">
          body {node.bodyDigest.slice(0, 12)}…
        </p>
      ) : null}
      {node.sources.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-0.5" data-graph-inspector-sources="true">
          {node.sources.map((source) => (
            <li
              key={`${source.seq}:${source.hash}`}
              className="font-mono text-3xs text-muted-foreground"
            >
              {sourceRefLabel(source)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-3xs text-muted-foreground">No recorded source rows.</p>
      )}
      <p
        className="mt-1.5 font-mono text-3xs text-muted-foreground"
        data-graph-inspector-freshness="true"
      >
        session seq {graph.sessionCursor.seq} · revision {graph.graph.revision ?? "Unknown"} ·
        digest {graph.graph.digest?.slice(0, 12) ?? "Unknown"}…
      </p>
    </div>
  );
}

/** Recorded kind/status counts of the full projection (not page counts). */
function GraphCounts({ explore }: { readonly explore: ProviderWorkbenchGraphExplore }) {
  const kinds = Object.entries(explore.counts.byKind).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const statuses = Object.entries(explore.counts.byStatus).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (kinds.length === 0 && statuses.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-1 font-mono text-3xs text-muted-foreground"
      data-graph-counts="true"
    >
      <span className="text-foreground">recorded</span>
      {kinds.map(([kind, count]) => (
        <span key={`kind:${kind}`} data-graph-count-kind={kind}>
          {kind} {count}
        </span>
      ))}
      {statuses.length > 0 ? <span className="text-foreground">status</span> : null}
      {statuses.map(([status, count]) => (
        <span key={`status:${status}`} data-graph-count-status={status}>
          {status} {count}
        </span>
      ))}
    </div>
  );
}

/**
 * The keyed container: explores the thread's recorded graph in bounded
 * pages (page / literal search / one-hop neighbors) through the
 * authenticated per-environment query lifecycle, scoped to the thread's
 * actual provider instance and the closed graph type. At most 100 nodes and
 * 1536 edges are ever displayed; counts of the full projection stay explicit.
 * The first page's snapshot is pinned across navigation; a changed source is
 * an explicit stale banner and needs Refresh before new nodes render.
 * Reading runs only while `visible`; a scope change resets navigation,
 * selection and camera and releases the old scope's reads.
 */
export function WorkbenchGraphPanel({
  environmentId,
  threadId,
  providerInstanceId,
  graphType,
  visible,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly graphType: WorkbenchGraphType;
  readonly visible: boolean;
}) {
  const scope = { environmentId, threadId, graphType, providerInstanceId };
  const scopeKey = workbenchGraphScopeKey(scope);
  const [scoped, setScoped] = useState(() => ({
    scopeKey,
    nav: initialGraphExploreNav(),
    retained: null as RetainedGraphExplore | null,
    selectedNodeId: null as string | null,
    cameraScale: 1,
  }));
  // A different scope never inherits navigation, pin, selection or camera.
  if (scoped.scopeKey !== scopeKey) {
    setScoped({
      scopeKey,
      nav: initialGraphExploreNav(),
      retained: null,
      selectedNodeId: null,
      cameraScale: 1,
    });
  }
  const current = scoped.scopeKey === scopeKey ? scoped : null;
  const nav = current?.nav ?? initialGraphExploreNav();
  const selectedNodeId = current?.selectedNodeId ?? null;
  const cameraScale = current?.cameraScale ?? 1;
  const update = useCallback(
    (mutate: (state: typeof scoped) => typeof scoped) =>
      setScoped((state) => (state.scopeKey === scopeKey ? mutate(state) : state)),
    [scopeKey],
  );
  const request = visible
    ? {
        environmentId,
        threadId,
        ...(providerInstanceId !== undefined ? { providerInstanceId } : {}),
        graphType,
        query: nav.query,
        ...(nav.snapshot !== null ? { snapshot: nav.snapshot } : {}),
      }
    : null;
  const requestKey = JSON.stringify([nav.query, nav.snapshot]);
  const query = useWorkbenchGraphExplore(request);
  const state = resolveGraphExplorePanel({
    scopeKey,
    requestKey,
    graphType,
    nav,
    query,
    retained: current?.retained ?? null,
    subscribed: visible,
  });
  // Retain every fresh page and adopt the first fresh snapshot as the pin
  // (React's adjust-state-during-render pattern; guards make it idempotent).
  if (
    current !== null &&
    state.kind === "view" &&
    state.staleError === null &&
    !state.snapshotStale &&
    !state.navigating &&
    (current.retained?.explore !== state.explore || current.retained.requestKey !== requestKey)
  ) {
    setScoped({
      ...current,
      retained: { scopeKey, requestKey, explore: state.explore },
      nav: adoptGraphExplorePin(current.nav, state.explore.snapshot),
    });
  }
  const setSelectedNodeId = useCallback(
    (nodeId: string | null) => update((state) => ({ ...state, selectedNodeId: nodeId })),
    [update],
  );
  const setCameraScale = useCallback(
    (next: (scale: number) => number) =>
      update((state) => ({ ...state, cameraScale: next(state.cameraScale) })),
    [update],
  );
  const navigate = useCallback(
    (next: (nav: GraphExploreNav) => GraphExploreNav) =>
      update((state) => ({ ...state, nav: next(state.nav) })),
    [update],
  );
  const [searchText, setSearchText] = useState("");
  const [layoutEpoch, bumpLayoutEpoch] = useReducer((epoch: number) => epoch + 1, 0);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = usePresentationSurfaceRef(
    graphType === "work" ? "work-graph" : "context-graph",
  );
  const options = useGraphLayoutOptions();

  const fitCamera = useCallback(() => {
    const canvas = canvasRef.current;
    const world = worldRef.current;
    if (canvas === null || world === null) return;
    const scale = Math.min(
      canvas.clientWidth / Math.max(world.offsetWidth, 1),
      canvas.clientHeight / Math.max(world.offsetHeight, 1),
      1,
    );
    setCameraScale(() => clampScale(scale));
    canvas.scrollTo(0, 0);
  }, [setCameraScale]);
  // No first-arrival auto-fit: a narrow auxiliary panel would shrink a
  // multi-rank graph below readability. The camera starts at scale 1 with
  // scrolling; Fit is an explicit operator action, and polls never move it.

  const explore = state.kind === "view" ? state.explore : null;
  const view = useMemo(() => (explore === null ? null : graphViewOfExplore(explore)), [explore]);
  const body = view?.graph ?? null;
  const panelTitle = graphType === "work" ? "Work graph" : "Context graph";
  const shownQuery = explore?.query ?? nav.query;
  const capacity = graphPageCapacity(shownQuery);
  const interactive = explore !== null && state.kind === "view" && !state.navigating;
  const selectedShown =
    selectedNodeId !== null && (body?.nodes.some((node) => node.id === selectedNodeId) ?? false);
  const searchCandidate = searchQuery(searchText);

  return (
    <div
      ref={surfaceRef}
      className="flex h-full min-h-0 flex-col bg-background"
      data-workbench-graph-panel={graphType}
      data-graph-scope-key={scopeKey}
      data-graph-mode={nav.query.mode}
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
        <NetworkIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs font-medium text-foreground">{panelTitle}</span>
        {view !== null ? <GraphStateChip graph={view} /> : null}
        {state.kind === "view" && state.staleError !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="rounded bg-warning/12 px-1.5 py-0.5 font-medium text-warning-foreground"
                  data-graph-stale="true"
                />
              }
            >
              stale
            </TooltipTrigger>
            <TooltipPopup side="bottom">{state.staleError}</TooltipPopup>
          </Tooltip>
        ) : null}
        <span className="grow" />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom out"
          disabled={cameraScale <= CAMERA_SCALE_MIN}
          onClick={() => setCameraScale((scale) => clampScale(scale / CAMERA_SCALE_STEP))}
        >
          <MinusIcon className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom in"
          disabled={cameraScale >= CAMERA_SCALE_MAX}
          onClick={() => setCameraScale((scale) => clampScale(scale * CAMERA_SCALE_STEP))}
        >
          <PlusIcon className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Fit graph to panel"
          onClick={fitCamera}
          disabled={view === null}
        >
          <MaximizeIcon className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Reflow graph layout"
          disabled={view === null}
          onClick={() => {
            // Selection survives the reflow; only positions and camera move.
            bumpLayoutEpoch();
            requestAnimationFrame(fitCamera);
          }}
        >
          <CrosshairIcon className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh recorded graph"
          data-graph-refresh="true"
          onClick={() => {
            // Explicit: drop the pin so the current projection may render.
            navigate(refreshGraphExplore);
            query.refresh();
          }}
        >
          <RefreshCwIcon className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1">
        <Button
          variant="ghost"
          size="xs"
          data-graph-back="true"
          disabled={nav.history.length === 0}
          onClick={() => navigate(backGraphExplore)}
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
          Back
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-graph-all="true"
          disabled={nav.query.mode === "page" && nav.query.offset === 0}
          onClick={() => navigate((current) => navigateGraphExplore(current, pageQuery(0)))}
        >
          All nodes
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-graph-page-previous="true"
          disabled={!interactive || shownQuery.offset === 0}
          onClick={() =>
            navigate((current) =>
              navigateGraphExplore(
                current,
                withGraphOffset(shownQuery, shownQuery.offset - capacity),
              ),
            )
          }
        >
          Previous
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-graph-page-next="true"
          disabled={!interactive || explore?.nextOffset == null}
          onClick={() => {
            const next = explore?.nextOffset;
            if (next != null) {
              navigate((current) =>
                navigateGraphExplore(current, withGraphOffset(shownQuery, next)),
              );
            }
          }}
        >
          Next
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-graph-neighbors="true"
          disabled={!selectedShown}
          onClick={() => {
            if (selectedNodeId !== null) {
              navigate((current) => navigateGraphExplore(current, neighborsQuery(selectedNodeId)));
            }
          }}
        >
          Neighbors
        </Button>
        <form
          className="ml-auto flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (searchCandidate !== null) {
              navigate((current) => navigateGraphExplore(current, searchCandidate));
            }
          }}
        >
          <input
            className="h-6 w-36 rounded border border-border bg-background px-1.5 text-3xs"
            type="search"
            aria-label="Search recorded nodes (literal text)"
            placeholder="literal search"
            maxLength={WORKBENCH_GRAPH_SEARCH_MAX_LENGTH}
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            data-graph-search-input="true"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            type="submit"
            aria-label="Search"
            data-graph-search-submit="true"
            disabled={searchCandidate === null}
          >
            <SearchIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </form>
      </div>
      {explore !== null ? (
        <p
          className="border-b border-border px-3 py-1 font-mono text-3xs text-muted-foreground"
          data-graph-explore-summary="true"
        >
          {state.kind === "view" && state.navigating ? "Loading… · " : ""}
          {graphExploreSummary(explore)}
        </p>
      ) : null}
      {explore !== null ? <GraphCounts explore={explore} /> : null}
      {(state.kind === "view" && state.snapshotStale) || state.kind === "stale-empty" ? (
        <p
          className="border-b border-border bg-warning/10 px-3 py-1 text-xs text-warning-foreground"
          data-graph-stale-snapshot="true"
        >
          The recorded graph changed since this snapshot. The displayed page is unchanged; Refresh
          to load the current graph.
        </p>
      ) : null}
      {state.kind === "pending" ? (
        <PanelMessage title="Loading recorded graph…" />
      ) : state.kind === "unsupported" ? (
        <PanelMessage title="Bounded graph exploration unsupported" detail={state.reason} />
      ) : state.kind === "unavailable" ? (
        <PanelMessage
          title="Recorded graph unavailable"
          detail={state.reason === "" ? undefined : state.reason}
        />
      ) : state.kind === "stale-empty" ? (
        <PanelMessage
          title="The recorded graph changed"
          detail="Refresh to load the current graph."
        />
      ) : body === null || body.state !== "available" ? (
        <PanelMessage
          title={
            body === null || body.state === "missing"
              ? `No recorded ${graphType} graph yet`
              : body.state === "invalid"
                ? "The recorded graph could not be interpreted"
                : "The recorded graph is unavailable"
          }
          detail={
            body !== null && body.state === "unavailable"
              ? coverageLabel(body.coverage)
              : "An explicit Send records work; the graph appears without further action."
          }
          errors={body?.errors}
        />
      ) : (
        <>
          <div className="min-h-0 flex-1">
            {body.nodes.length === 0 ? (
              <PanelMessage title="No recorded nodes match this view." />
            ) : (
              <GraphCanvas
                graph={view!}
                options={options}
                layoutEpoch={layoutEpoch}
                scale={cameraScale}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
                canvasRef={canvasRef}
                worldRef={worldRef}
              />
            )}
          </div>
          {body.errors.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <p
                    className="border-t border-border px-3 py-1 text-3xs text-muted-foreground"
                    data-graph-errors="true"
                  />
                }
              >
                {body.errors[0]}
                {body.errors.length > 1 ? ` (+${body.errors.length - 1} more)` : ""}
              </TooltipTrigger>
              <TooltipPopup side="top" variant="code">
                {body.errors.join("\n")}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <GraphLegend graph={view!} />
          <GraphInspector graph={view!} selectedNodeId={selectedNodeId} />
        </>
      )}
    </div>
  );
}
