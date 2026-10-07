// @effect-diagnostics nodeBuiltinImport:off - Qualification compiles an owned synthetic source file.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// oxlint-disable t3code/no-global-process-runtime -- Native compilation is qualified on the actual host.
import { describe, expect, it } from "vite-plus/test";
import { nativeBuildEnvironment } from "./native-build-privacy.ts";

describe("native build privacy", () => {
  it("remaps C, C++ and Rust file paths without changing the input environment", () => {
    const original = { HOME: "/Users/operator", PATH: "/usr/bin", CFLAGS: "-O2" };
    const actual = nativeBuildEnvironment(original);
    expect(actual.CFLAGS).toBe("-O2 '-ffile-prefix-map=/Users/operator=/build'");
    expect(actual.CXXFLAGS).toBe("'-ffile-prefix-map=/Users/operator=/build'");
    expect(actual.CARGO_ENCODED_RUSTFLAGS).toBe("--remap-path-prefix=/Users/operator=/build");
    expect(actual.PATH).toBe(original.PATH);
    expect(original).toEqual({ HOME: "/Users/operator", PATH: "/usr/bin", CFLAGS: "-O2" });
  });

  it("preserves encoded Rust flags and an explicit toolchain HOME with spaces", () => {
    const actual = nativeBuildEnvironment({
      HOME: "/Users/Build Person",
      CARGO_ENCODED_RUSTFLAGS: "-C\u001fopt-level=2",
    });
    expect(actual.CARGO_ENCODED_RUSTFLAGS).toBe(
      "-C\u001fopt-level=2\u001f--remap-path-prefix=/Users/Build Person=/build",
    );
    expect(actual.CXXFLAGS).toBe("'-ffile-prefix-map=/Users/Build Person=/build'");
  });

  it("carries ordinary Rust flags into the encoded form without shell evaluation", () => {
    const actual = nativeBuildEnvironment({
      HOME: "/Users/Build'Person",
      RUSTFLAGS: "-C opt-level=1",
    });
    expect(actual.CARGO_ENCODED_RUSTFLAGS).toBe(
      "-C\u001fopt-level=1\u001f--remap-path-prefix=/Users/Build'Person=/build",
    );
    expect(actual.CFLAGS).toBe("'-ffile-prefix-map=/Users/Build'\\''Person=/build'");
  });

  it("refuses a missing or root build HOME instead of remapping every system path", () => {
    expect(() => nativeBuildEnvironment({})).toThrow("absolute non-root HOME");
    expect(() => nativeBuildEnvironment({ HOME: "/" })).toThrow("absolute non-root HOME");
    expect(() => nativeBuildEnvironment({ HOME: "relative" })).toThrow("absolute non-root HOME");
  });
});

it.runIf(process.platform === "darwin")(
  "removes a source root outside the isolated HOME from actual compiler output",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dokkabi-build-root-"));
    try {
      const home = join(root, "home");
      const sourceRoot = join(root, "source");
      await mkdir(home);
      await mkdir(sourceRoot);
      const source = join(sourceRoot, "privacy.c");
      const object = join(root, "privacy.o");
      await writeFile(source, "const char *compiled_source = __FILE__;\n");
      const env = nativeBuildEnvironment({ HOME: home }, [sourceRoot]);
      const flags = [...env.CFLAGS!.matchAll(/'([^']+)'/gu)].map((match) => match[1]!);
      execFileSync("clang", ["-g", ...flags, "-c", source, "-o", object]);
      const bytes = await readFile(object);
      expect(bytes.includes(Buffer.from(sourceRoot))).toBe(false);
      expect(bytes.includes(Buffer.from("/build/privacy.c"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("refuses unsafe remapping delimiters in explicit roots", () => {
  for (const root of ["/", "relative", "/build=elsewhere", "/bad\nroot"]) {
    expect(() => nativeBuildEnvironment({ HOME: "/build/home" }, [root])).toThrow("source root");
  }
});
