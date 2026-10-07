/**
 * A corporate network reaches the internet through a proxy, and the sandbox
 * was throwing the address away.
 *
 * The sandbox clears the environment and re-adds a short allowlist, which
 * deliberately excluded proxy variables: a proxy URL can carry credentials in
 * its userinfo, and handing those to a model-controlled command is exactly
 * what the allowlist exists to prevent. But the network itself was never
 * closed in a writable world — only the way out of it was. On a machine whose
 * egress is proxied, every fetch inside the sandbox failed as though the
 * network were denied, and downloading a model's weights was impossible.
 *
 * The credential is the thing to refuse, not the address. A proxy URL with
 * userinfo is dropped and reported; one without is passed through, because it
 * is a route, not a secret. NO_PROXY travels with them or the exceptions are
 * lost.
 */

/** Proxy variables in both spellings; tools disagree about the case. */
const PROXY_KEYS: readonly string[] = [
  "HTTP_PROXY", "http_proxy",
  "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy",
];

const MAX_VALUE_BYTES = 2048;

/** Whether a proxy URL carries userinfo, i.e. a credential. */
export function carriesCredential(value: string): boolean {
  // scheme://user[:pass]@host — the userinfo is anything before an @ that
  // precedes the first slash of the path.
  const authority = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u, "").split("/")[0] ?? "";
  return authority.includes("@");
}

/**
 * Windows writes a proxy exception list that Linux tools cannot read.
 *
 * Under WSL the Windows proxy settings are inherited, and they carry syntax
 * from the other side: `<local>` is a Windows token for local addresses, and
 * `12.*.*.*` is a wildcard form no Linux client parses. Forwarding those into
 * the sandbox hands curl, pip and urllib a list they will mishandle — some
 * ignore the offending entry, some ignore the whole variable, and the
 * difference decides whether a request goes through the proxy or straight out
 * and gets reset.
 *
 * A leading `*.` is the one form worth translating rather than dropping:
 * `*.example.com` means the same thing Linux writes as `.example.com`, so it
 * is rewritten instead of lost.
 */
export interface NoProxyResult {
  readonly value: string;
  /** Entries dropped because no Linux client can act on them. */
  readonly dropped: readonly string[];
  /** Entries rewritten into the form Linux clients expect. */
  readonly rewritten: readonly string[];
}

export function sanitizeNoProxy(raw: string): NoProxyResult {
  const kept: string[] = [];
  const dropped: string[] = [];
  const rewritten: string[] = [];
  for (const piece of raw.split(",")) {
    const entry = piece.trim();
    if (entry.length === 0) continue;
    // <local>, <-loopback> and friends are Windows tokens, not host patterns.
    if (entry.startsWith("<") && entry.endsWith(">")) {
      dropped.push(entry);
      continue;
    }
    if (entry.startsWith("*.")) {
      const linux = entry.slice(1);              // "*.a.com" -> ".a.com"
      rewritten.push(entry);
      if (!kept.includes(linux)) kept.push(linux);
      continue;
    }
    // A wildcard anywhere else has no meaning to a Linux client: "12.*.*.*"
    // matches nothing and a bare "*" would disable the proxy entirely.
    if (entry.includes("*")) {
      dropped.push(entry);
      continue;
    }
    if (!kept.includes(entry)) kept.push(entry);
  }
  return {
    value: kept.join(","),
    dropped: Object.freeze(dropped) as readonly string[],
    rewritten: Object.freeze(rewritten) as readonly string[],
  };
}

export interface ProxyEnvResult {
  readonly env: Readonly<Record<string, string>>;
  /** Names dropped because their value carried a credential. */
  readonly withheld: readonly string[];
  /** NO_PROXY entries a Linux client could not have acted on. */
  readonly droppedExceptions: readonly string[];
}

/**
 * The proxy settings a sandboxed command may see. Empty when the host has
 * none, so a machine with direct egress behaves exactly as before.
 */
export function proxyEnvironment(hostEnv: NodeJS.Dict<string>): ProxyEnvResult {
  const env: Record<string, string> = {};
  const withheld: string[] = [];
  const droppedExceptions: string[] = [];
  for (const key of PROXY_KEYS) {
    const value = hostEnv[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_VALUE_BYTES) continue;
    if (trimmed.includes("\0") || trimmed.includes("\n")) continue;
    // NO_PROXY is a host list, never a URL, so it cannot carry userinfo — but
    // under WSL it carries Windows syntax that no Linux client can read.
    if (key.toLowerCase().startsWith("no_")) {
      const cleaned = sanitizeNoProxy(trimmed);
      for (const entry of cleaned.dropped) {
        if (!droppedExceptions.includes(entry)) droppedExceptions.push(entry);
      }
      if (cleaned.value.length > 0) env[key] = cleaned.value;
      continue;
    }
    if (carriesCredential(trimmed)) {
      withheld.push(key);
      continue;
    }
    env[key] = trimmed;
  }
  return {
    env: Object.freeze(env),
    withheld: Object.freeze(withheld) as readonly string[],
    droppedExceptions: Object.freeze(droppedExceptions) as readonly string[],
  };
}
