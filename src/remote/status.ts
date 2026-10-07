import {
  containsPrivateInfrastructure,
  containsSecret,
} from "../host/redact.ts";
import type {
  RemoteRegistrationDisposer,
  RemoteStatusContribution,
  RemoteStatusRegistry as RemoteStatusRegistryContract,
} from "./types.ts";

const CONTRIBUTION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_STATUS_LINE_LENGTH = 512;

/** Create a deterministic, reversible registry for host-only remote status.
 * A failing contribution cannot suppress the base remote run status. */
export class RemoteStatusRegistry implements RemoteStatusRegistryContract {
  private readonly contributions = new Map<string, RemoteStatusContribution>();

  register(id: string, contribution: RemoteStatusContribution): RemoteRegistrationDisposer {
      if (!CONTRIBUTION_ID.test(id)) {
        throw new Error("remote status contribution id is invalid");
      }
      if (this.contributions.has(id)) {
        throw new Error(`duplicate remote status contribution ${id}`);
      }
      this.contributions.set(id, contribution);
      return () => {
        if (this.contributions.get(id) === contribution) this.contributions.delete(id);
      };
  }

  async lines(): Promise<readonly string[]> {
      const lines: string[] = [];
      for (const [id, contribution] of this.contributions) {
        try {
          const value = await contribution();
          const candidates = typeof value === "string" ? [value] : value;
          const safe = candidates.map(validateRemoteStatusLine);
          lines.push(...safe);
        } catch {
          lines.push(`status:${id}=unavailable`);
        }
      }
      return lines;
  }
}

export function createRemoteStatusRegistry(): RemoteStatusRegistry {
  return new RemoteStatusRegistry();
}

export function validateRemoteStatusLine(value: string): string {
  if (typeof value !== "string") throw new Error("remote status line must be text");
  const line = value.trim();
  if (line.length === 0 || line.length > MAX_STATUS_LINE_LENGTH) {
    throw new Error("remote status line length is invalid");
  }
  if (/\r|\n|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) {
    throw new Error("remote status line must be a single printable line");
  }
  if (containsSecret(line) || containsPrivateInfrastructure(line)) {
    throw new Error("remote status line contains protected material");
  }
  return line;
}
