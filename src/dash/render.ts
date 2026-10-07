import {
  blobGcLines,
  compactionLines,
  maekLine,
  eventLines,
  hostLines,
  knowledgeLine,
  pluginLine,
  remoteLine,
  statusTone,
  toolLines,
  usageBarAscii,
  usageLines,
  workLines,
} from "./cells.ts";
import type { DashProjection } from "./project.ts";
import { speculationDisplay } from "./speculation.ts";

export function renderDashText(
  view: DashProjection,
  meta: { path: string; replay: boolean; url?: string; color?: boolean; sessionLabel?: string },
): string {
  const status = view.work.agentStatus;
  const paint = meta.color === true ? colorize : plain;
  const lines: string[] = [];
  lines.push(
    `${paint("ember", "DOKKABI")}  mode=${meta.replay ? "replay" : "live"}  ${paint(statusTone(status), `status=${status}`)}  q=quit`,
  );
  if (meta.url) {
    lines.push(`http=${meta.url}`);
  }
  lines.push(`session=${view.session === "missing" ? (meta.sessionLabel ?? view.session) : view.session}`);
  lines.push(`log=${meta.path}`);
  if (view.error) {
    lines.push(paint("bad", `error     ${view.error}`));
  }
  lines.push("");
  lines.push(paint("muted", "WORK"));
  for (const line of workLines(view)) {
    lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push(paint("muted", "MODEL"));
  for (const line of usageLines(view)) {
    lines.push(`  ${line}`);
  }
  lines.push(`  ${usageBarAscii(view)}`);
  lines.push(`plugins   ${pluginLine(view)}`);
  lines.push(`wiki      ${knowledgeLine(view)}`);
  if (view.work.executionViews) lines.push(`views     ${view.work.executionViews}`);
  if (view.work.checkerRevisions) lines.push(`checkers  ${view.work.checkerRevisions}`);
  if (view.work.reviewDecision) lines.push(`review    ${view.work.reviewDecision}`);
  if (view.work.initialRegression) lines.push(`regress   ${view.work.initialRegression}`);
  lines.push(`remote    ${remoteLine(view)}`);
  const speculation = speculationDisplay(view.speculation);
  if (speculation) {
    lines.push("");
    lines.push(paint("muted", "SPECULATION"));
    lines.push(`  ${speculation.text}`);
  }
  lines.push("");
  lines.push(paint("muted", "HOST"));
  for (const line of hostLines(view)) {
    lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push(paint("muted", "TOOLS"));
  for (const line of toolLines(view)) {
    lines.push(`  ${line}`);
  }
  lines.push(paint("muted", "COMPACTION"));
  for (const line of compactionLines(view)) {
    lines.push(`  ${line}`);
  }
  lines.push(paint("muted", "BLOB GC"));
  for (const line of blobGcLines(view)) {
    lines.push(`  ${line}`);
  }
  const maek = maekLine(view);
  if (maek) {
    lines.push(paint("muted", "MAEK"));
    lines.push(`  ${maek}`);
  }
  lines.push("");
  lines.push(paint("muted", "EVENTS"));
  for (const line of eventLines(view)) {
    lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("Values come from EventLog only. '-' = not reported.");
  return lines.join("\n");
}

export { renderDashHtml } from "./html.ts";
export { renderDashScreen } from "./board.ts";

function colorize(tone: string, text: string): string {
  const code = tone === "ember" ? "33" : tone === "ok" ? "32" : tone === "bad" ? "31" : "90";
  return `\x1b[${code}m${text}\x1b[0m`;
}

function plain(_tone: string, text: string): string {
  return text;
}
