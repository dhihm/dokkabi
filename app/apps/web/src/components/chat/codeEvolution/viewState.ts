import type { WorkbenchCode } from "@t3tools/contracts";
type Reference = WorkbenchCode["versions"][number]["reference"];
export const codeReferenceKey = (ref: Reference): string =>
  JSON.stringify([ref.sessionId, ref.version.seq, ref.version.hash, ref.digest]);
export interface CodeViewState {
  readonly index: WorkbenchCode | null;
  readonly selected: string | null;
  readonly follow: boolean;
  readonly error: string | null;
}
export const initialCodeView = (): CodeViewState => ({
  index: null,
  selected: null,
  follow: true,
  error: null,
});
const advances = (
  next: { seq: number; hash: string; generation: string },
  prior: { seq: number; hash: string; generation: string },
): boolean =>
  next.generation === prior.generation &&
  (next.seq > prior.seq || (next.seq === prior.seq && next.hash === prior.hash));

/** Exact identity, locked source heads
 * and stale-picture retention. This producer never evicts immutable versions;
 * disappearance or replacement is therefore a refusal, not a new history. */
export function acceptCodeIndex(state: CodeViewState, next: WorkbenchCode): CodeViewState {
  const refuse = (error: string): CodeViewState => ({ ...state, error });
  if (next.body !== null) return refuse("Unsolicited Code body in an index response.");
  if (
    next.versions.length > 32 ||
    next.versions.some(
      (v, i) =>
        v.reference.sessionId !== next.sessionCursor.sessionId ||
        v.reference.version.seq > next.sessionCursor.seq ||
        (i > 0 && v.reference.version.seq <= next.versions[i - 1]!.reference.version.seq),
    )
  )
    return refuse("Invalid owned Code version index.");
  const prior = state.index;
  if (prior) {
    if (
      next.sessionCursor.sessionId !== prior.sessionCursor.sessionId ||
      !advances(next.sessionCursor, prior.sessionCursor) ||
      !advances(next.gatewayCursor, prior.gatewayCursor)
    )
      return refuse(
        "Code source replaced, rewound or conflicted. Reopen the owned thread after recovery.",
      );
    if (
      prior.versions.some((old) => {
        const fresh = next.versions.find(
          (v) => v.reference.version.seq === old.reference.version.seq,
        );
        return (
          !fresh ||
          codeReferenceKey(fresh.reference) !== codeReferenceKey(old.reference) ||
          fresh.bytes !== old.bytes ||
          fresh.graphDigest !== old.graphDigest
        );
      })
    )
      return refuse("An immutable Code version disappeared or changed.");
  }
  const versions = next.versions.map(
    (fresh) =>
      prior?.versions.find(
        (old) => codeReferenceKey(old.reference) === codeReferenceKey(fresh.reference),
      ) ?? fresh,
  );
  if (
    prior &&
    state.error === null &&
    next.sessionCursor.seq === prior.sessionCursor.seq &&
    next.sessionCursor.hash === prior.sessionCursor.hash &&
    next.gatewayCursor.seq === prior.gatewayCursor.seq &&
    next.gatewayCursor.hash === prior.gatewayCursor.hash &&
    versions.length === prior.versions.length &&
    versions.every((v, i) => v === prior.versions[i])
  )
    return state;
  const last = next.versions.at(-1);
  return {
    ...state,
    index: { ...next, versions },
    selected: state.follow ? (last ? codeReferenceKey(last.reference) : null) : state.selected,
    error: null,
  };
}
export function selectCodeVersion(state: CodeViewState, key: string | null): CodeViewState {
  if (key !== null && !state.index?.versions.some((v) => codeReferenceKey(v.reference) === key))
    return state;
  return {
    ...state,
    follow: key === null,
    selected:
      key ??
      (state.index?.versions.at(-1)
        ? codeReferenceKey(state.index.versions.at(-1)!.reference)
        : null),
  };
}
