import { useCallback, useEffect, useMemo, useState } from 'react';

interface SettingField {
  group: string;
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
  source: 'saved' | 'environment' | 'missing';
  value: string;
}

type VercelConnect = { userCode: string; verificationUri: string; status: string } | null;

export function Setup({ onClose }: { onClose: () => void }) {
  const [fields, setFields] = useState<SettingField[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [vercel, setVercel] = useState<VercelConnect>(null);

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/settings', { headers: { Accept: 'application/json' }, signal });
    if (!response.ok) throw new Error('The controller did not return integration settings.');
    const body = await response.json() as { fields: SettingField[] };
    setFields(body.fields);
    setDraft(current => Object.fromEntries(body.fields.map(field => [field.key, current[field.key] ?? (field.secret ? '' : field.value)])));
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void loadSettings(abort.signal).catch(reason => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Settings could not be loaded.');
    });
    return () => abort.abort();
  }, [loadSettings]);

  const field = useMemo(() => new Map(fields.map(item => [item.key, item])), [fields]);
  const groups = [...new Set(fields.map(item => item.group).filter(group => group !== 'Vercel'))];
  const setValue = (key: string, value: string) => setDraft(current => ({ ...current, [key]: value }));

  function renderField(key: string, className = '') {
    const item = field.get(key);
    if (!item) return null;
    return <label className={`setup-field ${className}`} key={item.key}>
      <span>{item.label}</span>
      <input
        type={item.secret ? 'password' : 'text'}
        autoComplete={item.secret ? 'new-password' : 'off'}
        placeholder={item.configured ? `Configured from ${item.source}` : 'Not set'}
        value={draft[item.key] ?? ''}
        onChange={event => setValue(item.key, event.target.value)}
      />
      {item.configured && <small>Configured · value hidden</small>}
    </label>;
  }

  async function connectVercel() {
    setError('');
    try {
      const started = await fetch('/api/vercel/connect', { method: 'POST', headers: { Accept: 'application/json' } });
      if (!started.ok) throw new Error('Vercel sign-in did not start.');
      const body = await started.json() as { userCode: string; verificationUri: string; intervalMs: number };
      setVercel({ userCode: body.userCode, verificationUri: body.verificationUri, status: 'Waiting for approval.' });
      window.open(body.verificationUri, '_blank', 'noopener');
      const timer = window.setInterval(async () => {
        const poll = await fetch('/api/vercel/connect', { headers: { Accept: 'application/json' } });
        if (poll.status === 404) { window.clearInterval(timer); setError('Vercel sign-in expired. Start it again.'); return; }
        if (!poll.ok) return;
        const result = await poll.json() as { ok?: boolean };
        if (result.ok) {
          window.clearInterval(timer);
          setVercel(current => current ? { ...current, status: 'Connected. Save or restart the controller to apply it.' } : current);
          await loadSettings();
        }
      }, Math.max(body.intervalMs, 5000));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Vercel sign-in did not start.');
    }
  }

  async function save() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const values = Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim()));
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ values }),
      });
      if (!response.ok) throw new Error('Settings were not saved.');
      setMessage('Saved securely in the controller database. Restart the controller to apply monitoring changes.');
      await loadSettings();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Settings were not saved.');
    } finally {
      setBusy(false);
    }
  }

  return <main className="detail setup">
    <div className="setup-header">
      <div>
        <p className="eyebrow">Control room / configuration</p>
        <h1>Connect your stack</h1>
        <p className="setup-lede">Give Keel the smallest set of credentials it needs to watch one Vercel project and report evidence here.</p>
      </div>
      <button className="button button-ghost" type="button" onClick={onClose}>Back to incidents</button>
    </div>

    <p className="setup-note">Railway, Render, and Coolify use scoped API tokens below. Select the active platform, provide its public production URL and service/application ID, then restart Keel. Deployment logs are attached to incident evidence and rollback remains opt-in.</p>

    {error && <div className="error-box" role="alert"><strong>Setup needs attention</strong><p>{error}</p></div>}

    <section className="setup-hero" aria-labelledby="vercel-title">
      <div className="setup-hero-copy">
        <div className="provider-mark provider-vercel" aria-hidden="true">V</div>
        <div>
          <div className="section-kicker"><span className="status-dot status-dot-warn" /> Primary provider</div>
          <h2 id="vercel-title">Vercel monitoring</h2>
          <p>Connect with Vercel OAuth or paste a project-scoped access token. Credentials are sent only to the local controller and never rendered back into the browser.</p>
        </div>
      </div>
      <div className="setup-hero-actions">
        <button className="button button-primary" type="button" onClick={() => void connectVercel()}>Connect with Vercel</button>
        {vercel && <div className="connect-status"><strong>{vercel.status}</strong><span>Code <code>{vercel.userCode}</code> · <a href={vercel.verificationUri} target="_blank" rel="noreferrer">open verification</a></span></div>}
      </div>
      <div className="field-grid field-grid-2">
        {renderField('VERCEL_ACCESS_TOKEN', 'field-wide')}
        {renderField('VERCEL_TEAM_ID')}
        {renderField('VERCEL_PROJECT_ID')}
        {renderField('VERCEL_PRODUCTION_DOMAIN')}
        {renderField('CONTROLLER_PROBE_PATH')}
      </div>
      <div className="toggle-row">
        {renderField('CONTROLLER_MONITOR_ENABLED')}
        {renderField('CONTROLLER_ROLLBACK_ENABLED')}
      </div>
    </section>

    <section className="setup-connection-row">
      <div>
        <div className="provider-mark provider-github" aria-hidden="true">GH</div>
        <div><h2>GitHub app</h2><p>Use a short-lived installation token for repository access and draft pull requests.</p></div>
      </div>
      <a className="button button-secondary" href="/api/github/connect">Connect GitHub</a>
    </section>

    {groups.map(group => <section className="setup-advanced" key={group}>
      <div className="setup-advanced-heading"><div><p className="eyebrow">Optional</p><h2>{group}</h2></div><span>{fields.filter(item => item.group === group && item.configured).length} configured</span></div>
      <div className="field-grid field-grid-2">{fields.filter(item => item.group === group).map(item => renderField(item.key))}</div>
    </section>)}

    <div className="setup-footer">
      <div><strong>Changes are stored, then applied on restart.</strong><span>Secret values stay hidden after saving.</span></div>
      <button className="button button-primary" disabled={busy} type="button" onClick={() => void save()}>{busy ? 'Saving…' : 'Save configuration'}</button>
    </div>
    {message && <p className="success-message" role="status">{message}</p>}
  </main>;
}
