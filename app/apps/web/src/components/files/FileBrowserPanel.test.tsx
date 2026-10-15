import type { FileTree as FileTreeModel } from "@pierre/trees";
import { FileTree } from "@pierre/trees/react";
import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { act, type MouseEvent, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import FileBrowserPanel from "./FileBrowserPanel";

const directoryState = vi.hoisted(() => ({
  entries: [] as ProjectEntry[],
  load: vi.fn(async () => undefined),
  refresh: vi.fn(),
  ready: true,
  error: null as string | null,
  isPending: false,
}));

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({
    buildItems: () => [],
    activate: vi.fn(),
  }),
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({
  useWorkspaceMutationRefresh: () => undefined,
}));
vi.mock("./useDirectoryEntries", () => ({
  useDirectoryEntries: () => directoryState,
}));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: () => ({
    entries: [] as ProjectEntry[],
    truncated: false,
    error: null,
    isPending: false,
    searchedQuery: "",
    refresh: vi.fn(),
  }),
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

const environmentId = EnvironmentId.make("environment-file-browser-test");

const defaultEntries: ProjectEntry[] = [
  { path: "README.md", kind: "file" },
  { path: "docs", kind: "directory" },
  { path: "docs/guide.md", kind: "file" },
];

class TreeRow {
  constructor(readonly path: string) {}

  getAttribute(name: string) {
    return name === "data-item-path" ? this.path : null;
  }
}

describe("FileBrowserPanel file activation", () => {
  let renderer: ReactTestRenderer | undefined;

  const model = (): FileTreeModel => renderer!.root.findByType(FileTree).props.model;

  async function mount(
    props: Partial<Parameters<typeof FileBrowserPanel>[0]> & {
      onOpenFile: (relativePath: string) => void;
    },
  ) {
    await act(async () => {
      renderer = create(
        <FileBrowserPanel
          environmentId={environmentId}
          cwd="/repo"
          projectName="repo"
          selectedPath={null}
          selectedPathRevealId={0}
          workspaceMutationId={null}
          {...props}
        />,
      );
    });
  }

  async function activate(path: string, modifiers: Partial<MouseEvent<HTMLElement>> = {}) {
    const event = {
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      nativeEvent: { composedPath: () => [{}, new TreeRow(path), {}] },
      ...modifiers,
    } as MouseEvent<HTMLElement>;
    await act(async () => {
      renderer!.root
        .find((node) => String(node.type) === "file-tree-container")
        .props.onClickCapture?.(event);
      const tree = model();
      const item = tree.getItem(path)!;
      if (event.ctrlKey || event.metaKey) {
        item.toggleSelect();
      } else {
        for (const selected of tree.getSelectedPaths()) {
          if (selected !== path) tree.getItem(selected)?.deselect();
        }
        item.select();
      }
      item.focus();
      if ("toggle" in item && !event.ctrlKey && !event.metaKey && !event.shiftKey) item.toggle();
    });
  }

  beforeEach(() => {
    directoryState.entries = [...defaultEntries];
    directoryState.load.mockClear();
    directoryState.refresh.mockClear();
    directoryState.ready = true;
    directoryState.error = null;
    directoryState.isPending = false;
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("HTMLElement", TreeRow);
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("calls the latest onOpenFile callback when the prop updates without remounting", async () => {
    const staleOpened: string[] = [];
    const freshOpened: string[] = [];

    await mount({ onOpenFile: (path) => staleOpened.push(path) });
    await act(async () => {
      renderer!.update(
        <FileBrowserPanel
          environmentId={environmentId}
          cwd="/repo"
          projectName="repo"
          selectedPath={null}
          selectedPathRevealId={0}
          workspaceMutationId={null}
          onOpenFile={(path) => freshOpened.push(path)}
        />,
      );
    });

    await activate("README.md");

    expect(staleOpened).toEqual([]);
    expect(freshOpened).toEqual(["README.md"]);
  });

  it("re-opens the sole selected file when clicked again", async () => {
    const opened: string[] = [];
    await mount({ onOpenFile: (path) => opened.push(path) });

    await activate("README.md");
    expect(model().getSelectedPaths()).toEqual(["README.md"]);
    await activate("README.md");

    expect(opened).toEqual(["README.md", "README.md"]);
  });

  it.each(["ctrlKey", "metaKey"] as const)(
    "does not open a selected file when a %s click deselects it",
    async (modifier) => {
      const opened: string[] = [];
      await mount({ onOpenFile: (path) => opened.push(path) });

      await activate("README.md");
      await activate("README.md", { [modifier]: true });

      expect(model().getSelectedPaths()).toEqual([]);
      expect(opened).toEqual(["README.md"]);
    },
  );
});
