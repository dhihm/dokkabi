/** Fixed-memory aggregation: never retain request tokens, addresses or paths. */
export class RejectionAudit {
  private ws = 0;
  private http = 0;
  private lastWrite = -Infinity;
  constructor(
    private readonly write: (counts: { ws: number; http: number }) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}
  reject(surface: "ws" | "http"): void {
    this[surface] = Math.min(Number.MAX_SAFE_INTEGER, this[surface] + 1);
    this.flush();
  }
  flush(force = false): void {
    const now = this.now();
    if ((!this.ws && !this.http) || (!force && now - this.lastWrite < 60000)) return;
    // Rate-limit attempts too: a full disk must not amplify every request.
    this.lastWrite = now;
    this.write({ ws: this.ws, http: this.http });
    this.ws = 0;
    this.http = 0;
    this.lastWrite = now;
  }
}
