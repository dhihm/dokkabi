import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A broken trust store fails as a network problem, and nothing says otherwise.
 *
 * On a corporate machine every HTTPS call to an internal host returned
 * `self-signed certificate in certificate chain`. The cause was not the
 * network and not the sandbox: two site CA files under
 * /usr/local/share/ca-certificates were named `.crt` but held DER, and
 * `update-ca-certificates` processes PEM only, so it skipped them in silence
 * and the site root never entered the system bundle.
 *
 * A second trap sat behind the first. The assembled bundle can contain a null
 * byte, and OpenSSL stops parsing there — so a bundle that looks long is
 * effectively short, and a check that only measures the file size agrees with
 * the machine that everything is fine.
 *
 * The harness cannot repair a trust store; that is the operator's system. What
 * it can do is refuse to let the failure arrive disguised. The bundle is read
 * once at boot, and what is wrong with it is said plainly, so a run that is
 * about to fail every fetch knows why.
 */

const BUNDLES: readonly string[] = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/cert.pem",
];

/** Where a distribution expects operator-added roots to be dropped. */
const LOCAL_SOURCES: readonly string[] = [
  "/usr/local/share/ca-certificates",
  "/etc/pki/ca-trust/source/anchors",
];

const PEM_BEGIN = "-----BEGIN CERTIFICATE-----";
/** Every DER certificate starts with a SEQUENCE tag. */
const DER_MAGIC = 0x30;

export interface CaTrustReport {
  /** The bundle that was read, or undefined when none of the paths exist. */
  readonly bundle?: string;
  /** PEM blocks the bundle actually offers a TLS client. */
  readonly certificates: number;
  /** Byte offset of a null that truncates parsing, when there is one. */
  readonly truncatedAt?: number;
  /** Operator-added files a PEM-only updater would skip without saying so. */
  readonly unconvertedDer: readonly string[];
  /** One line per problem, empty when the store looks usable. */
  readonly problems: readonly string[];
}

function countPem(text: string): number {
  let n = 0;
  let at = text.indexOf(PEM_BEGIN);
  while (at !== -1) {
    n += 1;
    at = text.indexOf(PEM_BEGIN, at + PEM_BEGIN.length);
  }
  return n;
}

/** Files named .crt whose first byte says DER, which a PEM-only tool skips. */
export function unconvertedDerSources(roots: readonly string[] = LOCAL_SOURCES): string[] {
  const found: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      if (!existsSync(root) || !statSync(root).isDirectory()) continue;
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".crt") && !entry.endsWith(".pem")) continue;
      const path = join(root, entry);
      try {
        const head = readFileSync(path).subarray(0, 1);
        if (head.length === 1 && head[0] === DER_MAGIC) found.push(path);
      } catch {
        // A file we cannot read is not a file we can judge.
      }
    }
  }
  return found;
}

/** Read the system trust store and say what is wrong with it, if anything. */
export function inspectCaTrust(bundles: readonly string[] = BUNDLES): CaTrustReport {
  const bundle = bundles.find((path) => existsSync(path));
  const unconvertedDer = unconvertedDerSources();
  const problems: string[] = [];

  if (!bundle) {
    problems.push("no system CA bundle found; every HTTPS call will fail to verify");
    return { certificates: 0, unconvertedDer, problems: Object.freeze(problems) };
  }

  let raw: Buffer;
  try {
    raw = readFileSync(bundle);
  } catch {
    problems.push(`CA bundle ${bundle} could not be read`);
    return { bundle, certificates: 0, unconvertedDer, problems: Object.freeze(problems) };
  }

  const nul = raw.indexOf(0);
  const usable = nul === -1 ? raw : raw.subarray(0, nul);
  const certificates = countPem(usable.toString("utf8"));

  if (nul !== -1) {
    problems.push(
      `CA bundle ${bundle} contains a null byte at ${nul}; OpenSSL stops parsing there, `
      + `so only ${certificates} of its certificates are usable`,
    );
  }
  if (certificates === 0) {
    problems.push(`CA bundle ${bundle} offers no usable certificate`);
  }
  if (unconvertedDer.length > 0) {
    problems.push(
      `${unconvertedDer.length} operator-added CA file(s) hold DER but are named for PEM, `
      + `so update-ca-certificates skipped them silently: ${unconvertedDer.join(", ")}`,
    );
  }

  return {
    bundle,
    certificates,
    ...(nul === -1 ? {} : { truncatedAt: nul }),
    unconvertedDer,
    problems: Object.freeze(problems),
  };
}
