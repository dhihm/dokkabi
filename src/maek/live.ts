import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { BlobStore } from "../host/blob-store.ts";
import { canonicalJson } from "../host/canonical.ts";
import { assertNoSecrets } from "../host/redact.ts";
import type { EventLog } from "../host/event-log.ts";
import { clearDerivedRows, insertObservation, type SqlExec } from "./db-store.ts";
import { asDecision, asFault, clampLimit, digestQuery, digestRows } from "./hash.ts";
import { createHostObservationProducer } from "./host-producer.ts";
import {
  MaekIntegrityError,
  observationKey,
  observationPayload,
  recordedObservations,
} from "./ingest.ts";
import { SCHEMA_SQL } from "./sql.ts";
import type { FaultRecord, MaekObservation, MaekService } from "./types.ts";

const QUERY_CACHE_LIMIT = 64;

export function createLiveMaek(input: {
  log: EventLog;
  sessionId: string;
  dbPath: string;
  /** Narrow diagnostic hook used by deterministic performance regressions. */
  observeSql?: (sql: string) => void;
}): MaekService & { ready(): Promise<void> } {
  const dbExisted = existsSync(input.dbPath);
  mkdirSync(dirname(input.dbPath), { recursive: true, mode: 0o700 });
  const connecting = DuckDBInstance.create(input.dbPath).then(async (instance) => ({
    instance,
    connection: await instance.connect(),
  }));
  const store = BlobStore.forSession(input.log.path);
  const known = new Map<string, string>();
  const queryCache = new Map<string, string>();
  const producer = createHostObservationProducer({ sessionId: input.sessionId, store });
  let dataRevision = 0;
  let faultFtsReady = false;
  let decisionFtsReady = false;
  let initializationError: unknown;

  const exec: SqlExec = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    input.observeSql?.(sql);
    const { connection } = await connecting;
    const reader = await connection.runAndReadAll(sql, params as DuckDBValue[]);
    return reader.getRowObjects() as Record<string, unknown>[];
  };

  const appendFailure = (name: "rebuild" | "ingest" | "query", error: unknown, kind?: string): void => {
    input.log.append({
      kind: "observe",
      name: `maek/${name}_failed`,
      payload: {
        status: "failed",
        stage: error instanceof MaekIntegrityError ? error.stage : name,
        ...(error instanceof MaekIntegrityError && error.ingestSeq !== undefined
          ? { ingest_seq: error.ingestSeq }
          : {}),
        ...(kind ? { kind } : {}),
      },
    });
  };

  const accept = async (observation: MaekObservation, append: boolean): Promise<boolean> => {
    const key = observationKey(observation);
    const digest = digestRows(observation.row);
    const previous = known.get(key);
    if (previous !== undefined) {
      // Recorded rows are canonical. A newer host producer may derive a richer
      // representation for the same immutable source; do not rewrite legacy
      // evidence, while duplicate recorded rows must still agree byte-for-byte.
      if (!append && previous !== digest) {
        throw new MaekIntegrityError("duplicate_row");
      }
      return false;
    }
    if (append) {
      const payload = observationPayload(observation);
      assertNoSecrets(observation.row);
      if (observation.source.source_blob) {
        assertNoSecrets(store.get(observation.source.source_blob));
      }
      const recordedEvent = input.log.events.find((event) =>
        event.name === "maek/ingest"
        && event.payload.kind === observation.kind
        && event.payload.row_id === payload.row_id
      );
      if (recordedEvent) {
        // A previous attempt may have appended truth before its disposable SQL
        // insert failed. Validate and reuse that envelope instead of duplicating
        // it while the producer retries the same source prefix.
        const recorded = recordedObservations({
          events: input.log.events,
          sessionId: input.sessionId,
          store,
        }).filter((candidate) => observationKey(candidate) === key);
        if (recorded.length === 0 || recorded.some((candidate) => digestRows(candidate.row) !== digest)) {
          throw new MaekIntegrityError("duplicate_row", recordedEvent.seq);
        }
      } else {
        store.putAndAppend(
          input.log,
          { kind: "observe", name: "maek/ingest", payload },
          canonicalJson(observation.row),
        );
      }
    }
    await insertObservation(exec, observation);
    known.set(key, digest);
    dataRevision += 1;
    if (observation.kind === "decision") {
      decisionFtsReady = false;
    }
    if (observation.kind === "fault") {
      faultFtsReady = false;
    }
    return true;
  };

  const syncHostEvidence = async (refresh = true): Promise<{
    readonly added: number;
    readonly source: { readonly seq: number; readonly hash: string };
  }> => {
    try {
      if (refresh) input.log.refresh();
      // Freeze the prefix being projected before any asynchronous DuckDB
      // insert or derived maek/ingest append can interleave with another
      // writer. Rows returned by this sync are a function of this prefix.
      const source = { seq: input.log.lastSeq, hash: input.log.lastHash };
      let added = 0;
      const observations = producer.sync(input.log.events).observations;
      for (const observation of observations) {
        if (await accept(observation, true)) {
          added += 1;
        }
      }
      return { added, source };
    } catch (error) {
      // producer.sync() is speculative until every emitted row reaches the
      // derived store. Re-scan the immutable prefix on a later operation.
      producer.reset();
      appendFailure("ingest", error);
      throw error;
    }
  };

  const createFts = async (): Promise<void> => {
    await exec("INSTALL fts");
    await exec("LOAD fts");
    await exec("PRAGMA create_fts_index('mem_tool_faults', 'fault_id', 'fault_excerpt', overwrite=1)");
    await exec("PRAGMA create_fts_index('mem_decisions', 'decision_id', 'rationale', overwrite=1)");
    faultFtsReady = true;
    decisionFtsReady = true;
  };

  const initialize = async (): Promise<void> => {
    for (const sql of SCHEMA_SQL) {
      await exec(sql);
    }
    await clearDerivedRows(exec);
    input.log.refresh();
    const recorded = recordedObservations({ events: input.log.events, sessionId: input.sessionId, store });
    for (const observation of recorded) {
      await accept(observation, false);
    }
    await syncHostEvidence(false);
    try {
      await createFts();
    } catch (error) {
      throw new MaekIntegrityError("fts");
    }
    if (!dbExisted && recorded.length > 0) {
      input.log.append({
        kind: "observe",
        name: "maek/rebuild",
        payload: { status: "completed", rows: recorded.length },
      });
    }
    input.log.append({
      kind: "observe",
      name: "maek/ready",
      payload: {
        status: "ready",
        rows: known.size,
        source_seq: input.log.lastSeq,
        source_hash: input.log.lastHash,
      },
    });
  };

  const initialized = initialize().catch((error: unknown) => {
    initializationError = error;
    appendFailure("rebuild", error);
  });
  let chain: Promise<unknown> = initialized;
  const run = <T>(fn: () => Promise<T>, allowFailedInitialization = false): Promise<T> => {
    const next = chain.then(async () => {
      if (!allowFailedInitialization && initializationError !== undefined) {
        throw initializationError;
      }
      return fn();
    });
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const queryAndLog = async <T>(
    kind: string,
    query: string,
    options: unknown,
    rows: T[],
    source: { readonly seq: number; readonly hash: string },
  ): Promise<T[]> => {
    assertNoSecrets(rows);
    const result_digest = digestRows(rows);
    store.putAndAppend(
      input.log,
      {
        kind: "observe",
        name: "maek/query",
        payload: {
          format: 1,
          kind,
          query: digestQuery(kind, query, options),
          result_digest,
          row_count: rows.length,
          source_seq: source.seq,
          source_hash: source.hash,
        },
      },
      canonicalJson(rows),
    );
    return rows;
  };

  const cacheKey = (kind: string, query: string, options: unknown): string =>
    `${dataRevision}:${digestQuery(kind, query, options)}`;

  const cachedRows = <T>(key: string, read: (row: Record<string, unknown>) => T): T[] | undefined => {
    const bytes = queryCache.get(key);
    if (bytes === undefined) return undefined;
    // LRU touch. Parsed rows are newly allocated on every hit, so a caller
    // cannot mutate the bytes retained for the next query.
    queryCache.delete(key);
    queryCache.set(key, bytes);
    const parsed = JSON.parse(bytes) as unknown;
    if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
      throw new Error("invalid MAEK query cache rows");
    }
    return parsed.map(read);
  };

  const rememberRows = (key: string, rows: unknown[]): void => {
    queryCache.delete(key);
    queryCache.set(key, canonicalJson(rows));
    while (queryCache.size > QUERY_CACHE_LIMIT) {
      const oldest = queryCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      queryCache.delete(oldest);
    }
  };

  return {
    engine: "duckdb",
    ready() {
      return run(async () => undefined);
    },
    queryDecisions(text, options) {
      return run(async () => {
        try {
          const { source } = await syncHostEvidence();
          // The sync captured its input prefix before projection. Same-handle
          // or peer appends while DuckDB runs stay outside that snapshot.
          const key = cacheKey("decisions", text, options);
          const cached = cachedRows(key, asDecision);
          if (cached) return queryAndLog("decisions", text, options, cached, source);
          if (!decisionFtsReady) {
            await exec("PRAGMA create_fts_index('mem_decisions', 'decision_id', 'rationale', overwrite=1)");
            decisionFtsReady = true;
          }
          const params: unknown[] = [text];
          let sql =
            `SELECT decision_id, session_id, turn_id, symbol_id, decision_type, rationale, constraints,
                    fts_main_mem_decisions.match_bm25(decision_id, ?) AS score
               FROM mem_decisions
              WHERE score IS NOT NULL`;
          if (options?.symbolId) {
            sql += " AND symbol_id = ?";
            params.push(options.symbolId);
          }
          sql += " ORDER BY score DESC LIMIT ?";
          params.push(clampLimit(options?.limit));
          const raw = await exec(sql, params);
          const rows = raw.map(asDecision);
          const logged = await queryAndLog("decisions", text, options, rows, source);
          rememberRows(key, logged);
          return logged;
        } catch (error) {
          appendFailure("query", error, "decisions");
          throw error;
        }
      });
    },
    querySimilarFaults(query) {
      return run(async () => {
        try {
          const { source } = await syncHostEvidence();
          const key = cacheKey("faults", query.errorPattern, query);
          const cached = cachedRows(key, asFault);
          if (cached) return queryAndLog("faults", query.errorPattern, query, cached, source);
          if (!faultFtsReady) {
            await exec("PRAGMA create_fts_index('mem_tool_faults', 'fault_id', 'fault_excerpt', overwrite=1)");
            faultFtsReady = true;
          }
          const raw = await exec(
            `SELECT fault_id, command, command_digest, exit_code, fault_excerpt, blob_digest,
                    fts_main_mem_tool_faults.match_bm25(fault_id, ?) AS score
               FROM mem_tool_faults
              WHERE score IS NOT NULL
              ORDER BY score DESC
              LIMIT ?`,
            [query.errorPattern, clampLimit(query.limit)],
          );
          const rows: FaultRecord[] = raw.map(asFault);
          const logged = await queryAndLog("faults", query.errorPattern, query, rows, source);
          rememberRows(key, logged);
          return logged;
        } catch (error) {
          appendFailure("query", error, "faults");
          throw error;
        }
      });
    },
    ingest() {
      // A session that never queries and never restarts would otherwise stop
      // projecting at boot: syncHostEvidence only ran inside initialize and
      // the query paths. The work loop calls this at graph milestones so the
      // index keeps up with a long-running session (#109). refresh=false: the
      // caller's own log handle is the session writer, so its in-memory
      // prefix is current and a full-file re-read per milestone is waste;
      // peer appends catch up at the next boot or query.
      return run(async () => {
        const { added } = await syncHostEvidence(false);
        return added;
      }).catch((error: unknown) => {
        if (initializationError !== undefined && error === initializationError) {
          // run() rethrows the cached boot failure before syncHostEvidence
          // can record anything — without this, recall upkeep dies with a
          // single boot-time row and no per-milestone evidence.
          appendFailure("ingest", error);
          return 0;
        }
        throw error;
      });
    },
    close() {
      return run(
        async () => {
          const handles = await connecting.catch(() => undefined);
          if (!handles) return;
          handles.connection.closeSync();
          handles.instance.closeSync();
        },
        true,
      );
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
