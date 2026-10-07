#!/usr/bin/env bun
import { offlineTestEnvironment } from "./test-environment.ts";

const child = Bun.spawn([process.execPath, "--no-env-file", "test", "--timeout=30000", ...Bun.argv.slice(2)], {
  env: offlineTestEnvironment(process.env),
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
