import { useState } from "react";
import type { CodeScope } from "~/state/workbenchCode";
import { WorkbenchGraphPanel } from "./WorkbenchGraphPanel";
import { WorkbenchCodePanel } from "./WorkbenchCodePanel";
import { cn } from "~/lib/utils";
type AuxiliaryKind = "work-graph" | "context-graph" | "code";
const isAuxiliary = (kind: string | null): kind is AuxiliaryKind =>
  kind === "work-graph" || kind === "context-graph" || kind === "code";

/** Visited pictures retain camera and selection while their visible readers
 * stop. The parent keys the entire group by environment/thread/instance. */
export function WorkbenchAuxiliaryPanels({
  activeKind,
  visible,
  ...scope
}: CodeScope & {
  readonly activeKind: string | null;
  readonly visible: boolean;
}) {
  const [visited, setVisited] = useState<readonly AuxiliaryKind[]>([]);
  const kinds =
    isAuxiliary(activeKind) && !visited.includes(activeKind) ? [...visited, activeKind] : visited;
  if (kinds !== visited) setVisited(kinds);
  return (
    <div className={cn("h-full min-h-0", !isAuxiliary(activeKind) && "hidden")}>
      {kinds.map((kind) => (
        <div
          key={kind}
          className={cn("h-full min-h-0", activeKind !== kind && "hidden")}
          aria-hidden={activeKind !== kind}
        >
          {kind === "code" ? (
            <WorkbenchCodePanel {...scope} visible={visible && activeKind === kind} />
          ) : (
            <WorkbenchGraphPanel
              {...scope}
              graphType={kind === "work-graph" ? "work" : "context"}
              visible={visible && activeKind === kind}
            />
          )}
        </div>
      ))}
    </div>
  );
}
