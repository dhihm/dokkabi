export type ScratchErrorCode =
  | "invalid_command"
  | "invalid_path"
  | "invalid_source"
  | "invalid_target"
  | "secret_detected"
  | "target_exists"
  | "invalid_plan"
  | "filesystem_changed"
  | "git_unavailable"
  | "resource_limit";

export class ScratchError extends Error {
  constructor(
    readonly code: ScratchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScratchError";
  }
}
