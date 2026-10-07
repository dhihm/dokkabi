// @vitest-environment jsdom
import { act, useState, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { CodeMaterial } from "./material";
vi.mock("~/presentationStore", () => ({ usePresentationState: () => null }));
import { CodeCanvas } from "./CodeCanvas";

let root: Root;
let container: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let onCamera: ReturnType<typeof vi.fn<(value: SetStateAction<typeof camera>) => void>>;
const material = { graph: { nodes: [], edges: [] } } as unknown as CodeMaterial;
const camera = { x: 0, y: 0, scale: 2 };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let next = 1;
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(next, fn);
    return next++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width: 600, height: 400 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onCamera = vi.fn<(value: SetStateAction<typeof camera>) => void>();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(value = camera, source = material) {
  await act(async () =>
    root.render(
      <CodeCanvas
        material={source}
        selected={null}
        onSelect={() => {}}
        camera={value}
        onCamera={onCamera}
        autoFit={false}
        onInitialize={() => {}}
      />,
    ),
  );
  const canvas = container.querySelector("[data-code-canvas]") as HTMLElement;
  canvas.setPointerCapture = vi.fn();
  return canvas;
}
function pointer(target: HTMLElement, type: string, x: number, y = 0) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}
async function frame() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((fn) => fn(16));
  });
}
test("120 pointer events coalesce into one frame and retain the last position", async () => {
  const canvas = await render();
  await act(async () => {
    pointer(canvas, "pointerdown", 0);
    for (let i = 1; i <= 120; i++) pointer(canvas, "pointermove", i, i * 2);
  });
  expect(onCamera).toHaveBeenCalledTimes(0);
  expect(frames.size).toBe(1);
  await frame();
  expect(onCamera).toHaveBeenCalledExactlyOnceWith({ x: -60, y: -120, scale: 2 });
});
test.each(["pointercancel", "lostpointercapture"])(
  "%s retains the accepted last movement",
  async (type) => {
    const canvas = await render();
    await act(async () => {
      pointer(canvas, "pointerdown", 0);
      pointer(canvas, "pointermove", 12);
      pointer(canvas, type, 0);
    });
    expect(onCamera).toHaveBeenCalledExactlyOnceWith({ x: -6, y: 0, scale: 2 });
    expect(frames.size).toBe(0);
  },
);
test("external camera replacement discards the pending gesture", async () => {
  const canvas = await render();
  await act(async () => {
    pointer(canvas, "pointerdown", 0);
    pointer(canvas, "pointermove", 12);
  });
  await render({ x: 100, y: 50, scale: 1 });
  await frame();
  expect(onCamera).not.toHaveBeenCalled();
});
test("new material cancels pending movement even when camera is unchanged", async () => {
  const canvas = await render();
  await act(async () => {
    pointer(canvas, "pointerdown", 0);
    pointer(canvas, "pointermove", 12);
  });
  await render(camera, { ...material });
  await frame();
  expect(onCamera).not.toHaveBeenCalled();
});
test("unmount cancels pending updates without publishing to the parent", async () => {
  const canvas = await render();
  await act(async () => {
    pointer(canvas, "pointerdown", 0);
    pointer(canvas, "pointermove", 12);
    root.render(null);
  });
  await frame();
  expect(onCamera).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});
test("pointerup includes its last position and leaves no stale frame", async () => {
  const canvas = await render();
  await act(async () => {
    pointer(canvas, "pointerdown", 0);
    pointer(canvas, "pointermove", 10);
    pointer(canvas, "pointerup", 20);
  });
  expect(onCamera).toHaveBeenCalledExactlyOnceWith({ x: -10, y: 0, scale: 2 });
  expect(frames.size).toBe(0);
  await frame();
  expect(onCamera).toHaveBeenCalledTimes(1);
});

test("parent camera commits preserve a continuing drag across frames", async () => {
  function Harness() {
    const [value, setValue] = useState(camera);
    return (
      <CodeCanvas
        material={material}
        selected={null}
        onSelect={() => {}}
        camera={value}
        onCamera={(next) => {
          onCamera(next);
          setValue(next);
        }}
        autoFit={false}
        onInitialize={() => {}}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  const canvas = container.querySelector("[data-code-canvas]") as HTMLElement;
  canvas.setPointerCapture = vi.fn();
  await act(async () => {
    pointer(canvas, "pointerdown", 0);
    pointer(canvas, "pointermove", 10);
  });
  await frame();
  await act(async () => pointer(canvas, "pointermove", 20));
  await frame();
  await act(async () => pointer(canvas, "pointerup", 30));
  expect(onCamera.mock.calls.map(([value]) => value)).toEqual([
    { x: -5, y: 0, scale: 2 },
    { x: -10, y: 0, scale: 2 },
    { x: -15, y: 0, scale: 2 },
  ]);
  expect(container.querySelector("svg g")!.getAttribute("transform")).toContain("translate(15 0)");
});

test.each(["Zoom in", "Zoom out"])(
  "%s cancels an outstanding pan before applying zoom",
  async (label) => {
    const canvas = await render();
    await act(async () => {
      pointer(canvas, "pointerdown", 0);
      pointer(canvas, "pointermove", 12);
      (container.querySelector(`[aria-label='${label}']`) as HTMLElement).click();
    });
    expect(onCamera).toHaveBeenCalledTimes(1);
    const update = onCamera.mock.calls[0]![0];
    if (typeof update !== "function")
      throw new Error("Zoom must preserve the committed camera origin.");
    expect(update(camera)).toEqual({ ...camera, scale: label === "Zoom in" ? 2.5 : 1.6 });
    await frame();
    expect(onCamera).toHaveBeenCalledTimes(1);
  },
);

const populated = {
  graph: {
    nodes: [{ id: "node", kind: "file", name: "a.ts", path: "a.ts", x: 0, y: 0, w: 240, h: 76 }],
    edges: [],
  },
} as unknown as CodeMaterial;

test("Fit graph cancels a pending pan and retains only the fitted camera", async () => {
  const canvas = await render(camera, populated);
  await act(async () => {
    pointer(canvas, "pointerdown", 0);
    pointer(canvas, "pointermove", 12);
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Fit graph")!
      .click();
  });
  expect(onCamera).toHaveBeenCalledTimes(1);
  expect(onCamera.mock.calls[0]![0]).toEqual({ x: -8, y: -8, scale: 2.5 });
  await frame();
  expect(onCamera).toHaveBeenCalledTimes(1);
});

test("memoized nodes keep keyboard selection and the latest committed callback", async () => {
  const oldSelect = vi.fn();
  const nextSelect = vi.fn();
  const show = (onSelect: (id: string) => void) => (
    <CodeCanvas
      material={populated}
      selected={null}
      onSelect={onSelect}
      camera={camera}
      onCamera={onCamera}
      autoFit={false}
      onInitialize={() => {}}
    />
  );
  await act(async () => root.render(show(oldSelect)));
  await act(async () => root.render(show(nextSelect)));
  const node = container.querySelector("[data-code-node]")!;
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " }));
  });
  expect(oldSelect).not.toHaveBeenCalled();
  expect(nextSelect.mock.calls).toEqual([["node"], ["node"]]);
  expect(onCamera).not.toHaveBeenCalled();
});
