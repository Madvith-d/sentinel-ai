import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { appJwt, githubConnectPage } from '../src/github-app';

describe('github app connect', () => {
  it('builds a manifest that asks for repo and pull request access', () => {
    const page = githubConnectPage('http://127.0.0.1:8899');
    expect(page).toContain('https://github.com/settings/apps/new');
    expect(page).toContain('http://127.0.0.1:8899/api/github/callback');
    expect(page).toContain('pull_requests');
    expect(page).not.toContain('ghp_');
  });

  it('signs an app JWT with the app id as issuer', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const token = appJwt('12345', pem, Date.parse('2026-10-23T12:00:00Z'));
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(payload.iss).toBe('12345');
    expect(token.split('.')).toHaveLength(3);
  });
});
