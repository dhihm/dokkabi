import {
  createDiscordGatewayClient,
  type DiscordGatewayClock,
  type DiscordGatewaySocket,
} from "./discord-gateway.ts";
import type { DiscordGatewayConfig } from "./discord-wire.ts";
import { createDiscordRestClient } from "./discord-rest.ts";
import type { RemoteAdapter, RemoteDelivery } from "./types.ts";

interface DiscordRemoteAdapterInput {
  readonly clock?: DiscordGatewayClock;
  readonly config: DiscordGatewayConfig;
  readonly connect?: (url: string) => DiscordGatewaySocket;
  readonly onError?: (error: Error) => void;
  readonly sendMessage?: (
    delivery: RemoteDelivery,
  ) => Promise<{ readonly externalMessageId: string }>;
}

export function createDiscordRemoteAdapter(input: DiscordRemoteAdapterInput): RemoteAdapter {
  const writer = input.sendMessage ?? createDiscordRestClient({ botToken: input.config.botToken }).deliver;
  let gateway: ReturnType<typeof createDiscordGatewayClient> | undefined;
  return {
    id: "discord",
    async start(ingress) {
      gateway = createDiscordGatewayClient({
        adapterId: "discord",
        config: input.config,
        ingress,
        ...(input.clock ? { clock: input.clock } : {}),
        ...(input.connect ? { connect: input.connect } : {}),
        ...(input.onError ? { onError: input.onError } : {}),
      });
      await gateway.start();
    },
    async stop() {
      await gateway?.stop();
      gateway = undefined;
    },
    async deliver(delivery) {
      return await writer(delivery);
    },
  };
}
