import { statSync } from "node:fs";
import { projectDash, type DashProjection } from "./project.ts";
import { TailLog } from "./tail-log.ts";

/** One verified incremental projection per server, shared by its clients. */
export class SharedDashSnapshot {
  private signature = "";
  private size = -1;
  private identity = "";
  private tail: TailLog;
  private snapshot?: DashProjection;
  loads = 0;
  constructor(private readonly path: string, private readonly maxBytes = 128 * 1024 * 1024) {
    this.tail = new TailLog(path, Number.POSITIVE_INFINITY, maxBytes);
  }
  read(): DashProjection {
    let stat;
    try { stat = statSync(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const size = stat?.size ?? -1;
    if (stat && (!stat.isFile() || size > this.maxBytes)) throw new Error("dashboard log byte limit exceeded or not a regular file");
    const identity = stat ? `${stat.dev}:${stat.ino}` : "missing";
    const signature = `${identity}:${size}:${stat?.mtimeMs}:${stat?.ctimeMs}`;
    if (this.snapshot && signature === this.signature) return this.snapshot;
    if (identity !== this.identity || size <= this.size) this.tail = new TailLog(this.path, Number.POSITIVE_INFINITY, this.maxBytes);
    const { events } = this.tail.poll();
    const snapshot = projectDash(events);
    this.loads++;
    this.snapshot = snapshot;
    this.signature = signature;
    this.identity = identity;
    this.size = size;
    return snapshot;
  }
}
