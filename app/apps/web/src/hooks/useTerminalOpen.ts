import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TerminalOpenInput, TerminalSessionSnapshot } from "@t3tools/contracts";
import { useCallback } from "react";

import { useTerminalOpenRefusalStore } from "../terminalOpenRefusalStore";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";

export function useTerminalOpen(): (input: {
  readonly environmentId: EnvironmentId;
  readonly input: TerminalOpenInput;
}) => Promise<AtomCommandResult<TerminalSessionSnapshot, unknown>> {
  const open = useAtomCommand(terminalEnvironment.open, "terminal open");
  const setRefusal = useTerminalOpenRefusalStore((state) => state.setRefusal);
  const clearRefusal = useTerminalOpenRefusalStore((state) => state.clearRefusal);

  return useCallback(
    async (input) => {
      const result = await open(input);
      const target = {
        environmentId: input.environmentId,
        threadId: input.input.threadId,
        terminalId: input.input.terminalId,
      };
      if (result._tag === "Success") {
        clearRefusal(target);
        return result;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setRefusal(target, error instanceof Error ? error.message : "Terminal open failed.");
      }
      return result;
    },
    [clearRefusal, open, setRefusal],
  );
}
