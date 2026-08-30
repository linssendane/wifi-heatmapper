/**
 * surveyLedger - append-only DuckDB ledger of survey measurements.
 *
 * The JSON files in data/surveys/ are app *state*: the client owns them, rewrites
 * them wholesale on every settings change, and a stale client can truncate one
 * (see the guard in api/settings/route.ts). They are not a durable record.
 *
 * This ledger is. Every observed change to a survey's points appends a row to
 * survey_events; nothing is ever UPDATEd or DELETEd. Removing a point in the UI
 * appends an 'delete' event rather than erasing history, so a wipe is always
 * recoverable by reading the ledger at an earlier seq.
 *
 * The database is opened and closed around each write so the file is never held
 * locked - you can query it from another process (e.g. the duckdb CLI) at any
 * time, including while a survey is running.
 */
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import path from "path";
import { mkdir } from "fs/promises";
import { getLogger } from "./logger";

const logger = getLogger("surveyLedger");

const SURVEYS_DIR = path.join(process.cwd(), "data", "surveys");
export const LEDGER_PATH = path.join(SURVEYS_DIR, "survey-ledger.duckdb");

const SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS survey_event_seq START 1;

CREATE TABLE IF NOT EXISTS survey_events (
  seq            BIGINT     DEFAULT nextval('survey_event_seq'),
  event_ts       TIMESTAMP  DEFAULT current_timestamp,
  event          VARCHAR    NOT NULL,   -- 'insert' | 'update' | 'delete'
  survey         VARCHAR    NOT NULL,   -- floorplan image name
  point_id       VARCHAR    NOT NULL,
  x              INTEGER,
  y              INTEGER,
  measured_at    TIMESTAMP,
  ssid           VARCHAR,
  bssid          VARCHAR,
  rssi           INTEGER,
  signal_pct     INTEGER,
  channel        INTEGER,
  band           DOUBLE,
  phy_mode       VARCHAR,
  tx_rate        INTEGER,
  tcp_down_mbps  DOUBLE,
  tcp_up_mbps    DOUBLE,
  udp_down_mbps  DOUBLE,
  udp_up_mbps    DOUBLE,
  udp_jitter_ms  DOUBLE,
  udp_lost       INTEGER,
  fingerprint    VARCHAR,               -- detects real changes vs no-op rewrites
  raw            JSON
);

-- Latest event per point, with deleted points dropped: the "live" survey.
CREATE OR REPLACE VIEW survey_points_current AS
SELECT * EXCLUDE (rn)
FROM (
  SELECT *, row_number() OVER (PARTITION BY survey, point_id ORDER BY seq DESC) AS rn
  FROM survey_events
)
WHERE rn = 1 AND event <> 'delete';
`;

type AnyPoint = Record<string, any>;

/** Pull the columns we promote out of a survey point's nested structure. */
function flatten(survey: string, p: AnyPoint) {
  const w = p.wifiData ?? {};
  const i = p.iperfData ?? {};
  const bps = (k: string) => {
    const v = i?.[k]?.bitsPerSecond;
    return typeof v === "number" ? v / 1e6 : null;
  };
  return {
    survey,
    point_id: String(p.id ?? ""),
    x: p.x ?? null,
    y: p.y ?? null,
    // point.timestamp is epoch ms; DuckDB wants a TIMESTAMP
    measured_at: p.timestamp ? new Date(p.timestamp).toISOString() : null,
    ssid: w.ssid ?? null,
    bssid: w.bssid ?? null,
    rssi: w.rssi ?? null,
    signal_pct: w.signalStrength ?? null,
    channel: w.channel ?? null,
    band: w.band ?? null,
    phy_mode: w.phyMode ?? null,
    tx_rate: w.txRate ?? null,
    tcp_down_mbps: bps("tcpDownload"),
    tcp_up_mbps: bps("tcpUpload"),
    udp_down_mbps: bps("udpDownload"),
    udp_up_mbps: bps("udpUpload"),
    udp_jitter_ms: i?.udpDownload?.jitterMs ?? null,
    udp_lost: i?.udpDownload?.lostPackets ?? null,
    raw: JSON.stringify(p),
  };
}

/** Stable identity of a point's contents, so unchanged rewrites append nothing. */
function fingerprint(flat: ReturnType<typeof flatten>): string {
  return JSON.stringify([
    flat.x,
    flat.y,
    flat.measured_at,
    flat.rssi,
    flat.signal_pct,
    flat.channel,
    flat.tcp_down_mbps,
    flat.tcp_up_mbps,
    flat.udp_down_mbps,
    flat.udp_up_mbps,
  ]);
}

async function open(): Promise<{
  instance: DuckDBInstance;
  connection: DuckDBConnection;
}> {
  await mkdir(SURVEYS_DIR, { recursive: true });
  const instance = await DuckDBInstance.create(LEDGER_PATH);
  const connection = await DuckDBConnection.create(instance);
  for (const stmt of SCHEMA.split(";")) {
    if (stmt.trim()) await connection.run(stmt);
  }
  return { instance, connection };
}

type LedgerCounts = { inserted: number; updated: number; deleted: number };

/**
 * Serialize every ledger write, process-wide.
 *
 * DuckDB takes an exclusive lock on the database file, and this module opens it
 * per write so the file is never held locked between calls. Two concurrent
 * writers therefore collide: the second open fails, and since ledger errors are
 * deliberately swallowed the measurement is dropped with only a log line. That
 * is exactly how Point_9 was lost on 2026-08-30 - it was written at the same
 * moment as Point_8 and never reached the ledger.
 *
 * The lock in api/settings/route.ts is per survey file and does not help here:
 * the ledger is a single file shared by every survey. This queue is the one
 * that matters, so keep it module-global.
 */
let ledgerQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = ledgerQueue.then(fn, fn);
  ledgerQueue = next.catch(() => undefined);
  return next;
}

/**
 * recordSurveyState() - append any change to a survey's points to the ledger.
 * Serialized against every other ledger write; never throws.
 */
export function recordSurveyState(
  survey: string,
  points: AnyPoint[],
): Promise<LedgerCounts> {
  return serialize(() => recordSurveyStateUnlocked(survey, points));
}

/**
 * recordSurveyStateUnlocked() - reconcile one survey's points against the ledger and
 * append an event for anything that changed.
 *
 * Called on every settings write. Never throws: the ledger is a safety net, and
 * a broken safety net must not take the app down with it.
 *
 * @param survey - floorplan image name, the survey's identity
 * @param points - the client's current surveyPoints array
 * @returns counts of appended events
 */
async function recordSurveyStateUnlocked(
  survey: string,
  points: AnyPoint[],
): Promise<LedgerCounts> {
  const result = { inserted: 0, updated: 0, deleted: 0 };
  if (!survey) return result;

  let db: Awaited<ReturnType<typeof open>> | null = null;
  try {
    db = await open();
    const { connection } = db;

    // Current ledger state for this survey
    const reader = await connection.runAndReadAll(
      `SELECT point_id, fingerprint, event FROM survey_points_current WHERE survey = ?`,
      [survey],
    );
    const known = new Map<string, string>();
    for (const row of reader.getRowObjectsJS() as AnyPoint[]) {
      known.set(String(row.point_id), String(row.fingerprint ?? ""));
    }

    const seen = new Set<string>();
    for (const p of points ?? []) {
      const flat = flatten(survey, p);
      if (!flat.point_id) continue;
      seen.add(flat.point_id);
      const fp = fingerprint(flat);
      const prior = known.get(flat.point_id);
      if (prior === fp) continue; // nothing changed - append nothing
      const event = prior === undefined ? "insert" : "update";
      await connection.run(
        `INSERT INTO survey_events
           (event, survey, point_id, x, y, measured_at, ssid, bssid, rssi,
            signal_pct, channel, band, phy_mode, tx_rate, tcp_down_mbps,
            tcp_up_mbps, udp_down_mbps, udp_up_mbps, udp_jitter_ms, udp_lost,
            fingerprint, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          event,
          flat.survey,
          flat.point_id,
          flat.x,
          flat.y,
          flat.measured_at,
          flat.ssid,
          flat.bssid,
          flat.rssi,
          flat.signal_pct,
          flat.channel,
          flat.band,
          flat.phy_mode,
          flat.tx_rate,
          flat.tcp_down_mbps,
          flat.tcp_up_mbps,
          flat.udp_down_mbps,
          flat.udp_up_mbps,
          flat.udp_jitter_ms,
          flat.udp_lost,
          fp,
          flat.raw,
        ],
      );
      if (event === "insert") result.inserted++;
      else result.updated++;
    }

    // Anything the ledger knows as live but the client no longer sends is a
    // soft delete. History stays; only the current view drops it.
    for (const point_id of known.keys()) {
      if (seen.has(point_id)) continue;
      await connection.run(
        `INSERT INTO survey_events (event, survey, point_id) VALUES ('delete', $1, $2)`,
        [survey, point_id],
      );
      result.deleted++;
    }

    if (result.inserted || result.updated || result.deleted) {
      logger.info(
        `ledger ${survey}: +${result.inserted} ~${result.updated} -${result.deleted}`,
      );
    }
  } catch (err) {
    logger.error(`ledger write failed for "${survey}": ${err}`);
  } finally {
    // Always release the file lock, even on failure, so the CLI can read it.
    try {
      db?.connection.closeSync();
      db?.instance.closeSync();
    } catch {
      // already closed
    }
  }
  return result;
}
