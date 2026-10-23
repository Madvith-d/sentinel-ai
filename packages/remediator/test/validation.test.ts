import { describe, expect, test } from 'bun:test';
import { remediationPrompt, superchargeConfig } from '../src/prompt.ts';
import { validatePatch } from '../src/pr-publisher.ts';
import { validateChangedFiles, validateRequest } from '../src/validation.ts';
import type { ProviderConfig, RemediationRequest } from '../src/types.ts';

const request: RemediationRequest = {
  incidentId: 'demo-42',
  repository: 'iotserver24/nexathon',
  commitSha: 'a'.repeat(40),
  evidence: ['GET /api/demo -> 500'],
  setupCommand: 'bun install --frozen-lockfile',
  reproduceCommand: 'bun test apps/sample/tests/repro.test.ts',
  testCommand: 'bun test',
  buildCommand: 'bun run --cwd apps/sample build',
};
const provider: ProviderConfig = {
  modelName: 'demo', modelId: 'model-id', baseUrl: 'https://model.example/v1',
  apiBackend: 'responses', apiKey: 'dedicated-secret', githubReadToken: 'read-only-token',
};

describe('controller boundary', () => {
  test('accepts exact repository and full SHA', () => expect(() => validateRequest(request)).not.toThrow());
  test('rejects a different repository or malformed SHA', () => {
    expect(() => validateRequest({ ...request, repository: 'another/repo' })).toThrow('allowlisted');
    expect(() => validateRequest({ ...request, commitSha: 'main' })).toThrow('40-character');
  });
  test('accepts a bounded trusted fixture and rejects test-path traversal or oversized content', () => {
    const reproductionFixture = { path: 'apps/sample/tests/filter.repro.test.ts', content: 'test(\"regression\", () => {});' };
    expect(() => validateRequest({ ...request, reproductionFixture })).not.toThrow();
    expect(() => validateRequest({ ...request, reproductionFixture: { ...reproductionFixture, path: 'apps/sample/tests/../../.env.test.ts' } })).toThrow('safe');
    expect(() => validateRequest({ ...request, reproductionFixture: { ...reproductionFixture, content: 'x'.repeat(12_001) } })).toThrow('12 KiB');
  });
  test('rejects paths and generated secrets outside the demo target', () => {
    expect(() => validateChangedFiles(['apps/sample/api/health.ts'])).not.toThrow();
    for (const path of ['apps/controller/src/index.ts', 'apps/sample/.env', 'apps/sample/node_modules/x', 'apps/sample/../controller/x']) {
      expect(() => validateChangedFiles([path])).toThrow();
    }
  });
});

describe('agent configuration', () => {
  test('uses runtime interpolation for a read-only MCP token', () => {
    const config = superchargeConfig(provider);
    expect(config).toContain('api_key = "dedicated-secret"');
    expect(config).toContain('Bearer ${GITHUB_READ_TOKEN}');
    expect(config).toContain('"X-MCP-Readonly" = "true"');
    expect(config).not.toContain('read-only-token');
  });
  test('treats incident evidence as untrusted and limits edit scope', () => {
    const prompt = remediationPrompt(request);
    expect(prompt).toContain('untrusted observations');
    expect(prompt).toContain('only files under apps/sample/');
    expect(prompt).not.toContain(provider.apiKey);
  });
});

describe('publisher patch boundary', () => {
  const safe = 'diff --git a/apps/sample/api/health.ts b/apps/sample/api/health.ts\n--- a/apps/sample/api/health.ts\n+++ b/apps/sample/api/health.ts\n@@ -1 +1 @@\n-old\n+new\n';
  test('accepts a normal patch scoped to the target', () => expect(validatePatch(safe)).toEqual(['apps/sample/api/health.ts']));
  test('rejects modifications to controller, traversal, binary or symlink', () => {
    expect(() => validatePatch(safe.replaceAll('apps/sample/api/health.ts', 'apps/controller/src/index.ts'))).toThrow();
    expect(() => validatePatch(safe.replaceAll('apps/sample/api/health.ts', 'apps/sample/../controller/x'))).toThrow();
    expect(() => validatePatch(`${safe}GIT binary patch\n`)).toThrow();
    expect(() => validatePatch(`${safe}new file mode 120000\n`)).toThrow();
  });
});
