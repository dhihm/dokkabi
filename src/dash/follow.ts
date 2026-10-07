import { statSync, watch, type FSWatcher, type Stats } from "node:fs";
import { basename, dirname } from "node:path";

export interface LogStamp {
  size: number;
  mtimeMs: number;
  ino: number;
}

export function stampLog(path: string): LogStamp | undefined {
  try {
    return toStamp(statSync(path));
  } catch {
    return undefined;
  }
}

export function stampChanged(prev: LogStamp | undefined, next: LogStamp | undefined): boolean {
  if (!prev && !next) {
    return false;
  }
  if (!prev || !next) {
    return true;
  }
  return prev.size !== next.size || prev.mtimeMs !== next.mtimeMs || prev.ino !== next.ino;
}

export function followLog(
  path: string,
  onChange: () => void,
  options: { intervalMs?: number } = {},
): () => void {
  const intervalMs = Math.max(20, options.intervalMs ?? 250);
  let last = stampLog(path);
  let closed = false;

  const check = () => {
    if (closed) {
      return;
    }
    const next = stampLog(path);
    if (!stampChanged(last, next)) {
      return;
    }
    last = next;
    onChange();
  };

  const timer = setInterval(check, intervalMs);
  let watcher: FSWatcher | undefined;
  try {
    const file = basename(path);
    watcher = watch(dirname(path), (_event, filename) => {
      if (filename != null && filename !== file && filename !== `${file}.lock`) {
        return;
      }
      check();
    });
  } catch {
    // Polling is enough when inotify is missing.
  }

  return () => {
    closed = true;
    clearInterval(timer);
    watcher?.close();
  };
}

function toStamp(st: Stats): LogStamp {
  return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
}
