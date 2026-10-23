import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncidentStore } from './incident-store';
import { createIncidentApi } from './api';
import { ActivityHub } from './activity';
import { createActivityApi } from './activity-api';
import { dispatchRun } from './remediation';
import { startPollingWorker, type PollingWorker } from './worker';
import { VercelProvider } from './vercel-provider';
import { CoolifyProvider, RailwayProvider, RenderProvider } from './platform-providers';
import type { DeploymentProvider } from './monitor';
import { createControllerActions, type RemediationConfig } from './actions';
import { applyStoredSettings, createSettingsApi } from './settings';
import { disconnectFields, exchangeGithubManifest, githubConnectTarget, githubCredentials, githubStateOk, installationExists, listInstallationRepositories, matchingVercelProject, verifyGithubWebhook } from './github-app';
import { pollVercelDevice, startVercelDevice } from './vercel-login';
import { DashboardAuth } from './auth';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.DATABASE_URL;
const store = new IncidentStore(databaseUrl);
await store.ready;
await applyStoredSettings(store);

function publicOrigin(): string {
  const configured = process.env.CONTROLLER_PUBLIC_ORIGIN?.trim().replace(/\/$/, '');
  if (!configured) return `http://${host}:${port}`;
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('CONTROLLER_PUBLIC_ORIGIN must be an http(s) origin without credentials.');
  }
  return url.origin;
}

const host = process.env.CONTROLLER_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('CONTROLLER_HOST must be 127.0.0.1 or 0.0.0.0.');
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

type MonitorConfig = {
  projectId: string;
  rollbackEnabled: boolean;
  probePath: string;
  pollIntervalMs: number;
  deploymentStatusIntervalMs: number;
  provider: DeploymentProvider;
  platform: string;
};

function readMonitorConfig(): MonitorConfig {
  const platform = (process.env.CONTROLLER_PLATFORM ?? 'vercel').toLowerCase();
  if (!['vercel', 'railway', 'render', 'coolify'].includes(platform)) throw new Error('CONTROLLER_PLATFORM must be vercel, railway, render, or coolify.');
  const projectId = platform === 'vercel' ? process.env.VERCEL_PROJECT_ID : platform === 'railway' ? process.env.RAILWAY_SERVICE_ID : platform === 'render' ? process.env.RENDER_SERVICE_ID : process.env.COOLIFY_APPLICATION_ID;
  if (!projectId) throw new Error(`Monitoring requires a configured ${platform} service/application ID.`);
  const rollbackEnabled = process.env.CONTROLLER_ROLLBACK_ENABLED === 'true';
  if (rollbackEnabled && process.env.CONTROLLER_ROLLBACK_PROJECT_ID !== projectId) {
    throw new Error('Rollback requires CONTROLLER_ROLLBACK_PROJECT_ID to exactly match the configured platform service/application ID.');
  }
  const pollIntervalMs = Number(process.env.CONTROLLER_POLL_INTERVAL_MS ?? 30_000);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1_000 || pollIntervalMs > 300_000) {
    throw new Error('CONTROLLER_POLL_INTERVAL_MS must be between 1000 and 300000.');
  }
  const deploymentStatusIntervalMs = Number(process.env.CONTROLLER_DEPLOYMENT_STATUS_INTERVAL_MS ?? 60_000);
  if (!Number.isInteger(deploymentStatusIntervalMs) || deploymentStatusIntervalMs < 1_000 || deploymentStatusIntervalMs > 600_000) {
    throw new Error('CONTROLLER_DEPLOYMENT_STATUS_INTERVAL_MS must be between 1000 and 600000.');
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
  return { projectId, rollbackEnabled, probePath: process.env.CONTROLLER_PROBE_PATH ?? '/api/tasks', pollIntervalMs, deploymentStatusIntervalMs, provider, platform };
}

const monitorConfig = monitorFlag === 'true' ? readMonitorConfig() : undefined;

const dashboardAuth = new DashboardAuth(process.env.DASHBOARD_USERNAME ?? '', process.env.DASHBOARD_PASSWORD ?? '');
let remediation: RemediationConfig | undefined;
if (remediationFlag === 'true') {
  const required = ['REMEDIATOR_MODEL_ID', 'REMEDIATOR_MODEL_BASE_URL', 'REMEDIATOR_MODEL_API_KEY', 'E2B_REMEDIATOR_TEMPLATE'];
  const missing = required.filter(key => !process.env[key]);
  const githubAppReady = Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PEM && process.env.GITHUB_INSTALLATION_ID);
  if (!process.env.GITHUB_READ_TOKEN && !githubAppReady) missing.push('GITHUB_READ_TOKEN or a connected GitHub app');
  if (!process.env.REMEDIATOR_REPOSITORY) missing.push('REMEDIATOR_REPOSITORY');
  if (missing.length) throw new Error(`Remediation requires configuration: ${missing.join(', ')}.`);
  remediation = {
    repository: process.env.REMEDIATOR_REPOSITORY ?? '',
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
      githubReadToken: process.env.GITHUB_READ_TOKEN ?? 'github-app',
    },
    reproductionFixture: {
      path: process.env.REMEDIATOR_FIXTURE_PATH ?? 'apps/sample/tests/filter.repro.test.ts',
      sourceFile: resolve(packageDirectory, '..', '..', process.env.REMEDIATOR_FIXTURE_SOURCE ?? 'packages/remediator/fixtures/task-filter.repro.ts.txt'),
    },
  };
}
const hub = new ActivityHub({
  saveRun: run => { void Promise.resolve(store.saveAgentRun(run)).catch(() => undefined); },
  saveEvent: (runId, event) => { void Promise.resolve(store.saveAgentEvent(runId, event)).catch(() => undefined); },
});
const actions = createControllerActions({ slackWebhookUrl: process.env.SLACK_WEBHOOK_URL, remediation, settings: store }, hub);
const incidentApi = createIncidentApi(store);
const settingsApi = createSettingsApi(store);
const activityApi = createActivityApi({
  hub,
  loadRuns: () => Promise.resolve(store.listAgentRuns()),
  loadRun: id => Promise.resolve(store.getAgentRun(id)).then(run => run && {
    ...run,
    events: run.events.flatMap(event => {
      const phase = event.phase;
      const kind = event.kind;
      if (!['sandbox', 'checkout', 'setup', 'reproduction', 'agent', 'verification', 'patch'].includes(phase)) return [];
      if (!['stage', 'tool', 'message', 'usage', 'status'].includes(kind)) return [];
      return [{ seq: event.seq, at: event.at, phase: phase as 'agent', kind: kind as 'status', message: event.message }];
    }),
  }),
  lookupIncident: id => store.get(id),
  dispatch: (runId, incident, source) => dispatchRun(hub, runId, incident, source, remediation),
  token: process.env.NEXATHON_RUN_TOKEN,
  aiConfigured: Boolean(remediation),
});
const watch = {
  checkedAt: null as string | null,
  outcome: 'starting' as 'starting' | 'healthy' | 'failing' | 'incident' | 'unavailable',
  detail: 'Waiting for the first production check.',
  probePath: monitorConfig?.probePath ?? '/api/tasks',
  rollbackEnabled: Boolean(monitorConfig?.rollbackEnabled),
  intervalMs: monitorConfig?.pollIntervalMs ?? 30_000,
  failures: 0,
};

let vercelDevice: { code: string; expiresAt: number } | undefined;
let monitorWorker: PollingWorker | undefined;

function dashboardOrigin(): string {
  const configured = process.env.DASHBOARD_ORIGIN ?? 'http://127.0.0.1:5173';
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('DASHBOARD_ORIGIN must be an http(s) origin without credentials.');
  }
  return url.origin;
}

function launchMonitor(config: MonitorConfig): void {
  if (monitorWorker) return;
  watch.probePath = config.probePath;
  watch.rollbackEnabled = config.rollbackEnabled;
  watch.intervalMs = config.pollIntervalMs;
  monitorWorker = startPollingWorker({
    projectIds: [config.projectId],
    allowlistedProjectIds: config.rollbackEnabled ? new Set([config.projectId]) : new Set(),
    probePath: config.probePath,
    provider: config.provider,
    store,
    actions,
    intervalMs: config.pollIntervalMs,
    deploymentStatusIntervalMs: config.deploymentStatusIntervalMs,
    onResult: (_, result) => {
      watch.checkedAt = new Date().toISOString();
      if (result.action === 'monitor') {
        watch.failures = result.consecutiveFailures;
        watch.outcome = result.consecutiveFailures > 0 ? 'failing' : 'healthy';
        watch.detail = result.reason;
      } else if (result.action === 'incident') {
        watch.failures = 3;
        watch.outcome = 'incident';
        watch.detail = `${result.incident.status}: ${result.incident.evidence[0] ?? 'Incident recorded.'}`;
      } else {
        watch.failures = 0;
        watch.outcome = 'unavailable';
        watch.detail = result.reason;
        console.error(`Controller monitor unavailable: ${result.reason}`);
      }
      if (result.action === 'incident' && (!result.duplicate || result.updated)) {
        console.info(`Incident ${result.incident.id}: ${result.incident.status}`);
      }
    },
    onError: () => {
      watch.checkedAt = new Date().toISOString();
      watch.outcome = 'unavailable';
      watch.detail = 'The production check failed before a result was recorded.';
      console.error('Controller monitor cycle failed.');
    },
  });
  console.info(`Monitoring enabled for configured ${config.platform} service ${config.projectId}; rollback ${config.rollbackEnabled ? 'enabled' : 'disabled'}.`);
}

async function integrationRoutes(request: Request, settingsStore: typeof store): Promise<Response | null> {
  const url = new URL(request.url);
  const dashboard = dashboardOrigin();
  if (url.pathname === '/api/github/webhook' && request.method === 'POST') {
    const body = await request.text();
    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
    if (!secret) return Response.json({ error: 'GitHub webhook secret is not configured.' }, { status: 503 });
    if (!verifyGithubWebhook(body, request.headers.get('x-hub-signature-256'), secret)) {
      return Response.json({ error: 'GitHub webhook signature did not match.' }, { status: 401 });
    }
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/api/github/connect' && request.method === 'GET') {
    await applyStoredSettings(settingsStore);
    const target = githubConnectTarget(process.env.GITHUB_APP_SLUG, process.env.GITHUB_APP_ID);
    if ('error' in target) return Response.json({ error: target.error }, { status: 409 });
    return Response.redirect(target.redirect, 302);
  }
  if (url.pathname === '/api/github/repos' && request.method === 'GET') {
    await applyStoredSettings(settingsStore);
    const appId = process.env.GITHUB_APP_ID;
    const pem = process.env.GITHUB_APP_PEM;
    const installationId = process.env.GITHUB_INSTALLATION_ID;
    if (!appId || !pem || !installationId) return Response.json({ error: 'Give the GitHub bot access before choosing a repository.' }, { status: 409 });
    try {
      const repositories = await listInstallationRepositories(appId, pem, installationId);
      return Response.json({ repositories });
    } catch {
      return Response.json({ error: 'The GitHub bot could not list repositories.' }, { status: 502 });
    }
  }
  if (url.pathname === '/api/github/callback' && request.method === 'GET') {
    const returnedState = url.searchParams.get('state');
    if (returnedState && !githubStateOk(returnedState)) return Response.json({ error: 'GitHub connect state did not match.' }, { status: 400 });
    const code = url.searchParams.get('code');
    if (!code) return Response.json({ error: 'GitHub did not return an app code.' }, { status: 400 });
    try {
      const saved = await exchangeGithubManifest(code);
      await settingsStore.writeSettings(saved);
      const slug = saved.GITHUB_APP_SLUG;
      return Response.redirect(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`, 302);
    } catch {
      return Response.json({ error: 'GitHub app setup did not finish.' }, { status: 502 });
    }
  }
  if (url.pathname === '/api/github/installed' && request.method === 'GET') {
    const installationId = url.searchParams.get('installation_id');
    const appId = process.env.GITHUB_APP_ID;
    const pem = process.env.GITHUB_APP_PEM;
    if (!installationId || !/^\d+$/.test(installationId) || !appId || !pem) return Response.json({ error: 'GitHub installation id was missing.' }, { status: 400 });
    if (!await installationExists(appId, pem, installationId)) return Response.json({ error: 'That installation does not belong to the configured GitHub bot.' }, { status: 403 });
    await settingsStore.writeSettings({ GITHUB_INSTALLATION_ID: installationId });
    process.env.GITHUB_INSTALLATION_ID = installationId;
    return Response.redirect(`${dashboard}/?setup=github`, 302);
  }
  if (url.pathname === '/api/vercel/projects' && request.method === 'GET') {
    await applyStoredSettings(settingsStore);
    const token = process.env.VERCEL_ACCESS_TOKEN;
    if (!token) return Response.json({ error: 'Connect Vercel before listing projects.' }, { status: 409 });
    const headers = { Authorization: `Bearer ${token}` };
    try {
      let response = await fetch('https://api.vercel.com/v9/projects', { headers });
      if (!response.ok && process.env.VERCEL_TEAM_ID) {
        response = await fetch(`https://api.vercel.com/v9/projects?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}`, { headers });
      }
      if (!response.ok) return Response.json({ error: 'Vercel did not list projects.' }, { status: 502 });
      const body = await response.json() as { projects?: { id?: string; name?: string; accountId?: string; alias?: { domain?: string }[]; targets?: { production?: { alias?: string[] } } }[] };
      const projects = (body.projects ?? []).flatMap(project => {
        if (!project.id || !project.name) return [];
        const domains = [
          ...(project.targets?.production?.alias ?? []),
          ...(project.alias ?? []).flatMap(alias => alias.domain ? [alias.domain] : []),
        ];
        return [{ id: project.id, name: project.name, domains, teamId: project.accountId?.startsWith('team_') ? project.accountId : '' }];
      });
      const selected = matchingVercelProject(projects, process.env.VERCEL_PRODUCTION_DOMAIN ?? '');
      return Response.json({ projects, selected });
    } catch {
      return Response.json({ error: 'Vercel did not list projects.' }, { status: 502 });
    }
  }
  if (url.pathname === '/api/disconnect' && request.method === 'POST') {
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: 'Expected JSON.' }, { status: 400 }); }
    const provider = body && typeof body === 'object' && 'provider' in body ? (body as { provider?: unknown }).provider : undefined;
    if (provider !== 'github' && provider !== 'vercel') return Response.json({ error: 'Choose github or vercel to disconnect.' }, { status: 400 });
    const keys = [...disconnectFields[provider]];
    await settingsStore.deleteSettings(keys);
    for (const key of keys) delete process.env[key];
    if (provider === 'vercel') {
      await monitorWorker?.stop();
      monitorWorker = undefined;
      process.env.CONTROLLER_MONITOR_ENABLED = 'false';
      await settingsStore.writeSettings({ CONTROLLER_MONITOR_ENABLED: 'false' });
    }
    return Response.json({ ok: true, disconnected: provider });
  }
  if (url.pathname === '/api/monitor/start' && request.method === 'POST') {
    if (monitorWorker) return Response.json({ ok: true, already: true });
    await applyStoredSettings(settingsStore);
    if (!process.env.REMEDIATOR_REPOSITORY) return Response.json({ error: 'Choose a repository before starting the monitor.' }, { status: 400 });
    process.env.CONTROLLER_MONITOR_ENABLED = 'true';
    await settingsStore.writeSettings({ CONTROLLER_MONITOR_ENABLED: 'true' });
    try {
      launchMonitor(readMonitorConfig());
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'The monitor did not start.' }, { status: 400 });
    }
    return Response.json({ ok: true, started: true });
  }
  if (url.pathname === '/api/vercel/connect' && request.method === 'POST') {
    try {
      const device = await startVercelDevice();
      vercelDevice = { code: device.deviceCode, expiresAt: device.expiresAt };
      return Response.json({ userCode: device.userCode, verificationUri: device.verificationUri, intervalMs: device.intervalMs });
    } catch {
      return Response.json({ error: 'Vercel sign-in did not start.' }, { status: 502 });
    }
  }
  if (url.pathname === '/api/vercel/connect' && request.method === 'GET') {
    if (!vercelDevice || vercelDevice.expiresAt < Date.now()) return Response.json({ error: 'Start Vercel sign-in again.' }, { status: 404 });
    try {
      const result = await pollVercelDevice(vercelDevice.code);
      if (result.pending) return Response.json({ pending: true });
      if (!result.accessToken) return Response.json({ error: 'Vercel sign-in did not finish.' }, { status: 502 });
      await settingsStore.writeSettings({
        VERCEL_ACCESS_TOKEN: result.accessToken,
        ...(result.refreshToken ? { VERCEL_REFRESH_TOKEN: result.refreshToken } : {}),
      });
      process.env.VERCEL_ACCESS_TOKEN = result.accessToken;
      if (result.refreshToken) process.env.VERCEL_REFRESH_TOKEN = result.refreshToken;
      vercelDevice = undefined;
      return Response.json({ ok: true, restartRequired: true });
    } catch {
      return Response.json({ error: 'Vercel sign-in did not finish.' }, { status: 502 });
    }
  }
  return null;
}

const server = Bun.serve({
  hostname: host,
  port,
  fetch: async (request, bunServer) => {
    const url = new URL(request.url);
    const authResponse = await dashboardAuth.handle(request);
    if (authResponse) return authResponse;
    if (url.pathname.startsWith('/api/') && !dashboardAuth.isPublic(url.pathname) && !dashboardAuth.isAuthorized(request)) {
      return dashboardAuth.unauthorized();
    }
    const connect = await integrationRoutes(request, store);
    if (connect) return connect;
    const settingsResponse = await settingsApi(request);
    if (settingsResponse) return settingsResponse;
    if (url.pathname === '/api/watch') {
      if (request.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
      return Response.json({ ...watch, now: new Date().toISOString() });
    }
    return (await activityApi(request, bunServer)) ?? incidentApi(request);
  },
});
console.log(`Incident API listening on http://${server.hostname}:${server.port}`);
if (!process.env.NEXATHON_RUN_TOKEN) {
  console.info('Agent runs are read-only: set NEXATHON_RUN_TOKEN to allow the local CLI to start one.');
}

if (monitorConfig) launchMonitor(monitorConfig);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await monitorWorker?.stop();
  server.stop();
  await store.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void shutdown(); });
}
