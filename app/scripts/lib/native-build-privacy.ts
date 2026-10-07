/** Build-path remapping must preserve existing compiler and runtime settings. */
export function nativeBuildEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  sourceRoots: ReadonlyArray<string> = [],
): Record<string, string | undefined> {
  const normalize = (root: string | undefined, label: string): string => {
    const value = root?.replace(/\/+$/u, "");
    // Compiler prefix-map delimiters cannot represent control characters or '='.
    // eslint-disable-next-line no-control-regex
    if (!value || !value.startsWith("/") || /[\u0000-\u001f\u007f=]/u.test(value)) {
      throw new Error(`Native release builds require an absolute non-root ${label}.`);
    }
    return value;
  };
  const roots = [
    ...new Set([
      normalize(env.HOME, "HOME"),
      ...sourceRoots.map((root) => normalize(root, "source root")),
    ]),
  ];
  // The build HOME and source checkout can be unrelated. Remap both explicitly;
  // node-gyp shell quoting and Cargo's encoded form retain paths with spaces.
  const cFlags = roots.map(
    (root) => `'${`-ffile-prefix-map=${root}=/build`.replaceAll("'", "'\\''")}'`,
  );
  const rustFlags =
    env.CARGO_ENCODED_RUSTFLAGS !== undefined
      ? env.CARGO_ENCODED_RUSTFLAGS
      : (env.RUSTFLAGS?.trim().split(/\s+/u).filter(Boolean).join("\u001f") ?? "");
  return {
    ...env,
    CFLAGS: [env.CFLAGS, ...cFlags].filter(Boolean).join(" "),
    CXXFLAGS: [env.CXXFLAGS, ...cFlags].filter(Boolean).join(" "),
    CARGO_ENCODED_RUSTFLAGS: [
      rustFlags,
      ...roots.map((root) => `--remap-path-prefix=${root}=/build`),
    ]
      .filter(Boolean)
      .join("\u001f"),
  };
}
