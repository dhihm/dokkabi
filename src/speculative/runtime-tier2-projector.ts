import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	SpeculationServiceError,
	type SpeculationProjection,
	type SpeculationService,
} from "./service.ts";
import type { Tier2RuntimeOptions } from "./runtime-tier2-types.ts";

export interface Tier2Projector {
	project(
		input: Parameters<SpeculationService["project"]>[0],
	): SpeculationProjection;
	invalidate(): void;
	revision(): number;
}

export function createTier2Projector(input: {
	readonly enabled: boolean;
	readonly options: Tier2RuntimeOptions;
	readonly testTool?: AgentTool;
	readonly execute: (tool: AgentTool) => AgentTool["execute"];
	readonly clearCandidates: () => void;
	readonly disposed: () => boolean;
}): Tier2Projector {
	let wrappers = new WeakMap<AgentTool, AgentTool>();
	let available: readonly AgentTool[] | undefined;
	let projected: readonly AgentTool[] | undefined;
	let revision = 0;
	const invalidate = (): void => {
		wrappers = new WeakMap();
		revision += 1;
	};
	return {
		project(profile) {
			if (input.disposed()) throw new SpeculationServiceError();
			if (!input.enabled) return { revision, tools: profile.projected };
			if (
				available &&
				(!sameTools(available, profile.available) ||
					!projected ||
					!sameTools(projected, profile.projected))
			) {
				input.clearCandidates();
				invalidate();
			}
			available = [...profile.available];
			projected = [...profile.projected];
			const mutation = input.options.createMutationAuthority(
				profile.available,
				profile.projected,
			);
			const bash = input.options.createBashResultAuthority?.(
				profile.available,
				profile.projected,
			);
			const bindingRevision = revision;
			return {
				revision,
				tools: profile.projected.map((tool) => {
					const existing = wrappers.get(tool);
					if (existing) return existing;
					const execute = input.execute(tool);
					const terminal: AgentTool["execute"] = (...args) =>
						bindingRevision === revision
							? execute(...args)
							: tool.execute(...args);
					const wrapped =
						tool.name === "edit" || tool.name === "write"
							? mutation?.project(tool, terminal)
							: tool === input.testTool
								? bash?.project(tool, terminal)
								: undefined;
					if (wrapped) wrappers.set(tool, wrapped);
					return wrapped ?? tool;
				}),
			};
		},
		invalidate,
		revision: () => revision,
	};
}

function sameTools(
	left: readonly AgentTool[],
	right: readonly AgentTool[],
): boolean {
	return (
		left.length === right.length &&
		left.every((tool, index) => tool === right[index])
	);
}
