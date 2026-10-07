// Downstream assets are rendered from original vector source, never upstream artwork.
import * as NodeModule from "node:module";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = NodeURL.fileURLToPath(new URL("..", import.meta.url));
// Reuse the repository's pinned image renderer from its declaring workspace.
const require = NodeModule.createRequire(NodePath.join(root, "apps/marketing/package.json"));
const sharp = require("sharp");
const svg = await NodeFSP.readFile(NodePath.join(root, "assets/dokkabi/app-icon.svg"));
const generated = new Map();
for (const [name, size] of [
  ["app-icon.png", 1024],
  ["favicon-16x16.png", 16],
  ["favicon-32x32.png", 32],
  ["apple-touch-icon.png", 180],
]) {
  generated.set(`assets/dokkabi/${name}`, await sharp(svg).resize(size, size).png().toBuffer());
}
const ico = encodePngIco(
  await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({
      size,
      contents: await sharp(svg).resize(size, size).png().toBuffer(),
    })),
  ),
);
generated.set("assets/dokkabi/app-icon.ico", ico);
for (const name of ["favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png"])
  generated.set(`apps/web/public/${name}`, generated.get(`assets/dokkabi/${name}`));
generated.set("apps/web/public/favicon.ico", ico);
const check = process.argv.includes("--check");
for (const [relative, bytes] of generated) {
  const target = NodePath.join(root, relative);
  if (check) {
    const actual = await NodeFSP.readFile(target);
    if (!actual.equals(bytes)) throw new Error(`Stale Dokkabi asset: ${relative}`);
  } else {
    await NodeFSP.writeFile(target, bytes);
  }
}
console.log(`${check ? "Verified" : "Rendered"} ${generated.size} Dokkabi assets.`);
