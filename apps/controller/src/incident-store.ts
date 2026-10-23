import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import type { Incident } from '@nexathon/contracts';

interface StoredIncident {
  incident_json: string;
}

export class IncidentStore {
  private readonly database: Database;

  constructor(path = 'incidents.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path, { create: true });
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        detected_at TEXT NOT NULL,
        incident_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS incidents_detected_at_idx ON incidents (detected_at DESC);
      CREATE TABLE IF NOT EXISTS probe_streaks (
        project_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        probe_path TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL,
        first_failure_at TEXT,
        PRIMARY KEY (project_id, deployment_id, probe_path)
      );
      CREATE TABLE IF NOT EXISTS rollback_attempts (
        deployment_id TEXT PRIMARY KEY,
        attempted_at TEXT NOT NULL
      );
    `);
  }

  save(incident: Incident): void {
    this.database.query(`
      INSERT INTO incidents (id, detected_at, incident_json)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        detected_at = excluded.detected_at,
        incident_json = excluded.incident_json
    `).run(incident.id, incident.detectedAt, JSON.stringify(incident));
  }

  get(id: string): Incident | undefined {
    const row = this.database.query('SELECT incident_json FROM incidents WHERE id = ?').get(id) as StoredIncident | null;
    return row ? JSON.parse(row.incident_json) as Incident : undefined;
  }

  list(limit = 500): Incident[] {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
    const rows = this.database.query(
      'SELECT incident_json FROM incidents ORDER BY detected_at DESC LIMIT ?',
    ).all(boundedLimit) as StoredIncident[];
    return rows.map(row => JSON.parse(row.incident_json) as Incident);
  }

  recordProbe(
    projectId: string,
    deploymentId: string,
    probePath: string,
    result: 'pass' | 'fail' | 'unknown',
    at: string,
  ): { consecutiveFailures: number; firstFailureAt?: string } {
    if (result === 'fail') {
      this.database.query(`
        INSERT INTO probe_streaks (project_id, deployment_id, probe_path, consecutive_failures, first_failure_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(project_id, deployment_id, probe_path) DO UPDATE SET
          consecutive_failures = consecutive_failures + 1,
          first_failure_at = CASE
            WHEN consecutive_failures = 0 THEN excluded.first_failure_at
            ELSE first_failure_at
          END
      `).run(projectId, deploymentId, probePath, at);
    } else {
      this.database.query(`
        INSERT INTO probe_streaks (project_id, deployment_id, probe_path, consecutive_failures, first_failure_at)
        VALUES (?, ?, ?, 0, NULL)
        ON CONFLICT(project_id, deployment_id, probe_path) DO UPDATE SET
          consecutive_failures = 0,
          first_failure_at = NULL
      `).run(projectId, deploymentId, probePath);
    }

    const row = this.database.query(`
      SELECT consecutive_failures, first_failure_at FROM probe_streaks
      WHERE project_id = ? AND deployment_id = ? AND probe_path = ?
    `).get(projectId, deploymentId, probePath) as { consecutive_failures: number; first_failure_at: string | null };
    return {
      consecutiveFailures: row.consecutive_failures,
      ...(row.first_failure_at ? { firstFailureAt: row.first_failure_at } : {}),
    };
  }

  claimRollback(deploymentId: string, at: string): boolean {
    const result = this.database.query(
      'INSERT OR IGNORE INTO rollback_attempts (deployment_id, attempted_at) VALUES (?, ?)',
    ).run(deploymentId, at);
    return result.changes === 1;
  }

  close(): void {
    this.database.close();
  }
}
