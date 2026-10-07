import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { PromotionError } from "./source-cas.ts";

export function validatePromotionTarget(root: string, path: string): string {
  if (!path || isAbsolute(path) || normalize(path) !== path
    || path.split("/").some((segment) => segment === ".." || segment === ".git")) {
    throw new PromotionError("unsafe_target");
  }
  const target = resolve(root, path);
  const escaped = relative(root, target);
  if (!escaped || escaped.startsWith("../") || isAbsolute(escaped)) throw new PromotionError("unsafe_target");
  let parent = dirname(target);
  while (parent !== root) {
    if (existsSync(parent) && !lstatSync(parent).isDirectory()) throw new PromotionError("unsafe_target");
    parent = dirname(parent);
  }
  if (!existsSync(target)) return target;
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.nlink !== 1) throw new PromotionError("unsafe_target");
  return target;
}
