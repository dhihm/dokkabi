import { describe, expect, it } from "vite-plus/test";
import fixture from "./retained.fixture.json";
import { resolveCodeFilePath, decodeCodeMaterial } from "./material";

describe("retained Code presentation boundary", () => {
  it("decodes actual cold host material without consulting source files", () => {
    const material = decodeCodeMaterial(fixture.body!);
    expect(material.graph.nodes.some((n) => n.name === "add")).toBe(true);
    expect(material.diff.files[0]?.textDiff.kind).toBe("exact");
    expect(material.coverage.coordinateSpace).toBe("sanitized_utf16_lines");
  });
  it("refuses duplicate graph ids and dangerous geometry instead of drawing invented structure", () => {
    const material = JSON.parse(fixture.body!.text);
    material.graph.nodes.push(material.graph.nodes[0]);
    expect(() =>
      decodeCodeMaterial({ ...fixture.body!, text: JSON.stringify(material) }),
    ).toThrow();
    material.graph.nodes.pop();
    material.graph.nodes[0].w = -1;
    expect(() =>
      decodeCodeMaterial({ ...fixture.body!, text: JSON.stringify(material) }),
    ).toThrow();
  });
  it("refuses a foreign session and broken relationship endpoint", () => {
    const material = JSON.parse(fixture.body!.text);
    material.sessionId = "foreign";
    expect(() =>
      decodeCodeMaterial({ ...fixture.body!, text: JSON.stringify(material) }),
    ).toThrow();
    material.sessionId = fixture.body!.reference.sessionId;
    material.graph.edges.push({ id: "bad", source: "missing", target: "missing", kind: "import" });
    expect(() =>
      decodeCodeMaterial({ ...fixture.body!, text: JSON.stringify(material) }),
    ).toThrow();
  });
});

it("does not reuse a file from a different historical capture", () => {
  const material = decodeCodeMaterial(fixture.body!);
  expect(resolveCodeFilePath(material, "removed-node", "not-in-this-capture.ts")).toBe("a.ts");
  expect(resolveCodeFilePath(material, "mod:.", null)).toBe("a.ts");
});
