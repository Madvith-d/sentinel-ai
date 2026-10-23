import { afterEach, describe, expect, it } from 'bun:test';
import { IncidentStore } from '../src/incident-store';
import { startPollingWorker } from '../src/worker';
import type { DeploymentProvider } from '../src/monitor';

let store: IncidentStore;
afterEach(() => store?.close());

describe('startPollingWorker', () => {
  it('runs requested projects serially and stops future checks', async () => {
    store = new IncidentStore(':memory:');
    const probedProjects: string[] = [];
    const provider: DeploymentProvider = {
      async getProductionDeployment(projectId) {
        probedProjects.push(projectId);
        return {
          id: `deployment-${projectId}`,
          immutableUrl: 'https://healthy-demo.vercel.app',
          createdAt: new Date().toISOString(),
        };
      },
      async getPreviousDeployment() { return null; },
      async probeImmutableDeployment() { return { result: 'pass', evidence: 'HTTP 200' }; },
      async rollbackProductionTo() { throw new Error('Should not roll back a healthy project.'); },
      async probeProduction() { return { result: 'pass', evidence: 'HTTP 200' }; },
    };
    const results: string[] = [];
    const worker = startPollingWorker({
      projectIds: ['project-a', 'project-b', 'project-a'],
      allowlistedProjectIds: new Set(['project-a', 'project-b']),
      probePath: '/api/tasks',
      provider,
      store,
      intervalMs: 300_000,
      startImmediately: false,
      onResult: projectId => { results.push(projectId); },
    });

    await worker.pollNow();
    expect(probedProjects).toEqual(['project-a', 'project-b']);
    expect(results).toEqual(['project-a', 'project-b']);

    await worker.stop();
    await worker.pollNow();
    expect(probedProjects).toHaveLength(2);
  });
});
