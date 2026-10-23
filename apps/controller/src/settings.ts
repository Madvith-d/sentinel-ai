import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import type { IncidentStore } from './incident-store';

export interface SettingField {
  group: string;
  key: string;
  label: string;
  secret: boolean;
  hidden?: boolean;
}

export const settingFields: SettingField[] = [
  { group: 'Vercel', key: 'VERCEL_ACCESS_TOKEN', label: 'Access token (filled by Connect Vercel)', secret: true },
  { group: 'Vercel', key: 'VERCEL_REFRESH_TOKEN', label: 'Refresh token', secret: true },
  { group: 'Vercel', key: 'VERCEL_TEAM_ID', label: 'Team id', secret: false },
  { group: 'Vercel', key: 'VERCEL_PROJECT_ID', label: 'Project id', secret: false },
  { group: 'Vercel', key: 'CONTROLLER_ROLLBACK_PROJECT_ID', label: 'Rollback project id', secret: false, hidden: true },
  { group: 'Vercel', key: 'VERCEL_PRODUCTION_DOMAIN', label: 'Public site link (host only)', secret: false },
  { group: 'Vercel', key: 'CONTROLLER_PROBE_PATH', label: 'Probe path', secret: false },
  { group: 'Vercel', key: 'CONTROLLER_MONITOR_ENABLED', label: 'Monitoring (true/false)', secret: false },
  { group: 'Vercel', key: 'CONTROLLER_ROLLBACK_ENABLED', label: 'Rollback (true/false)', secret: false },
  { group: 'GitHub', key: 'GITHUB_APP_ID', label: 'App id (filled by Connect GitHub)', secret: false },
  { group: 'GitHub', key: 'GITHUB_APP_SLUG', label: 'App slug', secret: false },
  { group: 'GitHub', key: 'GITHUB_INSTALLATION_ID', label: 'Installation id', secret: false },
  { group: 'GitHub', key: 'GITHUB_APP_PEM', label: 'App private key', secret: true },
  { group: 'GitHub', key: 'GH_TOKEN', label: 'Personal token fallback for pull requests', secret: true },
  { group: 'GitHub', key: 'GITHUB_READ_TOKEN', label: 'Personal read-token fallback', secret: true },
  { group: 'GitHub', key: 'REMEDIATOR_REPOSITORY', label: 'Repository (owner/name)', secret: false },
  { group: 'GitHub', key: 'REMEDIATOR_ALLOWED_REPOSITORY', label: 'Allowed repository', secret: false, hidden: true },
  { group: 'Sandbox', key: 'E2B_API_KEY', label: 'E2B API key', secret: true },
  { group: 'Sandbox', key: 'E2B_REMEDIATOR_TEMPLATE', label: 'E2B template', secret: false },
  { group: 'Sandbox', key: 'CONTROLLER_REMEDIATION_ENABLED', label: 'Remediation (true/false)', secret: false },
  { group: 'Model', key: 'REMEDIATOR_MODEL_API_KEY', label: 'Model API key', secret: true },
  { group: 'Model', key: 'REMEDIATOR_MODEL_ID', label: 'Model id', secret: false },
  { group: 'Model', key: 'REMEDIATOR_MODEL_BASE_URL', label: 'Model base URL', secret: false },
  { group: 'Email', key: 'SMTP_HOST', label: 'SMTP host', secret: false },
  { group: 'Email', key: 'SMTP_PORT', label: 'SMTP port', secret: false },
  { group: 'Email', key: 'SMTP_SECURE', label: 'Implicit TLS (true/false)', secret: false },
  { group: 'Email', key: 'SMTP_USER', label: 'SMTP user', secret: false },
  { group: 'Email', key: 'SMTP_PASSWORD', label: 'SMTP password', secret: true },
  { group: 'Email', key: 'SMTP_FROM', label: 'From address', secret: false },
  { group: 'Email', key: 'SMTP_TO', label: 'To address', secret: false },
];

const allowed = new Set(settingFields.map(field => field.key));

export function applyStoredSettings(databasePath: string): void {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath, { create: true });
  database.exec('CREATE TABLE IF NOT EXISTS integration_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const rows = database.query('SELECT key, value FROM integration_settings').all() as Array<{ key: string; value: string }>;
  database.close();
  for (const row of rows) {
    if (allowed.has(row.key) && row.value) process.env[row.key] = row.value;
  }
}

export function createSettingsApi(store: Pick<IncidentStore, 'readSettings' | 'writeSettings'>) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== '/api/settings') return null;
    if (request.method === 'GET') {
      const saved = store.readSettings();
      return Response.json({
        restartRequired: true,
        fields: settingFields.filter(field => !field.hidden).map(field => {
          const value = saved[field.key] || process.env[field.key] || '';
          return {
            ...field,
            configured: Boolean(value),
            source: saved[field.key] ? 'saved' : value ? 'environment' : 'missing',
            value: field.secret ? '' : value,
          };
        }),
      });
    }
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Settings body must be JSON.' }, { status: 400 }); }
    const incoming = body && typeof body === 'object' && 'values' in body ? (body as { values?: unknown }).values : undefined;
    if (!incoming || typeof incoming !== 'object') return Response.json({ error: 'Expected { values }.' }, { status: 400 });
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (!allowed.has(key) || typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) next[key] = trimmed;
    }
    if (next.VERCEL_PRODUCTION_DOMAIN) {
      const raw = next.VERCEL_PRODUCTION_DOMAIN;
      if (raw.includes('://') || raw.includes('/')) {
        try {
          const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
          next.VERCEL_PRODUCTION_DOMAIN = url.hostname;
          if (url.pathname && url.pathname !== '/') next.CONTROLLER_PROBE_PATH = url.pathname;
        } catch { /* keep the typed value */ }
      }
    }
    if (next.REMEDIATOR_REPOSITORY) next.REMEDIATOR_ALLOWED_REPOSITORY = next.REMEDIATOR_REPOSITORY;
    if (next.VERCEL_PROJECT_ID) next.CONTROLLER_ROLLBACK_PROJECT_ID = next.VERCEL_PROJECT_ID;
    store.writeSettings(next);
    return Response.json({ ok: true, saved: Object.keys(next), restartRequired: true });
  };
}
