import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { assertPromotionStorage, assertPromotionsDirectory, holdPromotionStorage, readPromotionFile } from "./promotion-storage.ts";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const entrySchema = z.object({
  relative: z.string().min(1),
  anchorRelative: z.string(),
  anchorDevice: z.number().int().nonnegative(),
  anchorInode: z.number().int().nonnegative(),
  backupName: z.string().regex(/^[0-9]+$/).optional(),
  backupDigest: digestSchema.optional(),
  mode: z.number().int().nonnegative().optional(),
  createdParents: z.array(z.string().min(1)),
}).strict();
const payloadSchema = z.object({
  version: z.literal(1),
  promotionId: z.string().uuid(),
  phase: z.enum(["prepared", "applying", "committed", "resolved"]),
  sourceAuthorityDigest: digestSchema,
  baseDigest: digestSchema,
  baseTree: z.string().regex(/^[0-9a-f]{40,64}$/),
  runtimeDigest: digestSchema,
  captureRuntimeArtifacts: z.boolean(),
  decisionDigest: digestSchema,
  patchDigest: digestSchema,
  entries: z.array(entrySchema),
}).strict();
const envelopeSchema = z.object({ payload: payloadSchema, mac: digestSchema }).strict();
const foregroundSchema = z.object({
  callId: z.string().min(1).max(256),
  tool: z.enum(["edit", "write"]),
  argsDigest: digestSchema,
  eventSeq: z.number().int().positive().safe(),
  eventHash: digestSchema,
}).strict();
const latencyBucketSchema = z.enum(["under_1ms", "under_10ms", "under_100ms", "under_1s", "at_least_1s"]);
const resolveTerminalSchema = z.object({
  kind: z.literal("resolve"),
  candidateId: digestSchema,
  outcome: z.enum(["promoted", "stale", "failed", "drop"]),
  latencyBucket: latencyBucketSchema,
}).strict();
const recoveryTerminalSchema = z.object({
  kind: z.literal("recover"),
  candidateId: digestSchema,
  outcome: z.enum(["restored", "cleaned"]),
}).strict();
const transactionBase = {
  version: z.literal(2),
  promotionId: z.string().uuid(),
  candidateId: digestSchema,
  foregroundCallId: z.string().min(1).max(256),
  foregroundTool: z.enum(["edit", "write"]),
  foregroundArgsDigest: digestSchema,
  candidateKeyDigest: digestSchema,
  finalTree: z.string().regex(/^[0-9a-f]{40,64}$/),
};
const transactionSchema = z.discriminatedUnion("phase", [
  z.object({ ...transactionBase, phase: z.literal("prepared") }).strict(),
  z.object({ ...transactionBase, phase: z.literal("authorized"), foreground: foregroundSchema }).strict(),
  z.object({ ...transactionBase, phase: z.literal("applying"), foreground: foregroundSchema }).strict(),
  z.object({ ...transactionBase, phase: z.literal("committed"), foreground: foregroundSchema,
    committedDigest: digestSchema, terminal: resolveTerminalSchema }).strict(),
  z.object({ ...transactionBase, phase: z.literal("resolved"), foreground: foregroundSchema.optional(),
    committedDigest: digestSchema.optional(), terminal: z.union([resolveTerminalSchema, recoveryTerminalSchema]) }).strict(),
]);
const transactionEnvelopeSchema = z.object({ payload: transactionSchema, mac: digestSchema }).strict();

export type PromotionJournalEntry = z.infer<typeof entrySchema>;
export type PromotionJournal = z.infer<typeof payloadSchema>;
export type PromotionForegroundAuthorization = z.infer<typeof foregroundSchema>;
export type PromotionResolveTerminal = z.infer<typeof resolveTerminalSchema>;
export type PromotionRecoveryTerminal = z.infer<typeof recoveryTerminalSchema>;
export type PromotionTransactionJournal = z.infer<typeof transactionSchema>;
export type PromotionLatencyBucket = z.infer<typeof latencyBucketSchema>;

export class PromotionJournalError extends Error {
  constructor(readonly code: "authority" | "integrity" | "private_root") {
    super({
      authority: "promotion journal does not match the explicit source authority",
      integrity: "promotion journal or backup integrity check failed",
      private_root: "promotion session root must be an existing private canonical directory",
    }[code]);
    this.name = "PromotionJournalError";
  }
}

export function trustedSessionRoot(sessionRoot: string): string {
  const requested = resolve(sessionRoot);
  if (!existsSync(requested)) throw new PromotionJournalError("private_root");
  const canonical = realpathSync(requested);
  const stat = lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new PromotionJournalError("private_root");
  }
  return canonical;
}

export function sourceAuthorityDigest(sourceRoot: string): string {
  return createHash("sha256").update(realpathSync(resolve(sourceRoot))).digest("hex");
}

export function copyRecoveryKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) throw new PromotionJournalError("authority");
  return Buffer.from(key);
}

export function createPromotionStorage(sessionRoot: string): { readonly id: string; readonly root: string; readonly assertAttached: () => void } {
  const session = trustedSessionRoot(sessionRoot);
  const promotions = join(session, "promotions");
  if (!existsSync(promotions)) mkdirSync(promotions, { mode: 0o700 });
  assertPromotionsDirectory(session);
  const id = randomUUID();
  const root = join(promotions, id);
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(join(root, "backups"), { mode: 0o700 });
  fsyncDirectory(root);
  fsyncDirectory(promotions);
  fsyncDirectory(session);
  return { id, root, assertAttached: holdPromotionStorage(root) };
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function canonicalPayload(payload: PromotionJournal): string {
  return JSON.stringify(payload);
}

function persistAuthenticated(
  storageRoot: string,
  name: "journal.json" | "transaction.json",
  payload: PromotionJournal | PromotionTransactionJournal,
  key: Uint8Array,
): void {
  assertPromotionStorage(storageRoot);
  const body = JSON.stringify(payload);
  const envelope = JSON.stringify({
    payload,
    mac: createHmac("sha256", copyRecoveryKey(key)).update(body).digest("hex"),
  });
  const temporary = join(storageRoot, `${name}.${randomUUID()}.next`);
  const destination = join(storageRoot, name);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, envelope);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, destination);
  fsyncDirectory(storageRoot);
}

export function persistPromotionJournal(storageRoot: string, payload: PromotionJournal, key: Uint8Array): void {
  persistAuthenticated(storageRoot, "journal.json", payload, key);
}

export function persistPromotionTransaction(
  storageRoot: string,
  payload: PromotionTransactionJournal,
  key: Uint8Array,
): void {
  persistAuthenticated(storageRoot, "transaction.json", payload, key);
}

export function readPromotionJournal(storageRoot: string, key: Uint8Array): PromotionJournal {
  const parsed = envelopeSchema.safeParse(JSON.parse(readPromotionFile(storageRoot, "journal.json").toString("utf8")));
  if (!parsed.success) throw new PromotionJournalError("integrity");
  const actual = createHmac("sha256", copyRecoveryKey(key)).update(canonicalPayload(parsed.data.payload)).digest();
  if (!timingSafeEqual(actual, Buffer.from(parsed.data.mac, "hex")) || basename(storageRoot) !== parsed.data.payload.promotionId) {
    throw new PromotionJournalError("integrity");
  }
  return parsed.data.payload;
}

export function readPromotionTransaction(storageRoot: string, key: Uint8Array): PromotionTransactionJournal {
  const parsed = transactionEnvelopeSchema.safeParse(
    JSON.parse(readPromotionFile(storageRoot, "transaction.json").toString("utf8")),
  );
  if (!parsed.success) throw new PromotionJournalError("integrity");
  const actual = createHmac("sha256", copyRecoveryKey(key)).update(JSON.stringify(parsed.data.payload)).digest();
  if (!timingSafeEqual(actual, Buffer.from(parsed.data.mac, "hex"))
    || basename(storageRoot) !== parsed.data.payload.promotionId) {
    throw new PromotionJournalError("integrity");
  }
  return parsed.data.payload;
}

export function assertJournalAuthority(journal: PromotionJournal, sourceRoot: string): void {
  if (journal.sourceAuthorityDigest !== sourceAuthorityDigest(sourceRoot)) {
    throw new PromotionJournalError("authority");
  }
}

export function removePromotionStorage(sessionRoot: string, storageRoot: string): void {
  const promotions = join(trustedSessionRoot(sessionRoot), "promotions");
  const escaped = relative(promotions, storageRoot);
  if (!escaped || escaped.startsWith("..") || isAbsolute(escaped) || dirname(escaped) !== ".") {
    throw new PromotionJournalError("authority");
  }
  assertPromotionStorage(storageRoot);
  rmSync(storageRoot, { recursive: true, force: true });
  fsyncDirectory(promotions);
}
