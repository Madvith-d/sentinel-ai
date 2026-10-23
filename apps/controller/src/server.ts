import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncidentStore } from './incident-store';
import { createIncidentApi } from './api';
import { startPollingWorker, type PollingWorker } from './worker';
import { VercelProvider } from './vercel-provider';
import { createControllerActions, type RemediationConfig } from './actions';

const host = '127.0.0.1';
const port = Number(process.env.CONTROLLER_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('CONTROLLER_PORT must be a valid TCP port.');
}

const monitorFlag = process.env.CONTROLLER_MONITOR_ENABLED ?? 'false';
const rollbackFlag = process.env.CONTROLLER_ROLLBACK_ENABLED ?? 'false';
const remediationFlag = process.env.CONTROLLER_REMEDIATION_ENABLED ?? 'false';
if (!['true', 'false'].includes(monitorFlag) || !['true', 'false'].includes(rollbackFlag)
  || !['true', 'false'].includes(remediationFlag)) {
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
  deploymentStatusIntervalMs: number;
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
  const deploymentStatusIntervalMs = Number(process.env.CONTROLLER_DEPLOYMENT_STATUS_INTERVAL_MS ?? 60_000);
  if (!Number.isInteger(deploymentStatusIntervalMs) || deploymentStatusIntervalMs < 1_000 || deploymentStatusIntervalMs > 600_000) {
    throw new Error('CONTROLLER_DEPLOYMENT_STATUS_INTERVAL_MS must be between 1000 and 600000.');
  }

  monitorConfig = {
    projectId,
    rollbackEnabled,
    probePath: process.env.CONTROLLER_PROBE_PATH ?? '/api/tasks',
    pollIntervalMs,
    deploymentStatusIntervalMs,
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
let remediation: RemediationConfig | undefined;
if (remediationFlag === 'true') {
  const required = ['REMEDIATOR_MODEL_ID', 'REMEDIATOR_MODEL_BASE_URL', 'REMEDIATOR_MODEL_API_KEY', 'GITHUB_READ_TOKEN', 'E2B_REMEDIATOR_TEMPLATE'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Remediation requires configuration: ${missing.join(', ')}.`);
  remediation = {
    repository: process.env.REMEDIATOR_REPOSITORY ?? 'iotserver24/nexathon',
    setupCommand: process.env.REMEDIATOR_SETUP_COMMAND ?? 'bun install --frozen-lockfile --filter ./apps/sample',
    reproduceCommand: process.env.REMEDIATOR_REPRODUCE_COMMAND ?? 'bun test apps/sample/tests/filter.repro.test.ts',
    testCommand: process.env.REMEDIATOR_TEST_COMMAND ?? 'bun run --cwd apps/sample test',
    buildCommand: process.env.REMEDIATOR_BUILD_COMMAND ?? 'bun run --cwd apps/sample build',
    provider: {
      modelName: process.env.REMEDIATOR_MODEL_NAME ?? 'dedicated-remediator',
      modelId: process.env.REMEDIATOR_MODEL_ID!,
      baseUrl: process.env.REMEDIATOR_MODEL_BASE_URL!,
      apiBackend: (process.env.REMEDIATOR_MODEL_API_BACKEND ?? 'responses') as RemediationConfig['provider']['apiBackend'],
      apiKey: process.env.REMEDIATOR_MODEL_API_KEY!,
      githubReadToken: process.env.GITHUB_READ_TOKEN!,
    },
    reproductionFixture: {
      path: process.env.REMEDIATOR_FIXTURE_PATH ?? 'apps/sample/tests/filter.repro.test.ts',
      sourceFile: resolve(packageDirectory, '..', '..', process.env.REMEDIATOR_FIXTURE_SOURCE ?? 'packages/remediator/fixtures/task-filter.repro.ts.txt'),
    },
  };
}
const actions = createControllerActions({ slackWebhookUrl: process.env.SLACK_WEBHOOK_URL, remediation });
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
    actions,
    intervalMs: config.pollIntervalMs,
    deploymentStatusIntervalMs: config.deploymentStatusIntervalMs,
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
