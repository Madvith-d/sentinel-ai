import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncidentStore } from './incident-store';
import { createIncidentApi } from './api';
import { startPollingWorker, type PollingWorker } from './worker';
import { VercelProvider } from './vercel-provider';
import { CoolifyProvider, RailwayProvider, RenderProvider } from './platform-providers';
import type { DeploymentProvider } from './monitor';
import { createControllerActions, type RemediationConfig } from './actions';
import { applyStoredSettings, createSettingsApi } from './settings';
import { exchangeGithubManifest, githubConnectPage, githubCredentials, githubStateOk } from './github-app';
import { pollVercelDevice, startVercelDevice } from './vercel-login';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databasePath = resolve(packageDirectory, process.env.INCIDENT_DB_PATH ?? './data/incidents.sqlite');
applyStoredSettings(databasePath);

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
  deploymentStatusIntervalMs: number;
  provider: DeploymentProvider;
  platform: string;
} | undefined;

if (monitorFlag === 'true') {
  const platform = (process.env.CONTROLLER_PLATFORM ?? 'vercel').toLowerCase();
  if (!['vercel', 'railway', 'render', 'coolify'].includes(platform)) throw new Error('CONTROLLER_PLATFORM must be vercel, railway, render, or coolify.');
  const projectId = platform === 'vercel' ? process.env.VERCEL_PROJECT_ID : platform === 'railway' ? process.env.RAILWAY_SERVICE_ID : platform === 'render' ? process.env.RENDER_SERVICE_ID : process.env.COOLIFY_APPLICATION_ID;
  if (!projectId) throw new Error(`Monitoring requires a configured ${platform} service/application ID.`);

  const rollbackEnabled = rollbackFlag === 'true';
  if (rollbackEnabled && process.env.CONTROLLER_ROLLBACK_PROJECT_ID !== projectId) {
    throw new Error('Rollback requires CONTROLLER_ROLLBACK_PROJECT_ID to exactly match the configured platform service/application ID.');
  }
  const pollIntervalMs = Number(process.env.CONTROLLER_POLL_INTERVAL_MS ?? 30_000);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1_000 || pollIntervalMs > 300_000) {
    throw new Error('CONTROLLER_POLL_INTERVAL_MS must be between 1000 and 300000.');
  }

  const productionUrl = platform === 'vercel' ? process.env.VERCEL_PRODUCTION_DOMAIN : platform === 'railway' ? process.env.RAILWAY_PRODUCTION_URL : platform === 'render' ? process.env.RENDER_PRODUCTION_URL : process.env.COOLIFY_PRODUCTION_URL;
  if (!productionUrl) throw new Error(`Monitoring requires a ${platform} public production URL.`);
  let provider: DeploymentProvider;
  if (platform === 'vercel') {
    const token = process.env.VERCEL_ACCESS_TOKEN;
    if (!token) throw new Error('Vercel monitoring requires VERCEL_ACCESS_TOKEN.');
    provider = new VercelProvider({ accessToken: token, projectId, productionDomain: productionUrl, teamId: process.env.VERCEL_TEAM_ID });
  } else if (platform === 'railway') {
    const token = process.env.RAILWAY_TOKEN; const railwayProjectId = process.env.RAILWAY_PROJECT_ID;
    if (!token || !railwayProjectId) throw new Error('Railway monitoring requires RAILWAY_TOKEN and RAILWAY_PROJECT_ID.');
    provider = new RailwayProvider({ token, projectId: railwayProjectId, serviceId: projectId, environmentId: process.env.RAILWAY_ENVIRONMENT_ID, productionUrl });
  } else if (platform === 'render') {
    const token = process.env.RENDER_API_KEY; const ownerId = process.env.RENDER_OWNER_ID;
    if (!token || !ownerId) throw new Error('Render monitoring requires RENDER_API_KEY and RENDER_OWNER_ID.');
    provider = new RenderProvider({ accessToken: token, serviceId: projectId, ownerId, productionUrl });
  } else {
    const token = process.env.COOLIFY_API_TOKEN; const baseUrl = process.env.COOLIFY_BASE_URL;
    if (!token || !baseUrl) throw new Error('Coolify monitoring requires COOLIFY_API_TOKEN and COOLIFY_BASE_URL.');
    provider = new CoolifyProvider({ accessToken: token, applicationId: projectId, baseUrl, productionUrl });
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
    deploymentStatusIntervalMs,
    provider,
    platform,
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
  console.info(`Monitoring enabled for configured ${config.platform} service ${config.projectId}; rollback ${config.rollbackEnabled ? 'enabled' : 'disabled'}.`);
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
