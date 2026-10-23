import { createSign, randomBytes } from 'node:crypto';
import type { IncidentStore } from './incident-store';

const state = randomBytes(16).toString('hex');

export function githubConnectPage(origin: string, owner?: string): string {
  const redirect = `${origin}/api/github/callback`;
  const manifest = {
    name: 'Sentinel',
    url: origin,
    redirect_url: redirect,
    callback_urls: [redirect],
    setup_url: `${origin}/api/github/installed`,
    public: false,
    default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    default_events: [],
    request_oauth_on_install: false,
  };
  const target = owner
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
  const json = JSON.stringify(manifest).replaceAll('<', '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>Connect GitHub</title>
<p>GitHub will ask you to create the Sentinel app, then install it on the repository.</p>
<form method="post" action="${target}"><input type="hidden" name="state" value="${state}">
<input type="hidden" name="manifest" value='${json.replaceAll("'", '&#39;')}'>
<button type="submit">Continue to GitHub</button></form><script>document.forms[0].submit()</script>`;
}

export function githubStateOk(value: string | null): boolean {
  return value === state;
}

export async function exchangeGithubManifest(code: string): Promise<Record<string, string>> {
  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sentinel' },
  });
  if (!response.ok) throw new Error('GitHub did not finish creating the app.');
  const body = await response.json() as { id?: number; pem?: string; slug?: string; client_id?: string };
  if (!body.id || !body.pem || !body.slug) throw new Error('GitHub app details were incomplete.');
  return {
    GITHUB_APP_ID: String(body.id),
    GITHUB_APP_PEM: body.pem,
    GITHUB_APP_SLUG: body.slug,
    ...(body.client_id ? { GITHUB_CLIENT_ID: body.client_id } : {}),
  };
}

export function appJwt(appId: string, pem: string, now = Date.now()): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const issued = Math.floor(now / 1000);
  const payload = base64url(JSON.stringify({ iat: issued - 60, exp: issued + 540, iss: appId }));
  const data = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  return `${data}.${signer.sign(pem).toString('base64url')}`;
}

export async function installationToken(appId: string, pem: string, installationId: string, access: 'read' | 'write'): Promise<string> {
  const permissions = access === 'write'
    ? { contents: 'write', pull_requests: 'write', metadata: 'read' }
    : { contents: 'read', metadata: 'read' };
  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${appJwt(appId, pem)}`,
      'User-Agent': 'sentinel',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ permissions }),
  });
  if (!response.ok) throw new Error('GitHub did not issue an installation token.');
  const body = await response.json() as { token?: string };
  if (!body.token) throw new Error('GitHub did not issue an installation token.');
  return body.token;
}

/** Prefer a short-lived GitHub App token. Fall back to a saved personal token. */
export async function githubCredentials(store: Pick<IncidentStore, 'readSettings'>): Promise<{ write?: string; read?: string }> {
  const saved = await store.readSettings();
  const appId = saved.GITHUB_APP_ID || process.env.GITHUB_APP_ID;
  const pem = saved.GITHUB_APP_PEM || process.env.GITHUB_APP_PEM;
  const installationId = saved.GITHUB_INSTALLATION_ID || process.env.GITHUB_INSTALLATION_ID;
  if (appId && pem && installationId) {
    const [write, read] = await Promise.all([
      installationToken(appId, pem, installationId, 'write'),
      installationToken(appId, pem, installationId, 'read'),
    ]);
    return { write, read };
  }
  return {
    ...(process.env.GH_TOKEN ? { write: process.env.GH_TOKEN } : {}),
    ...(process.env.GITHUB_READ_TOKEN ? { read: process.env.GITHUB_READ_TOKEN } : {}),
  };
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}
