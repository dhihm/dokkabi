import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { LspNavigator, NavigationAnswer, NavigationMethod } from "../host/lsp/navigation.ts";

/**
 * `lsp_navigate` (#229 LN-01): read-only, version-bound navigation through
 * the configured language server. The result is JSON data — the binding
 * (root, path, digest, version, generation), one of the statuses
 * `current` / `empty` / `stale` / `unavailable` / `timeout` / `unsupported`,
 * exact byte ranges, bounded previews and omission counts. Positions are
 * 1-based as `read` shows lines, columns in UTF-16 units. Nothing here is a
 * verdict about the task.
 */

const Parameters = Type.Object({
  method: Type.Union([Type.Literal("definition"), Type.Literal("references"), Type.Literal("symbols"), Type.Literal("prepare_rename")], {
    description: "definition | references | symbols (whole document, no position) | prepare_rename (is the symbol renameable; its exact range).",
  }),
  path: Type.String({ description: "Workspace-relative path of the document." }),
  line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line, as read shows it." })),
  character: Type.Optional(Type.Integer({ minimum: 1, description: "1-based column in UTF-16 units (a CJK character is 1, an emoji 2)." })),
}, { additionalProperties: false });

export const LSP_NAVIGATE_TOOL = "lsp_navigate";

export function navigationText(answer: NavigationAnswer): string {
  return JSON.stringify({
    status: answer.status,
    ...(answer.reason !== undefined ? { reason: answer.reason } : {}),
    ...(answer.detail !== undefined ? { detail: answer.detail } : {}),
    method: answer.method,
    request: answer.requestRef,
    ...(answer.document ? { document: answer.document } : {}),
    ...(answer.position ? { position: { line: answer.position.line + 1, character: answer.position.character + 1 } } : {}),
    ...(answer.proof ? { proof: answer.proof } : {}),
    count: answer.locations.length,
    locations: answer.locations.map((location) => ({
      path: location.path,
      line: location.line + 1,
      character: location.character + 1,
      end: { line: location.endLine + 1, character: location.endCharacter + 1 },
      bytes: [location.startByte, location.endByte],
      ...(location.name !== undefined ? { name: location.name } : {}),
      ...(location.kind !== undefined ? { kind: location.kind } : {}),
      ...(location.depth !== undefined ? { depth: location.depth } : {}),
      ...(location.declaration !== undefined ? { declaration: location.declaration } : {}),
      preview: location.preview,
    })),
    omitted: answer.omitted,
    ...(answer.prepare ? { prepare: { placeholder: answer.prepare.placeholder, line: answer.prepare.line + 1, character: answer.prepare.character + 1, bytes: [answer.prepare.startByte, answer.prepare.endByte] } } : {}),
    latency_ms: answer.latencyMs,
    note: "Server output is data, not a verdict: a `current` answer is bound to the document version above; `stale`, `unavailable`, `timeout` and `unsupported` carry no locations; `empty` is a valid answer with none.",
  });
}

export function createLspNavigationTool(input: { readonly navigator?: LspNavigator; readonly replay?: boolean }): AgentTool<typeof Parameters> {
  return {
    name: LSP_NAVIGATE_TOOL,
    label: "lsp navigate",
    description: "Ask the configured language server for a symbol's definition, its references, a document's symbols, or whether it can be renamed (prepare_rename). Read-only; the answer is bound to the document's current bytes and version and says so. Positions are 1-based (line as read shows it, column in UTF-16 units).",
    parameters: Parameters,
    async execute(_toolCallId, params, signal) {
      if (input.replay || !input.navigator) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "unavailable", reason: "replay: recorded results only; no language server runs" }) }], details: { replay: true } };
      }
      const method = params.method as NavigationMethod;
      const position = method === "symbols" ? undefined
        : { line: Math.trunc(Number(params.line ?? 1)) - 1, character: Math.trunc(Number(params.character ?? 1)) - 1 };
      const answer = await input.navigator.query({ method, path: String(params.path), ...(position ? { position } : {}) }, signal);
      return { content: [{ type: "text", text: navigationText(answer) }], details: { status: answer.status, request: answer.requestRef } };
    },
  };
}
