import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export interface TerminalAuthOptions {
  input?: Readable;
  output?: Writable;
  openUrl?: (url: string) => boolean;
  signal?: AbortSignal;
}

export function createTerminalAuthInteraction(options: TerminalAuthOptions = {}): AuthInteraction {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const openUrl = options.openUrl ?? openProviderUrl;
  return {
    signal: options.signal,
    prompt: async (prompt) => promptForAuth(prompt, input, output),
    notify: (event) => renderAuthEvent(event, output, openUrl),
  };
}

async function promptForAuth(prompt: AuthPrompt, input: Readable, output: Writable): Promise<string> {
  prompt.signal?.throwIfAborted();
  if (prompt.type === "select") {
    output.write(`${prompt.message}\n`);
    for (const [index, option] of prompt.options.entries()) {
      const description = option.description ? ` — ${option.description}` : "";
      output.write(`  ${index + 1}. ${option.label}${description}\n`);
    }
    const answer = await readLine(input, output, "Select an option", false, prompt.signal);
    const number = Number(answer);
    if (Number.isInteger(number) && number >= 1 && number <= prompt.options.length) {
      return prompt.options[number - 1]!.id;
    }
    const matched = prompt.options.find((option) => option.id === answer);
    if (!matched) throw new Error("invalid authentication selection");
    return matched.id;
  }
  return readLine(input, output, prompt.message, prompt.type === "secret", prompt.signal);
}

async function readLine(
  input: Readable,
  output: Writable,
  message: string,
  secret: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const terminal = (input as Readable & { isTTY?: boolean }).isTTY === true;
  output.write(`${message}: `);
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const readline = createInterface({
    input,
    output: secret && terminal ? muted : output,
    terminal,
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      const abort = () => {
        readline.close();
        reject(new Error("authentication cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      readline.question("", (answer) => {
        signal?.removeEventListener("abort", abort);
        if (secret && terminal) output.write("\n");
        resolve(answer.trim());
      });
    });
  } finally {
    readline.close();
    muted.destroy();
  }
}

function renderAuthEvent(event: AuthEvent, output: Writable, openUrl: (url: string) => boolean): void {
  if (event.type === "auth_url") {
    const opened = openUrl(event.url);
    output.write(`${opened ? "Opened" : "Open"} the provider sign-in page:\n${event.url}\n`);
    if (event.instructions) output.write(`${event.instructions}\n`);
    return;
  }
  if (event.type === "device_code") {
    output.write(`Open ${event.verificationUri}\nEnter device code: ${event.userCode}\n`);
    return;
  }
  output.write(`${event.message}\n`);
  if (event.type === "info") {
    for (const link of event.links ?? []) output.write(`${link.label ?? "More information"}: ${link.url}\n`);
  }
}

export function openProviderUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url.toString()] : [url.toString()];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
