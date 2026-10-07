# VPN reconnect

Use this skill when the operator asks about the monitored VPN tunnel or its reconnect flow.

1. Read state with the `vpn` tool using `op=status`.
2. Never ask for, repeat, quote, summarize, store, or submit an OTP in a model turn.
3. Reconnection is controlled by the trusted remote operator. When the background monitor reports an outage, the operator must first reply with `approve` or `승인`. Both keywords are accepted regardless of the reply locale. Only after that approval creates an awaiting-OTP lease may the operator send the six-digit OTP.
4. The host plugin consumes OTP-shaped input before ordinary work routing. Report only the resulting public state: connected, disconnected, awaiting OTP, or failed.
5. Worker commands, VPN endpoints, accounts, configuration paths, and credentials are host-owned, file-backed service credentials. Never request, inspect, copy into an environment variable, or reveal them.
