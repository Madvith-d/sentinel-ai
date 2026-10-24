import { describe, expect, it } from 'bun:test';
import { VercelProvider } from '../src/vercel-provider';
import type { DeploymentSummary } from '../src/monitor';

const projectId = 'prj_demo';
const token = 'test-vercel-token';
const currentDeployment = {
  uid: 'dpl_current', projectId, target: 'production', readyState: 'READY',
  url: 'demo-current.vercel.app', createdAt: Date.parse('2026-10-23T12:00:00Z'),
  meta: { githubCommitSha: 'abc1234' },
};
const previousDeployment = {
  uid: 'dpl_previous', projectId, target: 'production', readyState: 'READY',
  url: 'demo-previous.vercel.app', createdAt: Date.parse('2026-10-23T11:00:00Z'),
  meta: { githubCommitSha: 'def5678' },
};
const failedDeployment = {
  uid: 'dpl_failed', projectId, target: 'production', readyState: 'ERROR',
  url: 'demo-failed.vercel.app', createdAt: Date.parse('2026-10-23T12:01:00Z'),
  meta: { githubCommitSha: 'fedcba0' },
};

function mockProvider(options: { rateLimited?: boolean } = {}) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const rateHeaders: Record<string, string> = options.rateLimited
    ? { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': '1792800000' }
    : {};
  const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url, init });
    if (url.hostname !== 'api.vercel.com') return new Response(null, { status: 200 });

    if (url.pathname === '/v4/aliases') {
      if (url.searchParams.has('domain')) return Response.json({ aliases: [] });
      return Response.json({ aliases: [
        { alias: 'demo.example.com', deploymentId: 'dpl_current', projectId },
        { alias: 'other.example.com', deploymentId: 'dpl_other', projectId },
      ] }, { headers: rateHeaders });
    }
    if (url.pathname === '/v13/deployments/dpl_current') return Response.json(currentDeployment);
    if (url.pathname === '/v13/deployments/dpl_previous') return Response.json(previousDeployment);
    if (url.pathname === '/v6/deployments') return Response.json({ deployments: [currentDeployment, previousDeployment] });
    if (url.pathname === '/v7/deployments') return Response.json({ deployments: [currentDeployment, previousDeployment] }, { headers: rateHeaders });
    if (url.pathname === '/v1/projects/prj_demo/deployments/dpl_current/runtime-logs') {
      return new Response([
        JSON.stringify({ rowId: 'log-1', level: 'info', message: 'request completed', responseStatusCode: 200, timestampInMs: 1 }),
        JSON.stringify({ rowId: 'log-2', level: 'error', message: 'database password=secret', responseStatusCode: 500, timestampInMs: 2 }),
      ].join('\n'), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/v3/deployments/dpl_current/events') {
      return new Response([
        JSON.stringify({ id: 'ev-1', text: 'Running build in Washington, D.C., USA (East) – iad1', type: 'stdout', created: 10 }),
        JSON.stringify({ id: 'ev-2', text: 'build aborted password=secret', type: 'stderr', created: 20 }),
        JSON.stringify({ id: 'ev-3', text: 'Build failed', type: 'error', created: 30 }),
      ].join('\n'), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/v1/projects/prj_demo/rollback/dpl_previous') return Response.json({}, { status: 201 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const provider = new VercelProvider({
    accessToken: token,
    projectId,
    productionDomain: 'demo.example.com',
    fetch: fetchMock,
  });
  return { provider, calls };
}

describe('VercelProvider', () => {
  it('resolves the active alias and immediate older production candidate', async () => {
    const { provider, calls } = mockProvider();
    const current = await provider.getProductionDeployment(projectId);
    expect(current?.id).toBe('dpl_current');
    expect(current?.immutableUrl).toBe('https://demo-current.vercel.app/');

    const previous = await provider.getPreviousDeployment(projectId, 'dpl_current');
    expect(previous?.id).toBe('dpl_previous');
    expect(calls.some(call => call.url.pathname === '/v7/deployments'
      && call.url.searchParams.get('rollbackCandidate') === 'true')).toBe(true);
  });

  it('retries one timed-out Vercel API call', async () => {
    let attempts = 0;
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      attempts += 1;
      if (attempts === 1) throw new Error('connect timeout');
      if (url.pathname === '/v4/aliases') {
        return Response.json({ aliases: [{ alias: 'demo.example.com', deploymentId: 'dpl_current', projectId }] });
      }
      if (url.pathname === '/v13/deployments/dpl_current') return Response.json(currentDeployment);
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const provider = new VercelProvider({ accessToken: token, projectId, productionDomain: 'demo.example.com', fetch: fetchMock, timeoutMs: 1000 });
    const current = await provider.getProductionDeployment(projectId);
    expect(current?.id).toBe('dpl_current');
    expect(attempts).toBe(3);
  });

  it('revalidates project and predecessor before issuing rollback', async () => {
    const { provider, calls } = mockProvider();
    await expect(provider.rollbackProductionTo('other-project', 'dpl_previous')).rejects.toThrow('different project');
    await expect(provider.rollbackProductionTo(projectId, 'dpl_current')).rejects.toThrow('immediate predecessor');
    expect(calls.some(call => call.init.method === 'POST')).toBe(false);

    const rollback = await provider.rollbackProductionTo(projectId, 'dpl_previous');
    expect(rollback.actionUrl).toBe('https://demo-previous.vercel.app/');
    expect(calls.some(call => call.url.pathname === '/v1/projects/prj_demo/rollback/dpl_previous'
      && call.init.method === 'POST')).toBe(true);
  });

  it('probes only verified immutable Vercel hosts and sends no token to app probes', async () => {
    const { provider, calls } = mockProvider();
    const result = await provider.probeImmutableDeployment('https://demo-current.vercel.app', '/api/tasks');
    expect(result.result).toBe('pass');
    expect(result.evidence).toContain('HTTP 200');
    const probeCall = calls.find(call => call.url.hostname === 'demo-current.vercel.app');
    expect(probeCall?.init.headers).toEqual({ Accept: 'application/json' });

    await expect(provider.probeImmutableDeployment('https://127.0.0.1', '/api/tasks')).rejects.toThrow('Invalid immutable');
    await expect(provider.probeImmutableDeployment('https://demo-current.vercel.app', '//attacker.example'))
      .rejects.toThrow('Invalid immutable');
  });

  it('treats deployment-protection responses as unknown and probes the public production host', async () => {
    const calls: Array<{ url: URL }> = [];
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      calls.push({ url });
      if (url.hostname === 'demo-current.vercel.app') return new Response('protected', { status: 401 });
      if (url.hostname === 'demo.example.com') return new Response('ok', { status: 200 });
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    const provider = new VercelProvider({
      accessToken: token,
      projectId,
      productionDomain: 'demo.example.com',
      fetch: fetchMock,
    });

    const protectedProbe = await provider.probeImmutableDeployment('https://demo-current.vercel.app', '/api/tasks');
    expect(protectedProbe.result).toBe('unknown');
    expect(protectedProbe.evidence).toContain('HTTP 401');

    const production = await provider.probeProduction(projectId, '/api/tasks');
    expect(production.result).toBe('pass');
    expect(calls.map(call => call.url.hostname)).toEqual(['demo-current.vercel.app', 'demo.example.com']);
  });

  it('maps the newest production deployment status for build-failure detection', async () => {
    const { provider, calls } = mockProvider();
    const original = calls.length;
    const status = await provider.getLatestDeploymentStatus(projectId);
    expect(calls.length).toBe(original + 1);
    expect(status?.id).toBe('dpl_current');
    expect(status?.state).toBe('READY');
  });

  it('lists production deployments inside the since window with bounded limits', async () => {
    const { provider, calls } = mockProvider();
    const since = Date.parse('2026-10-23T11:30:00Z');
    const deployments = await provider.listDeploymentsSince(projectId, since);
    const expected: DeploymentSummary[] = [
      { id: 'dpl_current', state: 'READY', createdAt: new Date(Date.parse('2026-10-23T12:00:00Z')).toISOString() },
      { id: 'dpl_previous', state: 'READY', createdAt: new Date(Date.parse('2026-10-23T11:00:00Z')).toISOString() },
    ];
    expect(deployments).toEqual(expected.filter(item => Date.parse(item.createdAt) >= since));
    const listCall = calls.find(call => call.url.pathname === '/v7/deployments');
    expect(listCall?.url.searchParams.get('since')).toBe(String(since));
    expect(listCall?.url.searchParams.get('target')).toBe('production');
    expect(listCall?.url.searchParams.get('limit')).toBe('20');

    const onlyCurrent = await provider.listDeploymentsSince(projectId, Date.parse('2026-10-23T11:30:00Z'));
    expect(onlyCurrent.map(item => item.id)).toEqual(['dpl_current']);
  });

  it('reads runtime logs and marks server failures without leaking secrets', async () => {
    const { provider, calls } = mockProvider();
    const logs = await provider.getRuntimeLogs(projectId, 'dpl_current');
    expect(logs.map(log => log.message)).toEqual(['request completed', 'database password=[REDACTED]']);
    expect(logs[1]?.isError).toBe(true);
    expect(logs[1]?.statusCode).toBe(500);
    expect(calls.some(call => call.url.pathname === '/v1/projects/prj_demo/deployments/dpl_current/runtime-logs')).toBe(true);
  });

  it('reads bounded deployment events and marks failures without leaking secrets', async () => {
    const { provider, calls } = mockProvider();
    const logs = await provider.getDeploymentEvents(projectId, 'dpl_current');
    expect(logs).toEqual([
      { id: 'ev-1', level: 'info', message: 'Running build in Washington, D.C., USA (East) – iad1', timestamp: 10, isError: false },
      { id: 'ev-2', level: 'warn', message: 'build aborted password=[REDACTED]', timestamp: 20, isError: false },
      { id: 'ev-3', level: 'error', message: 'Build failed', timestamp: 30, isError: true },
    ]);
    expect(calls.some(call => call.url.pathname === '/v3/deployments/dpl_current/events'
      && call.url.searchParams.get('limit') === '150'
      && call.url.searchParams.get('teamId') === null)).toBe(true);
  });

  it('returns redacted deployment event lines for incident evidence', async () => {
    const { provider } = mockProvider();
    const lines = await provider.getDeploymentLogs(projectId, 'dpl_current');
    expect(lines.at(-1)).toBe('error: Build failed');
    expect(lines.at(-2)).toBe('warn: build aborted password=[REDACTED]');
  });

  it('tracks Vercel rate-limit headers for backoff decisions', async () => {
    const { provider } = mockProvider({ rateLimited: true });
    expect(provider.getRateLimit()).toBeNull();
    await provider.listDeploymentsSince(projectId, 0);
    const info = provider.getRateLimit();
    expect(info).not.toBeNull();
    expect(info?.remaining).toBe(3);
    // Second-precision reset timestamps are normalized to milliseconds.
    expect(info?.reset).toBe(1792800000000);
  });
});
