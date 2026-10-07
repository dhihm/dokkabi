import { expect, test } from "vite-plus/test";
import { dokkabiModelsFromHandshake } from "./DokkabiDriver.ts";

test("the authenticated harness catalog exposes provider-qualified models beside the legacy selection", () => {
  const models = dokkabiModelsFromHandshake(
    "glm-5.3",
    [
      { route: "glm", provider: "zai", model: "glm-5.3", name: "GLM 5.3", connected: true },
      {
        route: "glm",
        provider: "zai",
        model: "glm-5.3-flash",
        name: "GLM 5.3 Flash",
        connected: true,
      },
      {
        route: "codex",
        provider: "openai-codex",
        model: "gpt-fixture",
        name: "Codex fixture",
        connected: false,
      },
      {
        route: "claude",
        provider: "anthropic",
        model: "claude-fixture",
        name: "Claude fixture",
        connected: true,
      },
    ],
    "glm",
  );
  expect(models.map((m) => m.slug)).toEqual([
    "glm-5.3",
    "glm/glm-5.3",
    "glm/glm-5.3-flash",
    "codex/gpt-fixture",
    "claude/claude-fixture",
  ]);
  expect(models.find((m) => m.slug === "codex/gpt-fixture")?.name).toContain("sign in");
  expect(models.filter((m) => m.isDefault).map((m) => m.slug)).toEqual(["glm-5.3"]);
});
