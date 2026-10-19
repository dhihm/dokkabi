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

/** Apply readline-style editing when keystrokes arrive without working raw mode. */
function applyTerminalLineEditing(line: string): string {
  let edited = "";
  for (const char of line) {
    if (char === "\x7f" || char === "\b") edited = edited.slice(0, -1);
    else if (char === "\r" || char === "\n") continue;
    else edited += char;
  }
  return edited;
}

/** Non-TTY stdin that ends without a newline: use only the first line segment. */
function pipedFirstLineBeforeClose(inputText: string): string {
  const newline = inputText.indexOf("\n");
  const line = newline >= 0 ? inputText.slice(0, newline).replace(/\r$/, "") : inputText.replace(/\r$/, "");
  return line.trim();
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
  let inputBytes = 0;
  let inputText = "";
  const countInput = (chunk: Buffer | string) => {
    const piece = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    inputBytes += Buffer.byteLength(piece);
    inputText += piece;
  };
  input.on("data", countInput);
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
  let detachAbort: (() => void) | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const resolveOnce = (value: string) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const abort = () => {
        rejectOnce(new Error("authentication cancelled"));
        readline.close();
      };
      /** Readline submitted a line; never consult raw `inputText`. */
      const finalizeAnswer = (answer: string) => {
        if (terminal) {
          resolveOnce(applyTerminalLineEditing(answer).trim());
          return;
        }
        if (answer.length === 0 && inputBytes === 0) {
          rejectOnce(new Error("no credential was read"));
          return;
        }
        resolveOnce(answer.trim());
      };
      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", abort);
      }
      readline.on("close", () => {
        detachAbort?.();
        if (settled) return;
        if (terminal) {
          rejectOnce(new Error(
            inputText.includes("\x03") ? "authentication cancelled" : "no credential was read",
          ));
          return;
        }
        if (inputBytes === 0) {
          rejectOnce(new Error("no credential was read"));
          return;
        }
        resolveOnce(pipedFirstLineBeforeClose(inputText));
      });
      readline.question("", (answer) => {
        detachAbort?.();
        if (secret && terminal) output.write("\n");
        finalizeAnswer(answer);
      });
    });
  } finally {
    detachAbort?.();
    input.off("data", countInput);
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
