/**
 * One model-facing vocabulary for workspace path failures.
 *
 * A path can be wrong about exactly three things — it is outside the
 * workspace, it does not exist, or it is the wrong kind for the tool — plus
 * the boundary cases a workspace capability never serves (a symlink on the
 * way, a socket or FIFO). Before this module, the inspection tools folded all
 * of them into "path escapes the workspace or cannot be resolved", and a live
 * M3 run watched the model burn ten grep calls on files that were inside the
 * workspace because the refusal named the wrong condition. Every refusal now
 * names its condition so the next call can correct it:
 *
 *   <tool>: <path> is outside the workspace
 *   <tool>: <path> does not exist
 *   <tool>: <path> is a directory; <what the tool needs>
 *   <tool>: <path> is a file; <what the tool needs>
 *
 * The security checks that produce these are unchanged; only the
 * classification and the wording are shared.
 */
export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

/** The path resolves outside the workspace root, lexically or through a link. */
export function outsideWorkspaceError(tool: string, path: string): WorkspacePathError {
  return new WorkspacePathError(`${tool}: ${path} is outside the workspace`);
}

/** Nothing exists at the path as addressed. */
export function missingPathError(tool: string, path: string): WorkspacePathError {
  return new WorkspacePathError(`${tool}: ${path} does not exist`);
}

/** The path is a directory and the tool needs something else. */
export function directoryPathError(tool: string, path: string, needs: string): WorkspacePathError {
  return new WorkspacePathError(`${tool}: ${path} is a directory; ${needs}`);
}

/** The path is a file and the tool needs something else. */
export function filePathError(tool: string, path: string, needs: string): WorkspacePathError {
  return new WorkspacePathError(`${tool}: ${path} is a file; ${needs}`);
}

/**
 * A symlink on the way. The anchored file view never follows one, whichever
 * side of the workspace it points to, so this is a boundary refusal rather
 * than a kind classification.
 */
export function symlinkPathError(tool: string, path: string): WorkspacePathError {
  return new WorkspacePathError(`${tool}: ${path} crosses a symlink; the workspace file view never follows links`);
}

/** A socket, FIFO, or device: present, but neither a file nor a directory. */
export function unsupportedPathError(tool: string, path: string, needs: string): WorkspacePathError {
  return new WorkspacePathError(`${tool}: ${path} is not a regular file or directory; ${needs}`);
}

/**
 * The tool wrapper's catch-all: vocabulary errors already carry the tool
 * name; anything unexpected still gains the `<tool>: ` prefix.
 */
export function toolPathErrorText(tool: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof WorkspacePathError ? message : `${tool}: ${message}`;
}
