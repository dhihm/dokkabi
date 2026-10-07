import * as NodeCrypto from "node:crypto";
import type { ProviderGetWorkbenchCodeInput, WorkbenchCode } from "@t3tools/contracts";
import { canonicalRecordJson } from "./RecordChain.ts";

const sha = (text: string) => NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
const equal = (a: unknown, b: unknown) => canonicalRecordJson(a) === canonicalRecordJson(b);

/** Integrity checks supplement authenticated host authority. Metadata alone
 * never qualifies a retained body or claims a complete repository snapshot. */
export function verifyCodeRead(
  read: WorkbenchCode,
  page: Omit<ProviderGetWorkbenchCodeInput, "threadId">,
): string | null {
  const head = read.sessionCursor;
  if (head.seq === 0 && head.hash !== "0".repeat(64)) return "Invalid genesis code cursor";
  let last = 0;
  for (const item of read.versions) {
    const ref = item.reference;
    if (ref.sessionId !== head.sessionId || ref.version.seq <= last || ref.version.seq > head.seq)
      return "Code index has foreign, unordered or out-of-prefix references";
    if (ref.version.seq === head.seq && ref.version.hash !== head.hash)
      return "Code publication disagrees with the source head";
    if (
      !read.resnapshot &&
      page.after?.seq === ref.version.seq &&
      page.after.hash !== ref.version.hash
    )
      return "Code publication disagrees with the acknowledged cursor";
    last = ref.version.seq;
  }
  if (page.after) {
    if (page.after.sessionId !== head.sessionId)
      return "Code acknowledgement names another session";
    if (
      !read.resnapshot &&
      (page.after.generation !== head.generation ||
        page.after.seq > head.seq ||
        (page.after.seq === head.seq && page.after.hash !== head.hash))
    )
      return "Invalid code acknowledgement continuity";
  } else if (!read.resnapshot) return "Initial code read must resnapshot";
  const observerRevision = read.observer?.revision;
  if (
    observerRevision !== undefined &&
    (!Number.isSafeInteger(observerRevision) || observerRevision < 0 || observerRevision > head.seq)
  )
    return "Invalid code observer revision outside the authenticated source prefix";
  const changed =
    read.resnapshot ||
    read.versions.some((item) => item.reference.version.seq > (page.after?.seq ?? 0)) ||
    (observerRevision !== undefined && observerRevision > (page.after?.seq ?? 0));
  if (read.changed !== changed)
    return "Code change flag disagrees with recorded publications or observer controls";
  if (!page.selection)
    return read.body === null ? null : "Index read supplied an unsolicited code body";
  if (!read.body) return "Selected code body is absent";
  const selected = read.versions.find(
    (item) =>
      equal(item.reference.version, { seq: page.selection!.seq, hash: page.selection!.hash }) &&
      item.reference.digest === page.selection!.digest,
  );
  if (!selected || !equal(read.body.reference, selected.reference))
    return "Selected body is not the requested indexed publication";
  const text = read.body.text;
  if (
    Buffer.byteLength(text, "utf8") !== selected.bytes ||
    selected.bytes > 8 * 1024 * 1024 ||
    sha(text) !== selected.reference.digest
  )
    return "Retained code body digest or byte bound mismatch";
  try {
    const body: unknown = JSON.parse(text);
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return "Invalid code envelope";
    const envelope = body as Record<string, unknown>;
    if (
      canonicalRecordJson(body) !== text ||
      envelope.schema !== "code-evolution-v1" ||
      envelope.sessionId !== head.sessionId ||
      envelope.graphDigest !== selected.graphDigest ||
      sha(canonicalRecordJson(envelope.graph)) !== selected.graphDigest
    )
      return "Code envelope binding mismatch";
  } catch {
    return "Invalid canonical code envelope";
  }
  return null;
}
