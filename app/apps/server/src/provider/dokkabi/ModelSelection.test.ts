import { expect, test } from "vite-plus/test";
import { requestedDokkabiModel } from "./ModelSelection.ts";
import { goldenHandshakeResponse } from "./WorkbenchProtocol.testFixtures.ts";

test("model references preserve legacy peers and reject unknown or ambiguous bare identifiers", () => {
  expect(requestedDokkabiModel("glm-5.3", goldenHandshakeResponse)).toEqual({
    route: "glm",
    model: "glm-5.3",
  });
  expect(requestedDokkabiModel("claude/model", goldenHandshakeResponse)).toBeUndefined();
  const peer = {
    ...goldenHandshakeResponse,
    models: [
      {
        route: "nim",
        provider: "nvidia",
        model: "org/model",
        name: "NIM fixture",
        connected: true,
      },
      {
        route: "openrouter",
        provider: "openrouter",
        model: "org/model",
        name: "Router fixture",
        connected: true,
      },
    ],
  };
  expect(requestedDokkabiModel("nim/org/model", peer)).toEqual({
    route: "nim",
    model: "org/model",
  });
  expect(requestedDokkabiModel("org/model", peer)).toBeUndefined();
});
