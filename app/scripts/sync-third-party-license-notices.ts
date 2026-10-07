// @effect-diagnostics nodeBuiltinImport:off - This is a build-time filesystem script.

import * as NodePath from "node:path";

import { syncThirdPartyLicenseNotices } from "./lib/third-party-licenses.ts";

import { validateBunLicenseNoticeDirectory } from "./stage-dokkabi-runtime.ts";

await validateBunLicenseNoticeDirectory(NodePath.resolve("licenses/bun/1.4.2"), "1.4.2");

const configFile = NodePath.resolve("third-party-licenses.config.json");

await syncThirdPartyLicenseNotices(configFile);
