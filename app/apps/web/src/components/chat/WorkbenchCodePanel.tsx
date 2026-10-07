import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkbenchCode } from "@t3tools/contracts";
import {
  codeScopeKey,
  workbenchCodeIndexAtomFor,
  workbenchCodeBodyAtomFor,
  workbenchCodeAction,
  type CodeScope,
} from "~/state/workbenchCode";
import { useEnvironmentQuery } from "~/state/query";
import { usePresentationActive } from "~/state/presentationActivity";
import { Button } from "../ui/button";
import { CodeCanvas } from "./codeEvolution/CodeCanvas";
import {
  decodeCodeMaterial,
  resolveCodeFilePath,
  type CodeMaterial,
} from "./codeEvolution/material";
import {
  initialCodeView,
  acceptCodeIndex,
  selectCodeVersion,
  codeReferenceKey,
} from "./codeEvolution/viewState";
import { cn } from "~/lib/utils";
import { codeObserverLabel } from "./codeEvolution/observerLabel";
import { CodeObserverControls } from "./codeEvolution/CodeObserverControls";
import { useAtomCommand } from "~/state/use-atom-command";

type Descriptor = WorkbenchCode["versions"][number];
function CodeBody({
  scope,
  descriptor,
  visible,
}: {
  scope: CodeScope;
  descriptor: Descriptor;
  visible: boolean;
}) {
  const query = useEnvironmentQuery(
    visible
      ? workbenchCodeBodyAtomFor(scope, {
          ...descriptor.reference.version,
          digest: descriptor.reference.digest,
        })
      : null,
  );
  const [retained, setRetained] = useState<{ key: string; material: CodeMaterial } | null>(null);
  const [camera, setCamera] = useState({ x: -20, y: -20, scale: 1 });
  const [cameraReady, setCameraReady] = useState(false);
  const key = codeReferenceKey(descriptor.reference);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"graph" | "diff" | "source">("graph");
  const [file, setFile] = useState<string | null>(null);
  const resolved = useMemo(() => {
    if (query.error) return { material: null, error: query.error };
    if (!query.data) return { material: null, error: null };
    if (query.data.status !== "available") return { material: null, error: query.data.reason };
    const body = query.data.code.body;
    if (!body || codeReferenceKey(body.reference) !== codeReferenceKey(descriptor.reference))
      return { material: null, error: "Selected Code body does not match its recorded version." };
    try {
      const material = decodeCodeMaterial(body);
      if (material.graphDigest !== descriptor.graphDigest)
        throw new Error("Selected graph digest differs from its index.");
      return { material, error: null };
    } catch (error) {
      return {
        material: null,
        error: error instanceof Error ? error.message : "Invalid Code material.",
      };
    }
  }, [query.data, query.error, descriptor]);
  if (resolved.material && retained?.material !== resolved.material)
    setRetained({ key, material: resolved.material });
  const material = resolved.material ?? (retained?.key === key ? retained.material : null);
  if (!material)
    return (
      <div className="p-4 text-xs text-muted-foreground" role="status">
        {resolved.error ?? "Reading retained Code version…"}
      </div>
    );
  const node = material.graph.nodes.find((n) => n.id === selected);
  const currentPath = resolveCodeFilePath(material, selected, file);
  const currentFile = material.files.find((f) => f.path === currentPath);
  const diff = material.diff.files.find((f) => f.path === currentPath)?.textDiff;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-code-body-digest={descriptor.reference.digest}
    >
      {resolved.error ? (
        <p className="border-b border-border px-3 py-2 text-xs text-destructive" role="alert">
          Stale retained picture · {resolved.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
        {(["graph", "diff", "source"] as const).map((t) => (
          <Button
            key={t}
            variant={tab === t ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
          >
            {t === "graph" ? "Structure" : t === "diff" ? "Changes" : "Sanitized source"}
          </Button>
        ))}
        <select
          aria-label="Recorded file"
          className="ml-auto max-w-56 rounded border border-border bg-background px-2 py-1 text-xs"
          value={currentPath ?? ""}
          onChange={(e) => {
            setFile(e.target.value);
            setSelected(
              material.graph.nodes.find((n) => n.kind === "file" && n.path === e.target.value)
                ?.id ?? null,
            );
          }}
        >
          {material.files.map((f) => (
            <option key={f.path} value={f.path}>
              {f.path} · {f.status}
            </option>
          ))}
        </select>
      </div>
      {tab === "graph" ? (
        <CodeCanvas
          material={material}
          camera={camera}
          autoFit={!cameraReady}
          onInitialize={() => setCameraReady(true)}
          onCamera={setCamera}
          selected={selected}
          onSelect={(id) => {
            setSelected(id);
            const n = material.graph.nodes.find((n) => n.id === id);
            if (n) setFile(n.path);
          }}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3" data-code-view={tab}>
          {tab === "source" ? (
            <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
              {currentFile?.sanitized?.text ??
                `Source unavailable: ${currentFile?.status ?? "No file selected"}`}
            </pre>
          ) : !diff ? (
            <p className="text-xs text-muted-foreground">No selected file diff.</p>
          ) : diff.kind === "summary_only" ? (
            <p className="text-xs text-muted-foreground">
              Line diff omitted: {diff.reason}. {diff.beforeLines} → {diff.afterLines} lines.
            </p>
          ) : (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                {diff.value.identical
                  ? "No sanitized text change"
                  : `+${diff.value.added} −${diff.value.removed}`}{" "}
                ·{" "}
                {material.previous
                  ? `relative to recorded #${material.previous.version.seq}`
                  : "initial selected-path capture"}
              </p>
              {diff.value.hunks.map((h, i) => (
                <div key={i} className="mb-3 overflow-x-auto rounded border border-border">
                  <div className="bg-muted px-2 py-1 font-mono text-3xs text-muted-foreground">
                    @@ −{h.aStart},{h.aLines} +{h.bStart},{h.bLines} @@
                  </div>
                  {h.rows.map((r, j) => (
                    <div
                      key={j}
                      className={cn(
                        "flex whitespace-pre font-mono text-xs leading-5",
                        r.t === "+"
                          ? "bg-success/10 text-success"
                          : r.t === "-"
                            ? "bg-destructive/10 text-destructive"
                            : "text-muted-foreground",
                      )}
                    >
                      <span className="w-10 shrink-0 px-1 text-right">{r.a ?? ""}</span>
                      <span className="w-10 shrink-0 px-1 text-right">{r.b ?? ""}</span>
                      <span className="px-2">
                        {r.t} {r.text}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      )}
      <div
        className="max-h-44 shrink-0 overflow-auto border-t border-border px-3 py-2 text-xs"
        data-code-inspector
      >
        {node ? (
          <>
            <p className="font-medium">
              {node.kind} · {node.name}
            </p>
            <p className="break-all font-mono text-3xs text-muted-foreground">
              {node.path}
              {node.line ? `:${node.line}` : ""}
              {node.signature ? ` · ${node.signature}` : ""}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">Select a node to inspect retained structure.</p>
        )}
        <p className="mt-1 text-3xs text-muted-foreground">
          {material.files.filter((f) => f.status === "parsed").length}/{material.coverage.selected}{" "}
          files parsed · parser {material.identity.parser.name} {material.identity.parser.version} ·
          redaction v{material.identity.redaction.version}
        </p>
        <p className="text-3xs text-muted-foreground">
          Explicit selected paths · per-file capture · sanitized coordinates ·{" "}
          {material.links.length} recorded tool links, no exclusive authorship or task success.
        </p>
        {material.links
          .filter((link) => link.path === currentPath)
          .map((link) => (
            <p
              key={link.receipt.operation}
              className="mt-1 break-all font-mono text-3xs text-muted-foreground"
            >
              Recorded {link.receipt.tool} change · commit #{link.receipt.commit.seq} (
              {link.receipt.commit.hash.slice(0, 8)}) · call #{link.receipt.call.seq}, result #
              {link.receipt.result.seq}
            </p>
          ))}
        {currentFile?.sanitized ? (
          <details className="mt-1 text-3xs">
            <summary className="cursor-pointer text-muted-foreground">Source digests</summary>
            <p className="break-all font-mono">
              Original {currentFile.original?.digest ?? "unavailable"}
              <br />
              Sanitized {currentFile.sanitized.digest}
            </p>
          </details>
        ) : null}
        {material.coverage.outOfScope.length ? (
          <p className="text-3xs text-muted-foreground">
            Outside this capture (not deletions): {material.coverage.outOfScope.join(", ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function WorkbenchCodePanel(props: CodeScope & { readonly visible: boolean }) {
  // The owner key resets retention only; main conversation and composer stay mounted.
  return <ScopedCodePanel key={codeScopeKey(props)} {...props} />;
}
function ScopedCodePanel({ visible, ...scope }: CodeScope & { readonly visible: boolean }) {
  const presentationActive = usePresentationActive();
  const readVisible = visible && presentationActive;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const runAction = useAtomCommand(workbenchCodeAction, { reportFailure: false });
  const [state, setState] = useState(initialCodeView);
  const query = useEnvironmentQuery(
    readVisible && state.error === null ? workbenchCodeIndexAtomFor(scope) : null,
  );
  const [lastResponse, setLastResponse] = useState<WorkbenchCode | null>(null);
  if (query.data?.status === "available" && query.data.code !== lastResponse) {
    const page = query.data.code;
    setLastResponse(page);
    setState((s) => acceptCodeIndex(s, page));
  }
  const error =
    state.error ??
    query.error ??
    (query.data && query.data.status !== "available" ? query.data.reason : null);
  const descriptor = state.index?.versions.find(
    (v) => codeReferenceKey(v.reference) === state.selected,
  );
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      data-workbench-code-scope={codeScopeKey(scope)}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium">Recorded Code</span>
        <span className="text-3xs text-muted-foreground">
          {!readVisible
            ? "Paused retained view"
            : query.isPending
              ? "Revalidating retained view"
              : state.follow
                ? "Live"
                : "Pinned history"}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setState((s) => selectCodeVersion(s, null))}
        >
          Follow latest
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            setLastResponse(null);
            setState((s) => ({ ...s, error: null }));
            query.refresh();
          }}
        >
          Reconnect
        </Button>
        <select
          aria-label="Recorded Code version"
          className="ml-auto max-w-48 rounded border border-border bg-background px-2 py-1 text-xs"
          value={state.selected ?? ""}
          onChange={(e) => setState((s) => selectCodeVersion(s, e.target.value))}
        >
          {(state.index?.versions ?? []).map((v) => (
            <option key={codeReferenceKey(v.reference)} value={codeReferenceKey(v.reference)}>
              #{v.reference.version.seq} · {v.reference.digest.slice(0, 8)}
            </option>
          ))}
        </select>
      </header>
      <p
        className="border-b border-border px-3 py-1.5 text-3xs text-muted-foreground"
        role="status"
      >
        {codeObserverLabel(state.index?.observer)}
      </p>
      <CodeObserverControls
        scopeKey={codeScopeKey(scope)}
        observer={state.index?.observer}
        disabled={!readVisible || query.isPending || error !== null}
        onResume={async (input) => {
          const result = await runAction({
            environmentId: scope.environmentId,
            input: { threadId: scope.threadId, ...input },
          });
          if (result._tag === "Failure")
            throw new Error("Code observer action could not be confirmed");
          if (
            result.value.state === "applied" &&
            result.value.receipt.commandId === input.commandId &&
            mounted.current
          )
            query.refresh();
          return result.value;
        }}
      />
      {error ? (
        <p className="border-b border-border px-3 py-2 text-xs text-destructive" role="alert">
          {state.index ? "Stale recorded index · " : ""}
          {error}
        </p>
      ) : null}
      {descriptor ? (
        <CodeBody scope={scope} descriptor={descriptor} visible={readVisible} />
      ) : (
        <p className="p-4 text-xs text-muted-foreground" role="status">
          {state.index
            ? "No retained Code versions. Viewing does not capture the workspace."
            : (error ?? "Connecting to retained Code records…")}
        </p>
      )}
    </section>
  );
}
