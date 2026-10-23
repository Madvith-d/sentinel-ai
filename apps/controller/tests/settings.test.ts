import { describe, expect, it } from 'bun:test';
import { IncidentStore } from '../src/incident-store';
import { createSettingsApi } from '../src/settings';

describe('integration settings', () => {
  it('stores website values and applies them over the environment on startup', async () => {
    const store = new IncidentStore(':memory:');
    await store.writeSettings({ SMTP_HOST: 'mail.example.com', SMTP_FROM: 'sentinel@example.com' });
    const api = createSettingsApi(store);
    const saved = await api(new Request('http://127.0.0.1/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { SMTP_TO: 'judge@example.com', VERCEL_ACCESS_TOKEN: 'secret-token', IGNORED: 'nope' } }),
    }));
    expect(saved?.status).toBe(200);
    expect((await store.readSettings()).VERCEL_ACCESS_TOKEN).toBe('secret-token');
    expect((await store.readSettings()).IGNORED).toBeUndefined();
    const view = await api(new Request('http://127.0.0.1/api/settings'));
    const body = await view!.json() as { fields: Array<{ key: string; value: string; configured: boolean }> };
    const token = body.fields.find(field => field.key === 'VERCEL_ACCESS_TOKEN');
    const host = body.fields.find(field => field.key === 'SMTP_HOST');
    expect(token?.configured).toBe(true);
    expect(token?.value).toBe('');
    expect(host?.value).toBe('mail.example.com');
    expect((await store.readSettings()).SMTP_TO).toBe('judge@example.com');
    await store.deleteSettings(['VERCEL_ACCESS_TOKEN']);
    expect((await store.readSettings()).VERCEL_ACCESS_TOKEN).toBeUndefined();
    expect((await store.readSettings()).SMTP_TO).toBe('judge@example.com');
    store.close();
  });
});
