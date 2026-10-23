import postgres, { type Sql } from 'postgres';
import type { Incident } from '@nexathon/contracts';

interface StoredIncident { incident_json: Incident; }
interface MemoryState {
  incidents: Map<string, Incident>;
  probeStreaks: Map<string, { consecutiveFailures: number; firstFailureAt?: string }>;
  rollbackAttempts: Set<string>;
  settings: Map<string, string>;
}
type StoreValue<T> = T | Promise<T>;

function memoryState(): MemoryState {
  return { incidents: new Map(), probeStreaks: new Map(), rollbackAttempts: new Set(), settings: new Map() };
}

export class IncidentStore {
  private readonly sql?: Sql;
  private readonly memory?: MemoryState;
  readonly ready: Promise<void>;

  constructor(connectionString = process.env.DATABASE_URL) {
    if (connectionString === ':memory:') {
      this.memory = memoryState();
      this.ready = Promise.resolve();
      return;
    }
    if (!connectionString) throw new Error('DATABASE_URL is required; PostgreSQL replaces the former SQLite store.');
    this.sql = postgres(connectionString, { max: 5, idle_timeout: 20 });
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.sql!`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        detected_at TEXT NOT NULL,
        incident_json JSONB NOT NULL
      )
    `;
    await this.sql!`CREATE INDEX IF NOT EXISTS incidents_detected_at_idx ON incidents (detected_at DESC)`;
    await this.sql!`
      CREATE TABLE IF NOT EXISTS probe_streaks (
        project_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        probe_path TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL,
        first_failure_at TEXT,
        PRIMARY KEY (project_id, deployment_id, probe_path)
      )
    `;
    await this.sql!`
      CREATE TABLE IF NOT EXISTS rollback_attempts (
        deployment_id TEXT PRIMARY KEY,
        attempted_at TEXT NOT NULL
      )
    `;
    await this.sql!`
      CREATE TABLE IF NOT EXISTS integration_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;
  }

  save(incident: Incident): StoreValue<void> {
    if (this.memory) {
      this.memory.incidents.set(incident.id, structuredClone(incident));
      return;
    }
    return this.sql!`
      INSERT INTO incidents (id, detected_at, incident_json)
      VALUES (${incident.id}, ${incident.detectedAt}, ${JSON.stringify(incident)}::jsonb)
      ON CONFLICT(id) DO UPDATE SET detected_at = EXCLUDED.detected_at, incident_json = EXCLUDED.incident_json
    `.then(() => undefined);
  }

  get(id: string): StoreValue<Incident | undefined> {
    if (this.memory) return this.memory.incidents.has(id) ? structuredClone(this.memory.incidents.get(id)!) : undefined;
    return this.sql!`SELECT incident_json FROM incidents WHERE id = ${id}`
      .then(rows => (rows[0] as StoredIncident | undefined)?.incident_json);
  }

  list(limit = 500): StoreValue<Incident[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
    if (this.memory) return [...this.memory.incidents.values()]
      .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt))
      .slice(0, boundedLimit)
      .map(incident => structuredClone(incident));
    return this.sql!`SELECT incident_json FROM incidents ORDER BY detected_at DESC LIMIT ${boundedLimit}`
      .then(rows => rows.map(row => (row as StoredIncident).incident_json));
  }

  recordProbe(
    projectId: string,
    deploymentId: string,
    probePath: string,
    result: 'pass' | 'fail' | 'unknown',
    at: string,
  ): StoreValue<{ consecutiveFailures: number; firstFailureAt?: string }> {
    const key = `${projectId}\0${deploymentId}\0${probePath}`;
    if (this.memory) {
      const current = this.memory.probeStreaks.get(key) ?? { consecutiveFailures: 0 };
      const next = result === 'fail'
        ? { consecutiveFailures: current.consecutiveFailures + 1, firstFailureAt: current.firstFailureAt ?? at }
        : { consecutiveFailures: 0 };
      this.memory.probeStreaks.set(key, next);
      return next;
    }
    const update = result === 'fail'
      ? this.sql!`
        INSERT INTO probe_streaks (project_id, deployment_id, probe_path, consecutive_failures, first_failure_at)
        VALUES (${projectId}, ${deploymentId}, ${probePath}, 1, ${at})
        ON CONFLICT(project_id, deployment_id, probe_path) DO UPDATE SET
          consecutive_failures = probe_streaks.consecutive_failures + 1,
          first_failure_at = COALESCE(probe_streaks.first_failure_at, EXCLUDED.first_failure_at)
      `
      : this.sql!`
        INSERT INTO probe_streaks (project_id, deployment_id, probe_path, consecutive_failures, first_failure_at)
        VALUES (${projectId}, ${deploymentId}, ${probePath}, 0, NULL)
        ON CONFLICT(project_id, deployment_id, probe_path) DO UPDATE SET consecutive_failures = 0, first_failure_at = NULL
      `;
    return update.then(async () => {
      const rows = await this.sql!`
        SELECT consecutive_failures, first_failure_at FROM probe_streaks
        WHERE project_id = ${projectId} AND deployment_id = ${deploymentId} AND probe_path = ${probePath}
      `;
      const row = rows[0] as { consecutive_failures: number; first_failure_at: string | null };
      return { consecutiveFailures: row.consecutive_failures, ...(row.first_failure_at ? { firstFailureAt: row.first_failure_at } : {}) };
    });
  }

  claimRollback(deploymentId: string, at: string): StoreValue<boolean> {
    if (this.memory) {
      if (this.memory.rollbackAttempts.has(deploymentId)) return false;
      this.memory.rollbackAttempts.add(deploymentId);
      return true;
    }
    return this.sql!`
      INSERT INTO rollback_attempts (deployment_id, attempted_at)
      VALUES (${deploymentId}, ${at}) ON CONFLICT(deployment_id) DO NOTHING RETURNING deployment_id
    `.then(rows => rows.length === 1);
  }

  readSettings(): StoreValue<Record<string, string>> {
    if (this.memory) return Object.fromEntries(this.memory.settings);
    return this.sql!`SELECT key, value FROM integration_settings`
      .then(rows => Object.fromEntries(rows.map(row => [String(row.key), String(row.value)])));
  }

  writeSettings(values: Record<string, string>): StoreValue<void> {
    if (this.memory) {
      for (const [key, value] of Object.entries(values)) this.memory.settings.set(key, value);
      return;
    }
    return Promise.all(Object.entries(values).map(([key, value]) => this.sql!`
      INSERT INTO integration_settings (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
    `)).then(() => undefined);
  }

  deleteSettings(keys: string[]): StoreValue<void> {
    if (this.memory) {
      for (const key of keys) this.memory.settings.delete(key);
      return;
    }
    if (keys.length === 0) return;
    return Promise.all(keys.map(key => this.sql!`DELETE FROM integration_settings WHERE key = ${key}`)).then(() => undefined);
  }

  async close(): Promise<void> {
    await this.sql?.end({ timeout: 5 });
  }
}
