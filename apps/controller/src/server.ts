import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncidentStore } from './incident-store';
import { createIncidentApi } from './api';
import { startPollingWorker, type PollingWorker } from './worker';
import { VercelProvider } from './vercel-provider';

const host = '127.0.0.1';
const port = Number(process.env.CONTROLLER_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('CONTROLLER_PORT must be a valid TCP port.');
}

const monitorFlag = process.env.CONTROLLER_MONITOR_ENABLED ?? 'false';
const rollbackFlag = process.env.CONTROLLER_ROLLBACK_ENABLED ?? 'false';
if (!['true', 'false'].includes(monitorFlag) || !['true', 'false'].includes(rollbackFlag)) {
  throw new Error('Controller enablement variables must be either true or false.');
}
if (rollbackFlag === 'true' && monitorFlag !== 'true') {
  throw new Error('Rollback cannot be enabled when monitoring is disabled.');
}

let monitorConfig: {
  projectId: string;
  rollbackEnabled: boolean;
  probePath: string;
  pollIntervalMs: number;
  provider: VercelProvider;
} | undefined;

if (monitorFlag === 'true') {
  const projectId = process.env.VERCEL_PROJECT_ID;
  const accessToken = process.env.VERCEL_ACCESS_TOKEN;
  const productionDomain = process.env.VERCEL_PRODUCTION_DOMAIN;
  if (!projectId || !accessToken || !productionDomain) {
    throw new Error('Monitoring requires VERCEL_PROJECT_ID, VERCEL_ACCESS_TOKEN, and VERCEL_PRODUCTION_DOMAIN.');
  }

  const rollbackEnabled = rollbackFlag === 'true';
  if (rollbackEnabled && process.env.CONTROLLER_ROLLBACK_PROJECT_ID !== projectId) {
    throw new Error('Rollback requires CONTROLLER_ROLLBACK_PROJECT_ID to exactly match VERCEL_PROJECT_ID.');
  }
  const pollIntervalMs = Number(process.env.CONTROLLER_POLL_INTERVAL_MS ?? 30_000);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1_000 || pollIntervalMs > 300_000) {
    throw new Error('CONTROLLER_POLL_INTERVAL_MS must be between 1000 and 300000.');
  }

  monitorConfig = {
    projectId,
    rollbackEnabled,
    probePath: process.env.CONTROLLER_PROBE_PATH ?? '/api/tasks',
    pollIntervalMs,
    provider: new VercelProvider({
      accessToken,
      projectId,
      productionDomain,
      teamId: process.env.VERCEL_TEAM_ID,
    }),
  };
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databasePath = resolve(packageDirectory, process.env.INCIDENT_DB_PATH ?? './data/incidents.sqlite');
const store = new IncidentStore(databasePath);
const server = Bun.serve({
  hostname: host,
  port,
  fetch: createIncidentApi(store),
});
console.log(`Incident API listening on http://${server.hostname}:${server.port}`);

let worker: PollingWorker | undefined;
if (monitorConfig) {
  const config = monitorConfig;
  worker = startPollingWorker({
    projectIds: [config.projectId],
    allowlistedProjectIds: config.rollbackEnabled ? new Set([config.projectId]) : new Set(),
    probePath: config.probePath,
    provider: config.provider,
    store,
    intervalMs: config.pollIntervalMs,
    onResult: (_, result) => {
      if (result.action === 'incident' && (!result.duplicate || result.updated)) {
        console.info(`Incident ${result.incident.id}: ${result.incident.status}`);
      } else if (result.action === 'unavailable') {
        console.error(`Controller monitor unavailable: ${result.reason}`);
      }
    },
    onError: () => console.error('Controller monitor cycle failed.'),
  });
  console.info(`Monitoring enabled for configured Vercel project ${config.projectId}; rollback ${config.rollbackEnabled ? 'enabled' : 'disabled'}.`);
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await worker?.stop();
  server.stop();
  store.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void shutdown(); });
}
