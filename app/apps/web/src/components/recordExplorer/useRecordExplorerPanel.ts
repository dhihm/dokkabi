import type { RecordCompanionViewPreferences } from "@t3tools/contracts";

import {
  useWorkbenchRecordBodyWindow,
  useWorkbenchRecordIndex,
  useWorkbenchRecordVerification,
  type WorkbenchExplorerSource,
} from "~/state/workbenchExplorer";
import type { DecisionRecordPanelState } from "../chat/DecisionRecordSurface.logic";
import {
  RECORD_INDEX_PAGE_LIMIT,
  recordIndexScopeKey,
  recordSelectionBinding,
  resolveRecordBodyWindowState,
  resolveRecordExplorerIndex,
  resolveRecordVerificationState,
  sameSelectionBinding,
  type RecordVerificationIntent,
  type RetainedRecordIndex,
} from "./recordExplorer.logic";

/**
 * The owner's bounded record reader for one scope: the metadata page query,
 * the selected row's single window read and the explicit proof read. Each
 * read subscribes only while `subscribed` (observed and visible, or a live
 * companion); releasing demand interrupts an in-flight read. Selection,
 * window or page changes key a different read, so the obsolete one is
 * released rather than queued. Nothing here sends a write, binds a writer or
 * touches the conversation.
 */
export function useRecordExplorerPanel(input: {
  readonly source: WorkbenchExplorerSource;
  readonly view: RecordCompanionViewPreferences;
  readonly retainedIndex: RetainedRecordIndex | null;
  readonly verifyIntent: RecordVerificationIntent | null;
  readonly subscribed: boolean;
  /** Host-reported: this scope's ready companion is the active presentation. */
  readonly companionActive: boolean;
}): {
  readonly panel: DecisionRecordPanelState;
  readonly pageScopeKey: string;
  /** The page to retain after this resolution (fresh validated only). */
  readonly retain: RetainedRecordIndex | null;
} {
  const { view, subscribed } = input;
  const source = { ...input.source, companionActive: input.companionActive };
  const after = view.after ?? undefined;
  const asOf = view.pin ?? undefined;
  const pageScopeKey = recordIndexScopeKey({
    environmentId: input.source.environmentId,
    threadId: input.source.threadId,
    providerInstanceId: input.source.providerInstanceId ?? null,
    after,
    limit: RECORD_INDEX_PAGE_LIMIT,
  });
  const indexQuery = useWorkbenchRecordIndex(
    subscribed
      ? {
          ...source,
          ...(after !== undefined ? { after } : {}),
          ...(asOf !== undefined ? { asOf } : {}),
          limit: RECORD_INDEX_PAGE_LIMIT,
        }
      : null,
  );
  const indexState = resolveRecordExplorerIndex({
    scopeKey: pageScopeKey,
    query: indexQuery,
    retained: input.retainedIndex,
    subscribed,
    after,
    asOf,
    limit: RECORD_INDEX_PAGE_LIMIT,
  });
  const index = indexState.kind === "index" ? indexState.index : null;
  const binding = recordSelectionBinding(index, view);
  const start = view.bodyStart ?? 0;
  const bodyQuery = useWorkbenchRecordBodyWindow(
    subscribed && binding !== null ? { ...source, ...binding, start } : null,
  );
  const intent =
    input.verifyIntent !== null && sameSelectionBinding(input.verifyIntent, binding)
      ? input.verifyIntent
      : null;
  const verifyQuery = useWorkbenchRecordVerification(
    subscribed && intent !== null ? { ...source, ...intent } : null,
  );
  if (indexState.kind !== "index") return { panel: indexState, pageScopeKey, retain: null };
  return {
    pageScopeKey,
    retain:
      indexState.staleError === null
        ? { scopeKey: pageScopeKey, pinned: asOf !== undefined, index: indexState.index }
        : null,
    panel: {
      kind: "explorer",
      index: indexState.index,
      staleError: indexState.staleError,
      body: resolveRecordBodyWindowState({ binding, start, query: bodyQuery }),
      verification: resolveRecordVerificationState({ binding, intent, query: verifyQuery }),
    },
  };
}
