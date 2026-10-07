/** The offline suite may use local tools, but must not inherit operator credentials. */
const TEST_ENVIRONMENT_KEYS = new Set([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SHELL",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "TZ",
  "CC", "CXX", "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS", "SDKROOT", "DEVELOPER_DIR",
  "CPLUS_INCLUDE_PATH", "C_INCLUDE_PATH", "PKG_CONFIG_PATH", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_HOME", "RUSTUP_HOME", "BUN_INSTALL", "NODE_ENV", "CI",
  // Only explicit synthetic regression controls cross nested test processes.
  "DOKKABI_REGRESSION_FIXTURE_MODE", "DOKKABI_COMPILER_FIXTURE_MODE",
  "DOKKABI_PLATFORM_PRELOAD_RECEIPT", "DOKKABI_PLATFORM_PRELOAD_PID",
  "DOKKABI_PLATFORM_RUN_ID", "DOKKABI_PLATFORM_OBSERVATION_PATH", "DOKKABI_REAL_DOCKER_TEST",
]);

export function offlineTestEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(parent).filter((entry): entry is [string, string] => TEST_ENVIRONMENT_KEYS.has(entry[0]) && entry[1] !== undefined));
}
