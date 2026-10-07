import { z } from "zod";

const RuntimeArtifactsSchema = z.strictObject({
	paths: z.array(z.string()),
	digest: z.string(),
});

const WorktreeSnapshotSchema = z.strictObject({
	sourceRoot: z.string(),
	head: z.string(),
	tree: z.string(),
	commit: z.string(),
	digest: z.string(),
	runtimeArtifacts: RuntimeArtifactsSchema,
	captureRuntimeArtifacts: z.boolean().optional(),
	transientObjectDirectory: z.string().optional(),
	transientObjectRoot: z.string().optional(),
});

const WorktreeDeltaSchema = z.strictObject({
	patch: z.string(),
	patchDigest: z.string(),
	finalTree: z.string(),
});

export const CowWorkerRequestSchema = z.strictObject({
	sourceRoot: z.string(),
	candidateId: z.string(),
	tool: z.enum(["edit", "write", "bash"]),
	args: z.unknown(),
	testSource: z
		.strictObject({
			path: z.string(),
			digest: z.string().regex(/^[0-9a-f]{64}$/u),
		})
		.optional(),
	lease: z
		.strictObject({
			sessionRoot: z.string(),
			candidateId: z.string().regex(/^[0-9a-f]{64}$/u),
			token: z.string().regex(/^[0-9a-f]{64}$/u),
		})
		.optional(),
	platform: z.enum([
		"aix",
		"android",
		"darwin",
		"freebsd",
		"haiku",
		"linux",
		"openbsd",
		"sunos",
		"win32",
		"cygwin",
		"netbsd",
	]),
});

export const CowWorkerReportSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("ready"),
		base: WorktreeSnapshotSchema,
		delta: WorktreeDeltaSchema,
		result: z.unknown(),
	}),
	z.strictObject({
		kind: z.literal("error"),
		code: z.string(),
		message: z.string(),
	}),
]);

export type CowWorkerRequest = z.infer<typeof CowWorkerRequestSchema>;
export type CowWorkerReport = z.infer<typeof CowWorkerReportSchema>;
