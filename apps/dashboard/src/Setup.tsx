import { useEffect, useState } from 'react';

interface SettingField {
  group: string;
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
  source: 'saved' | 'environment' | 'missing';
  value: string;
}

export function Setup({ onClose }: { onClose: () => void }) {
  const [fields, setFields] = useState<SettingField[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/settings', { headers: { Accept: 'application/json' }, signal: abort.signal })
      .then(async response => {
        if (!response.ok) throw new Error('The controller did not return integration settings.');
        const body = await response.json() as { fields: SettingField[] };
        setFields(body.fields);
        setDraft(Object.fromEntries(body.fields.filter(field => !field.secret).map(field => [field.key, field.value])));
      })
      .catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Settings could not be loaded.'); });
    return () => abort.abort();
  }, []);

  const groups = [...new Set(fields.map(field => field.group))];

  async function save() {
    setError('');
    setMessage('');
    const values = Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim()));
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ values }),
    });
    if (!response.ok) {
      setError('Settings were not saved.');
      return;
    }
    setMessage('Saved in the controller. Restart Keel to apply them. Secret fields stay blank here; type a new value only when you want to replace one.');
  }

  return <main className="detail setup">
    <div className="section-heading"><div><p className="eyebrow">Setup</p><h1>Integrations</h1></div><button className="refresh" type="button" onClick={onClose}>Back to incidents</button></div>
    <p className="setup-note">These values live in the controller database and override the environment on the next start. Leave a secret blank to keep the current one.</p>
    {error && <div className="error-box" role="alert"><strong>Setup unavailable</strong><p>{error}</p></div>}
    {groups.map(group => <section key={group} className="setup-group"><h2>{group}</h2>
      {fields.filter(field => field.group === group).map(field => <label key={field.key}>{field.label}
        <input
          type={field.secret ? 'password' : 'text'}
          autoComplete="off"
          placeholder={field.configured ? `Configured from ${field.source}` : 'Not set'}
          value={draft[field.key] ?? ''}
          onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.value }))}
        />
      </label>)}
    </section>)}
    <button className="action" type="button" onClick={() => void save()}>Save integrations</button>
    {message && <p className="setup-note">{message}</p>}
  </main>;
}
