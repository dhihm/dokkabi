export interface TerminalOpenRefusalTarget {
  readonly environmentId: string;
  readonly threadId: string;
  readonly terminalId: string;
}

export function terminalOpenRefusalKey(target: TerminalOpenRefusalTarget): string {
  return `${target.environmentId}:${target.threadId}:${target.terminalId}`;
}

export function shouldForwardTerminalInput(input: {
  readonly openRefusalMessage: string | null;
}): boolean {
  return input.openRefusalMessage === null;
}

export function resolveTerminalOpenRefusalPresentation(input: {
  readonly openRefusalMessage: string | null;
  readonly attachError: string | null;
}): {
  readonly displayMessage: string | null;
  readonly forwardInput: boolean;
} {
  if (input.openRefusalMessage !== null) {
    return {
      displayMessage: input.openRefusalMessage,
      forwardInput: false,
    };
  }
  return {
    displayMessage: input.attachError,
    forwardInput: true,
  };
}

export function terminalCloseConfirmsRunningProcess(input: {
  readonly openRefusalMessage: string | null;
  readonly hasRunningSubprocess: boolean | undefined;
}): boolean {
  if (input.openRefusalMessage !== null) {
    return false;
  }
  return input.hasRunningSubprocess ?? true;
}

export function terminalGroupCloseStopsRunningProcess(input: {
  readonly targets: ReadonlyArray<
    TerminalOpenRefusalTarget & { readonly hasRunningSubprocess?: boolean }
  >;
  readonly openRefusalByKey: Readonly<Record<string, string>>;
}): boolean {
  return input.targets.some((target) =>
    terminalCloseConfirmsRunningProcess({
      openRefusalMessage: input.openRefusalByKey[terminalOpenRefusalKey(target)] ?? null,
      hasRunningSubprocess: target.hasRunningSubprocess,
    }),
  );
}
