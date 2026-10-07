/**
 * Settings → Appearance → Presentation: the operator entry point for the
 * runtime presentation override. Shows the operator file location, the
 * applied revision/status and the last error with its pointer; edits the
 * override JSON with revision CAS, reload and reset. Raw files need no
 * build; nothing here touches sessions, auth or provider state.
 *
 * Save is bound to the revision the editor draft was loaded from: an
 * external push never rebases a dirty draft, a conflict preserves both the
 * draft and the disk content, and Reload keeps unsaved editor text (with a
 * visible note) rather than discarding it. Every operation receipt — save,
 * reload, reset — is applied through the store's one validated monotonic
 * path, and connection failures surface here with an explicit retry.
 */
import { PRESENTATION_TOKEN_PROPERTY_PATHS } from "@t3tools/contracts";
import type { PresentationLayoutSnapshot } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../ui/button";
import { usePresentationConnectionError, usePresentationState } from "../../presentationStore";
import { applyValidatedPresentationState } from "../../presentationStore";
import { collectLayoutSnapshot } from "../../presentationLayoutSnapshot";
import { retryPresentationConnection } from "../../presentationBoot";
import { SettingsSection } from "./settingsLayout";

const EMPTY_OVERRIDE_DOCUMENT = `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`;

type Feedback =
  | { readonly kind: "applied"; readonly message: string }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "uncertain"; readonly message: string }
  | null;

function describeIssue(issue: {
  readonly kind: string;
  readonly message: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly column: number | null;
}): string {
  const at =
    issue.path !== null
      ? ` at ${issue.path}`
      : issue.line !== null
        ? ` at line ${issue.line}${issue.column !== null ? `, column ${issue.column}` : ""}`
        : "";
  return `${issue.kind}${at}: ${issue.message}`;
}

export function PresentationSettings() {
  const state = usePresentationState();
  const connectionError = usePresentationConnectionError();
  const presentation =
    typeof window === "undefined" ? undefined : window.desktopBridge?.presentation;
  const [editorDocument, setEditorDocument] = useState<string>("");
  const [editorBaseRevision, setEditorBaseRevision] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [snapshot, setSnapshot] = useState<PresentationLayoutSnapshot | null>(null);
  // Latest editor text, readable from async receipts: text that arrived while
  // a write was pending must never be clobbered by that write's receipt.
  const editorDocumentRef = useRef("");

  // The editor follows the applied document while it is not dirty; the base
  // revision records what the editor currently contains, so a save is always
  // bound to the revision its text was loaded from.
  useEffect(() => {
    if (state !== null && !dirty) {
      setEditorDocument(state.overrideDocument ?? EMPTY_OVERRIDE_DOCUMENT);
      setEditorBaseRevision(state.revision);
    }
  }, [state, dirty]);

  useEffect(() => {
    editorDocumentRef.current = editorDocument;
  }, [editorDocument]);

  const save = useCallback(async () => {
    if (presentation === undefined) return;
    // The revision at which this draft was loaded — never the latest push:
    // rebasing a dirty draft onto newer content would silently overwrite it.
    const expectedRevision = editorBaseRevision;
    if (expectedRevision === null) return;
    const sentDocument = editorDocumentRef.current;
    setPending(true);
    setFeedback(null);
    try {
      const result = await presentation.save({
        expectedRevision,
        document: sentDocument,
      });
      applyValidatedPresentationState(result.state);
      switch (result.type) {
        case "applied":
        case "uncertain": {
          // Text typed while the write was pending survives: the editor only
          // stops being dirty when it still holds exactly what was sent.
          // Racing text builds on the revision this save just applied, so its
          // base advances to the receipt's revision instead of conflicting
          // with the operator's own successful write.
          const raced = editorDocumentRef.current !== sentDocument;
          setDirty(raced);
          if (raced) {
            setEditorBaseRevision(result.state.revision);
          }
          setFeedback({
            kind: result.type,
            message:
              result.type === "applied"
                ? `Applied revision ${result.state.revision}.`
                : result.message,
          });
          break;
        }
        case "invalid":
          setFeedback({
            kind: "invalid",
            message: result.issues.map(describeIssue).join("\n"),
          });
          break;
        case "conflict":
          // The draft and the external content both survive; the operator
          // decides what to reload or discard.
          setFeedback({
            kind: "conflict",
            message: `${result.message}\nThe editor keeps your unsaved text; it is still based on revision ${expectedRevision}.`,
          });
          break;
        case "error":
          setFeedback({ kind: "error", message: result.message });
          break;
      }
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  }, [presentation, editorBaseRevision]);

  const reload = useCallback(async () => {
    if (presentation === undefined) return;
    setPending(true);
    setFeedback(null);
    try {
      const reloaded = await presentation.reload();
      // The reload receipt flows through the same validated monotonic path.
      applyValidatedPresentationState(reloaded);
      if (dirty) {
        // Defined reload behavior: unsaved editor text is preserved, never
        // silently discarded; the draft's base revision is unchanged too.
        setFeedback({
          kind: "conflict",
          message: `Reloaded revision ${reloaded.revision}. The editor keeps your unsaved changes; Save still uses their base revision ${editorBaseRevision ?? "unknown"}. Use "Discard draft and load current" to adopt the newer content.`,
        });
      }
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  }, [presentation, dirty, editorBaseRevision]);

  const reset = useCallback(async () => {
    if (presentation === undefined) return;
    const textAtStart = editorDocumentRef.current;
    setPending(true);
    setFeedback(null);
    try {
      const result = await presentation.reset();
      applyValidatedPresentationState(result.state);
      if (result.type === "applied") {
        // Text typed while the reset was pending survives the same way.
        setDirty(editorDocumentRef.current !== textAtStart);
        setFeedback({ kind: "applied", message: "Presentation override removed." });
      } else {
        setFeedback({ kind: result.type, message: result.message });
      }
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  }, [presentation]);

  /**
   * Explicit operator intent only: adopt the currently applied content into
   * the editor, discarding unsaved draft text and rebasing the editor onto
   * the applied revision. Never writes the override, never touches sessions.
   */
  const discardDraftAndLoadCurrent = useCallback(() => {
    if (state === null) return;
    setEditorDocument(state.overrideDocument ?? EMPTY_OVERRIDE_DOCUMENT);
    editorDocumentRef.current = state.overrideDocument ?? EMPTY_OVERRIDE_DOCUMENT;
    setEditorBaseRevision(state.revision);
    setDirty(false);
    setFeedback({ kind: "applied", message: `Editor loaded revision ${state.revision}.` });
  }, [state]);

  const retryConnection = useCallback(async () => {
    setPending(true);
    try {
      await retryPresentationConnection();
    } finally {
      setPending(false);
    }
  }, []);

  const captureSnapshot = useCallback(() => {
    setSnapshot(collectLayoutSnapshot());
  }, []);

  const supportedScope = useMemo(() => PRESENTATION_TOKEN_PROPERTY_PATHS.join(", "), []);

  if (
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    presentation === undefined
  ) {
    return (
      <SettingsSection id="appearance-presentation" title="Presentation">
        <p className="px-3 py-3 text-xs leading-relaxed text-muted-foreground sm:px-4">
          This build does not expose the presentation host. Restart the desktop app after updating
          to edit presentation overrides.
        </p>
      </SettingsSection>
    );
  }

  if (presentation === undefined) {
    return (
      <SettingsSection id="appearance-presentation" title="Presentation">
        <p className="px-3 py-3 text-xs leading-relaxed text-muted-foreground sm:px-4">
          Presentation overrides are available in the desktop app. The same JSON file (
          <code>~/.dokkabi/desktop/presentation.json</code>) applies at startup.
        </p>
      </SettingsSection>
    );
  }

  const statusLabel =
    state === null
      ? "unavailable"
      : state.status === "applied"
        ? `applied (revision ${state.revision})`
        : state.status === "defaults"
          ? `defaults (revision ${state.revision})`
          : state.error?.kind === "io"
            ? // The file itself was never parsed: reading it failed.
              `source I/O error — last-valid kept (revision ${state.revision})`
            : `invalid file — last-valid kept (revision ${state.revision})`;

  return (
    <SettingsSection id="appearance-presentation" title="Presentation">
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <dl className="grid gap-1 text-xs text-muted-foreground">
          <div className="flex gap-2">
            <dt className="w-20 shrink-0">File</dt>
            <dd className="min-w-0 break-all font-mono">{state === null ? "—" : state.location}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0">Status</dt>
            <dd>{statusLabel}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0">Digest</dt>
            <dd className="min-w-0 break-all font-mono">
              {state === null ? "—" : state.digest.slice(0, 16)}
            </dd>
          </div>
        </dl>

        {state?.error !== null && state?.error !== undefined ? (
          <p
            role="alert"
            className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-warning"
          >
            {describeIssue(state.error)}
          </p>
        ) : null}

        {connectionError !== null ? (
          <div
            role="alert"
            className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
          >
            <p className="whitespace-pre-wrap">{connectionError}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={pending}
              onClick={() => void retryConnection()}
            >
              Retry connection
            </Button>
          </div>
        ) : null}

        <textarea
          aria-label="Presentation override JSON"
          className="h-56 w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground"
          spellCheck={false}
          value={editorDocument}
          // Writes lock the editor so a receipt cannot race text typed during
          // a pending save/reset; the edit-generation guard covers the rest.
          readOnly={pending}
          onChange={(event) => {
            const text = event.currentTarget.value;
            editorDocumentRef.current = text;
            setEditorDocument(text);
            setDirty(true);
          }}
        />

        {feedback !== null ? (
          <p
            role="status"
            className={`whitespace-pre-wrap rounded-md border px-3 py-2 text-xs ${
              feedback.kind === "applied"
                ? "border-border bg-muted/30 text-muted-foreground"
                : "border-warning/40 bg-warning/10 text-warning"
            }`}
          >
            {feedback.message}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={pending || dirty === false} onClick={() => void save()}>
            Save
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void reload()}>
            Reload
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void reset()}>
            Reset override
          </Button>
          {dirty ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending || state === null}
              onClick={discardDraftAndLoadCurrent}
            >
              Discard draft and load current
            </Button>
          ) : null}
          {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={captureSnapshot}>
            Capture layout snapshot
          </Button>
        </div>
        {snapshot === null ? (
          <p className="text-xs text-muted-foreground">
            No snapshot captured yet. A capture measures the registered surfaces of this window.
          </p>
        ) : (
          <pre
            data-presentation-snapshot="true"
            className="max-h-72 overflow-auto rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-2xs text-muted-foreground"
          >
            {JSON.stringify(snapshot, null, 2)}
          </pre>
        )}

        <p className="text-xs leading-relaxed text-muted-foreground">
          Supported token properties: {supportedScope}. Layout supports the main window, navigation,
          conversation and right-panel constraints plus the inline breakpoint. Unknown fields are
          rejected.
        </p>
      </div>
    </SettingsSection>
  );
}
