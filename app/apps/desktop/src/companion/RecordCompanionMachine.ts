/**
 * Pure placement machine for the Record companion (Dokkabi R6 / R5-04).
 *
 * One machine owns ONE (owner window, logical scope) pair and nothing else:
 * no Electron, no IPC, no timers. It decides a single question — where the
 * inspected record view is interactively placed — through compare-and-swap
 * revisions and actual sender identities:
 *
 * - Every transition validates the caller's sender id (owner or the exact
 *   registered child webContents) AND the expected revision before anything
 *   mutates; a refusal throws and leaves the state bit-for-bit unchanged.
 * - Every successful transition increments the revision exactly once.
 * - `attach` is host-only integration, allowed once during `opening`.
 * - `ready` keeps the child inert: only after the owner acknowledges hiding
 *   its own docked view (`commitDetach`) does the child become the active
 *   placement. A failed opening returns `docked` without losing the view.
 * - Docking requires the child to quiesce first, then the owner to
 *   acknowledge its prepared docked view (`commitDock`); only then is the
 *   child sender released.
 * - Close is closed — never an implicit dock. A reopened scope accepts a NEW
 *   child sender; the old one is refused forever.
 * - A handoff freezes its acknowledged descriptor/source/view/presentation
 *   tuple at `requestOpen`; `ready` must acknowledge the same tuple, and the
 *   owner commits only that transaction. Source updates that arrive during
 *   the handoff wait for the next post-commit snapshot (the host holds them
 *   outside this machine).
 *
 * `state()` always returns a fresh deep snapshot; callers can never reach the
 * machine's internals through it.
 */

/** Opaque webContents identity: never renderer-provided, always actual. */
export type RecordCompanionSender = number;

export type RecordCompanionPlacement = "docked" | "opening" | "detached" | "docking" | "closed";

/** The frozen transaction tuple a handoff acknowledges. */
export interface RecordCompanionHandoff {
  readonly descriptorRevision: number;
  readonly viewRevision: number;
  readonly presentationRevision: number;
}

/** Raw logical scope as the host validated it: raw strings, no page position. */
export interface RecordCompanionMachineScope {
  readonly environmentId: string;
  readonly threadId: string;
  /** Absent and null both mean "no actual instance bound" (normalized to null). */
  readonly providerInstanceId?: string | null | undefined;
}

export interface RecordCompanionMachineState {
  readonly placement: RecordCompanionPlacement;
  readonly revision: number;
  readonly companionId: string;
  readonly scope: RecordCompanionMachineScope;
  readonly ownerSenderId: number;
  readonly childSender: number | null;
  readonly childReady: boolean;
  readonly childQuiesced: boolean;
  readonly handoff: RecordCompanionHandoff | null;
  readonly acknowledgedHandoff: RecordCompanionHandoff | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeScope(scope: RecordCompanionMachineScope): RecordCompanionMachineScope {
  if (typeof scope !== "object" || scope === null) {
    throw new Error("RecordCompanionMachine requires a scope object.");
  }
  const environmentId = scope.environmentId;
  const threadId = scope.threadId;
  if (typeof environmentId !== "string" || environmentId.length === 0) {
    throw new Error("RecordCompanionMachine requires a non-empty environmentId.");
  }
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error("RecordCompanionMachine requires a non-empty threadId.");
  }
  const providerInstanceId =
    scope.providerInstanceId === undefined || scope.providerInstanceId === null
      ? null
      : scope.providerInstanceId;
  if (
    providerInstanceId !== null &&
    (typeof providerInstanceId !== "string" || providerInstanceId.length === 0)
  ) {
    throw new Error("RecordCompanionMachine requires a non-empty providerInstanceId or null.");
  }
  return { environmentId, threadId, providerInstanceId };
}

const sameHandoff = (
  left: RecordCompanionHandoff | null,
  right: RecordCompanionHandoff | null,
): boolean =>
  left === null || right === null
    ? left === right
    : left.descriptorRevision === right.descriptorRevision &&
      left.viewRevision === right.viewRevision &&
      left.presentationRevision === right.presentationRevision;

const snapshot = (state: RecordCompanionMachineState): RecordCompanionMachineState =>
  structuredClone(state);

export class RecordCompanionMachine {
  private readonly ownerSenderId: number;
  private readonly companionId: string;
  private readonly normalizedScope: RecordCompanionMachineScope;
  private placement: RecordCompanionPlacement = "docked";
  private revision = 0;
  private childSender: number | null = null;
  private childReady = false;
  private childQuiesced = false;
  private handoff: RecordCompanionHandoff | null = null;
  private acknowledgedHandoff: RecordCompanionHandoff | null = null;

  constructor(ownerSenderId: number, companionId: string, scope: RecordCompanionMachineScope) {
    if (!Number.isInteger(ownerSenderId) || ownerSenderId <= 0) {
      throw new Error("RecordCompanionMachine requires a positive integer owner sender id.");
    }
    if (typeof companionId !== "string" || !UUID_PATTERN.test(companionId)) {
      throw new Error("RecordCompanionMachine requires a UUID companion id.");
    }
    this.ownerSenderId = ownerSenderId;
    this.companionId = companionId;
    this.normalizedScope = normalizeScope(scope);
  }

  /** A fresh deep snapshot; mutating it can never reach the machine. */
  state(): RecordCompanionMachineState {
    return snapshot({
      placement: this.placement,
      revision: this.revision,
      companionId: this.companionId,
      scope: this.normalizedScope,
      ownerSenderId: this.ownerSenderId,
      childSender: this.childSender,
      childReady: this.childReady,
      childQuiesced: this.childQuiesced,
      handoff: this.handoff,
      acknowledgedHandoff: this.acknowledgedHandoff,
    });
  }

  /** The exact current revision, the CAS token for the next transition. */
  currentRevision(): number {
    return this.revision;
  }

  /**
   * Throws unless the sender is the exact currently registered companion
   * child. After close, dock commit or a failed opening there is no active
   * child, so every former sender is refused.
   */
  assertCompanionSender(sender: RecordCompanionSender): void {
    if (this.childSender === null || this.childSender !== sender) {
      throw new Error(`Sender ${sender} is not the active companion child of ${this.companionId}.`);
    }
  }

  /**
   * Owner starts a handoff (from docked, or reopened from closed). Freezes
   * the acknowledged descriptor/view/presentation tuple for the transaction.
   */
  requestOpen(
    sender: RecordCompanionSender,
    revision: number,
    handoff: RecordCompanionHandoff | null = null,
  ): void {
    this.transition("requestOpen", sender, revision, {
      requireOwner: true,
      requirePlacement: ["docked", "closed"],
      apply: () => {
        this.childSender = null;
        this.childReady = false;
        this.childQuiesced = false;
        this.handoff = handoff === null ? null : { ...handoff };
        this.acknowledgedHandoff = null;
        this.placement = "opening";
      },
    });
  }

  /** Host-only integration: binds the actual child webContents, once, while opening. */
  attach(sender: RecordCompanionSender, revision: number): void {
    this.transition("attach", sender, revision, {
      requirePlacement: ["opening"],
      requireNoChild: true,
      apply: () => {
        this.childSender = sender;
      },
    });
  }

  /**
   * The child acknowledges the frozen tuple while still inert. Repeated or
   * foreign ready calls refuse; the placement stays `opening` until the owner
   * commits the detach.
   */
  ready(
    sender: RecordCompanionSender,
    revision: number,
    handoff: RecordCompanionHandoff | null = null,
  ): void {
    this.transition("ready", sender, revision, {
      requirePlacement: ["opening"],
      requireChild: true,
      requireNotReady: true,
      apply: () => {
        if (!sameHandoff(this.handoff, handoff)) {
          throw new Error(
            `ready acknowledged a different handoff tuple for ${this.companionId}; refusing the transaction.`,
          );
        }
        this.childReady = true;
        this.acknowledgedHandoff = this.handoff === null ? null : { ...this.handoff };
      },
    });
  }

  /**
   * Owner acknowledges its docked view is hidden/disabled: the transaction
   * commits and the child becomes the active placement.
   */
  commitDetach(sender: RecordCompanionSender, revision: number): void {
    this.transition("commitDetach", sender, revision, {
      requireOwner: true,
      requirePlacement: ["opening"],
      requireReady: true,
      apply: () => {
        this.childQuiesced = false;
        this.placement = "detached";
      },
    });
  }

  /**
   * The child requests docking; the owner is asked to prepare its view.
   *
   * A docking transaction acknowledges the CURRENT inspected tuple — the
   * latest validated descriptor/view/presentation revisions — never the
   * original Open tuple: view and presentation may legitimately have moved
   * since the detach. The host always passes the latest tuple; quiesce must
   * then acknowledge exactly the newly frozen one.
   */
  requestDock(
    sender: RecordCompanionSender,
    revision: number,
    dockHandoff?: RecordCompanionHandoff,
  ): void {
    this.transition("requestDock", sender, revision, {
      requirePlacement: ["detached"],
      requireChild: true,
      apply: () => {
        if (dockHandoff !== undefined) {
          this.handoff = { ...dockHandoff };
          this.acknowledgedHandoff = { ...dockHandoff };
        }
        this.childQuiesced = false;
        this.placement = "docking";
      },
    });
  }

  /** The child quiesces: visible but inert while the owner prepares docking. */
  quiesce(
    sender: RecordCompanionSender,
    revision: number,
    handoff: RecordCompanionHandoff | null = null,
  ): void {
    this.transition("quiesce", sender, revision, {
      requirePlacement: ["docking"],
      requireChild: true,
      requireNotQuiesced: true,
      apply: () => {
        if (!sameHandoff(this.acknowledgedHandoff, handoff)) {
          throw new Error(
            `quiesce acknowledged a different handoff tuple for ${this.companionId}; refusing the transaction.`,
          );
        }
        this.childQuiesced = true;
      },
    });
  }

  /**
   * Owner acknowledges its docked view is prepared: the dock commits, the
   * child sender is released and every later child call refuses.
   */
  commitDock(sender: RecordCompanionSender, revision: number): void {
    this.transition("commitDock", sender, revision, {
      requireOwner: true,
      requirePlacement: ["docking"],
      requireQuiesced: true,
      apply: () => {
        this.releaseChild();
        this.placement = "docked";
      },
    });
  }

  /**
   * A failed opening (timeout, load failure, crash) rolls back to docked and
   * revokes the provisional child sender. The docked view is preserved.
   */
  failOpening(sender: RecordCompanionSender, revision: number): void {
    this.transition("failOpening", sender, revision, {
      requireOwner: true,
      requirePlacement: ["opening"],
      apply: () => {
        this.releaseChild();
        this.placement = "docked";
      },
    });
  }

  /**
   * Close is closed — never an automatic dock. The owner may close from any
   * live handoff placement; the child may close its own window while it is
   * the active placement. Both revoke the child identity.
   */
  close(sender: RecordCompanionSender, revision: number): void {
    const isOwner = sender === this.ownerSenderId;
    const isChild = this.childSender !== null && sender === this.childSender;
    if (!isOwner && !isChild) {
      throw new Error(
        `close on ${this.companionId} came from sender ${sender}, which is neither the owner nor the active child.`,
      );
    }
    if (
      this.placement !== "opening" &&
      this.placement !== "detached" &&
      this.placement !== "docking"
    ) {
      throw new Error(
        `close on ${this.companionId} arrived while placement is ${this.placement}; there is nothing live to close.`,
      );
    }
    this.checkRevision("close", revision);
    this.releaseChild();
    this.placement = "closed";
    this.revision += 1;
  }

  private releaseChild(): void {
    this.childSender = null;
    this.childReady = false;
    this.childQuiesced = false;
    this.handoff = null;
    this.acknowledgedHandoff = null;
  }

  private checkRevision(method: string, revision: number): void {
    if (!Number.isInteger(revision) || revision !== this.revision) {
      throw new Error(
        `${method} on ${this.companionId} carried revision ${revision}, expected ${this.revision}.`,
      );
    }
  }

  private transition(
    method: string,
    sender: RecordCompanionSender,
    revision: number,
    constraints: {
      readonly requireOwner?: boolean;
      readonly requirePlacement?: readonly RecordCompanionPlacement[];
      readonly requireChild?: boolean;
      readonly requireNoChild?: boolean;
      readonly requireReady?: boolean;
      readonly requireNotReady?: boolean;
      readonly requireQuiesced?: boolean;
      readonly requireNotQuiesced?: boolean;
      readonly apply: () => void;
    },
  ): void {
    if (!Number.isInteger(sender) || sender <= 0) {
      throw new Error(`${method} on ${this.companionId} carried an invalid sender.`);
    }
    if (constraints.requireOwner === true && sender !== this.ownerSenderId) {
      throw new Error(
        `${method} on ${this.companionId} came from sender ${sender}, not the owner ${this.ownerSenderId}.`,
      );
    }
    this.checkRevision(method, revision);
    if (
      constraints.requirePlacement !== undefined &&
      !constraints.requirePlacement.includes(this.placement)
    ) {
      throw new Error(
        `${method} on ${this.companionId} is invalid while placement is ${this.placement}.`,
      );
    }
    if (constraints.requireChild === true) {
      this.assertCompanionSender(sender);
    }
    if (constraints.requireNoChild === true && this.childSender !== null) {
      throw new Error(`${method} on ${this.companionId} would bind a second child.`);
    }
    if (constraints.requireReady === true && this.childReady !== true) {
      throw new Error(`${method} on ${this.companionId} requires the child to be ready first.`);
    }
    if (constraints.requireNotReady === true && this.childReady === true) {
      throw new Error(
        `${method} on ${this.companionId} arrived after the child was already ready.`,
      );
    }
    if (constraints.requireQuiesced === true && this.childQuiesced !== true) {
      throw new Error(`${method} on ${this.companionId} requires the child to quiesce first.`);
    }
    if (constraints.requireNotQuiesced === true && this.childQuiesced === true) {
      throw new Error(`${method} on ${this.companionId} arrived after the child already quiesced.`);
    }
    constraints.apply();
    this.revision += 1;
  }
}
