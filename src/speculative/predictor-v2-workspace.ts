import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodeReviewGraph } from "../graph/providers/code-review.ts";
import { EventLog } from "../host/event-log.ts";
import { compileGitCoEdits } from "./coedit.ts";
import {
	buildLexicalIndex,
	type LexicalDocument,
	LexicalIndexBoundError,
	MAX_LEXICAL_DOCUMENTS,
} from "./lexical.ts";
import type { PredictorTrainingSnapshot } from "./predictor-v2-compiler.ts";
import type { PredictorTopologyEdge } from "./predictor-v2-schema.ts";

export function snapshotPredictorWorkspace(
	workspaceRoot: string,
): PredictorTrainingSnapshot {
	const temporary = mkdtempSync(join(tmpdir(), "dokkabi-predictor-snapshot-"));
	try {
		const log = EventLog.create(join(temporary, "graph.jsonl"));
		const graph = buildCodeReviewGraph(log, workspaceRoot);
		const fileIds = new Set(
			graph.nodes
				.filter((node) => node.kind === "file" || node.kind === "test")
				.map((node) => node.id),
		);
		const symbolFiles = new Map<string, string>();
		for (const edge of graph.edges) {
			if (edge.kind === "observed_at" && fileIds.has(edge.to))
				symbolFiles.set(edge.from, edge.to);
		}
		const symbols = new Map<string, string[]>();
		for (const [symbol, file] of symbolFiles) {
			const values = symbols.get(file) ?? [];
			values.push(symbol.startsWith("sym:") ? symbol.slice(4) : symbol);
			symbols.set(file, values);
		}
		const candidates = [...fileIds]
			.sort(compareText)
			.slice(0, MAX_LEXICAL_DOCUMENTS)
			.map((path) => ({
				path,
				symbols: [...new Set(symbols.get(path) ?? [])]
					.sort(compareText)
					.slice(0, 128),
			}));
		let lexicalDocuments: readonly LexicalDocument[] = [];
		for (const document of candidates) {
			const next = [...lexicalDocuments, document];
			try {
				buildLexicalIndex(next);
				lexicalDocuments = next;
			} catch (error) {
				if (!(error instanceof LexicalIndexBoundError)) throw error;
			}
		}
		const topology: PredictorTopologyEdge[] = [];
		for (const edge of graph.edges) {
			if (
				edge.kind === "imports" &&
				fileIds.has(edge.from) &&
				fileIds.has(edge.to)
			) {
				topology.push({ from: edge.from, to: edge.to, relation: "imports" });
			}
			if (edge.kind === "tested_by") {
				const source = symbolFiles.get(edge.from);
				if (source && fileIds.has(edge.to))
					topology.push({ from: source, to: edge.to, relation: "tested_by" });
			}
			if (
				edge.kind === "calls" &&
				fileIds.has(edge.from) &&
				fileIds.has(edge.to)
			) {
				topology.push({ from: edge.from, to: edge.to, relation: "calls" });
			}
			if (topology.length === 2048) break;
		}
		return {
			topology,
			lexicalDocuments,
			coEdits: compileGitCoEdits(workspaceRoot),
		};
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
