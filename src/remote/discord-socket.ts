import type {
  DiscordGatewayClock,
  DiscordGatewaySocket,
} from "./discord-gateway-contract.ts";

class DiscordSocketError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "DiscordSocketError";
  }
}

export const systemDiscordClock: DiscordGatewayClock = {
  setInterval(listener, milliseconds) {
    const timer = globalThis.setInterval(listener, milliseconds);
    return { dispose: () => globalThis.clearInterval(timer) };
  },
  setTimeout(listener, milliseconds) {
    const timer = globalThis.setTimeout(listener, milliseconds);
    return { dispose: () => globalThis.clearTimeout(timer) };
  },
};

export function connectDiscordSocket(url: string): DiscordGatewaySocket {
  const socket = new WebSocket(url);
  return {
    close: () => socket.close(),
    onClose: (listener) => socket.addEventListener("close", (event) => listener(event.code)),
    onError: (listener) => socket.addEventListener(
      "error",
      () => listener(new DiscordSocketError("Discord gateway socket error")),
    ),
    onMessage: (listener) => socket.addEventListener("message", (event) => listener(event.data)),
    onOpen: (listener) => socket.addEventListener("open", listener),
    send: (payload) => socket.send(payload),
  };
}
