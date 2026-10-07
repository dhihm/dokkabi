import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * #222 D4: a server names a document by URI (LSP) or absolute path
 * (tsserver). That name is data. It is honoured only when it resolves to a
 * regular file strictly inside the (real) workspace root without passing
 * through any link — every component from the root down is checked with
 * lstat — and then it must be a document the host itself sent (the caller
 * checks that). Everything else is refused with a reason.
 */

export type ContainmentRefusal =
  | "not_file_uri"
  | "malformed_uri"
  | "outside_root"
  | "link"
  | "not_regular_file"
  | "unreadable";

export type Containment =
  | { readonly ok: true; readonly rel: string; readonly abs: string }
  | { readonly ok: false; readonly reason: ContainmentRefusal };

export function containedFileFromUri(root: string, uri: unknown): Containment {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 4096 || uri.includes("\u0000")) return { ok: false, reason: "malformed_uri" };
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { ok: false, reason: "malformed_uri" };
  }
  if (url.protocol !== "file:") return { ok: false, reason: "not_file_uri" };
  if (url.host !== "" && url.host !== "localhost") return { ok: false, reason: "outside_root" };
  if (url.search !== "" || url.hash !== "") return { ok: false, reason: "malformed_uri" };
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return { ok: false, reason: "malformed_uri" };
  }
  return containedFile(root, path);
}

export function containedFile(root: string, path: unknown): Containment {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\u0000") || !isAbsolute(path)) {
    return { ok: false, reason: "malformed_uri" };
  }
  const abs = resolve(path);
  const inside = relative(root, abs);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { ok: false, reason: "outside_root" };
  const parts = inside.split(sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = `${current}${sep}${parts[index]}`;
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (stat.isSymbolicLink()) return { ok: false, reason: "link" };
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) return { ok: false, reason: "not_regular_file" };
  }
  return { ok: true, rel: parts.join("/"), abs };
}

export function fileUri(abs: string): string {
  return pathToFileURL(abs).href;
}
