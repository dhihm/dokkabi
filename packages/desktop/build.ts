import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");

if (!existsSync(dist)) {
  mkdirSync(dist, { recursive: true });
}

// 1. Bundle TypeScript frontend to dist/main.js
const res = await Bun.build({
  entrypoints: [join(root, "src", "main.ts")],
  outdir: dist,
  minify: true,
});

if (!res.success) {
  console.error("Build failed", res.logs);
  process.exit(1);
}

// 2. Prepare index.html with referenced main.js
let html = readFileSync(join(root, "index.html"), "utf-8");
html = html.replace('src="/src/main.ts"', 'src="/main.js"');
writeFileSync(join(dist, "index.html"), html);

console.log("Built desktop frontend in dist/");
