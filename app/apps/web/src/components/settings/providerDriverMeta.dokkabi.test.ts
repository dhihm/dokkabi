import { describe, expect, it } from "vite-plus/test";
import { DokkabiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
} from "./ProviderSettingsForm";

describe("Dokkabi native setup admission", () => {
  it("offers the actual harness driver through the shared Add provider and settings registry", () => {
    const definition = getDriverOption(ProviderDriverKind.make("dokkabi"));
    expect(definition).toBeDefined();
    expect(DRIVER_OPTIONS.filter((entry) => entry.value === "dokkabi")).toHaveLength(1);
    expect(definition?.label).toBe("Dokkabi");
    expect(definition?.settingsSchema).toBe(DokkabiSettings);
  });

  it("exposes explicit external/bundled choices and accepts a bundled workspace without pairing fields", () => {
    const definition = getDriverOption(ProviderDriverKind.make("dokkabi"));
    expect(definition).toBeDefined();
    const fields = deriveProviderSettingsFields(definition!);
    expect(fields.map((field) => field.key)).toEqual([
      "runtimeMode",
      "gatewayUrl",
      "tokenEnv",
      "workspacePath",
    ]);
    const mode = fields.find((field) => field.key === "runtimeMode")!;
    expect(mode.control).toBe("select");
    expect(mode.options?.map((choice) => choice.value)).toEqual(["external", "bundled"]);
    const config = nextProviderConfigWithFieldValue(
      { workspacePath: "/Users/operator/work" },
      mode,
      "bundled",
    );
    expect(Schema.decodeUnknownSync(DokkabiSettings)(config)).toMatchObject({
      runtimeMode: "bundled",
      workspacePath: "/Users/operator/work",
      gatewayUrl: "",
      tokenEnv: "",
      enabled: false,
    });
    expect(fields.some((field) => field.key === "enabled")).toBe(false);
  });
});
