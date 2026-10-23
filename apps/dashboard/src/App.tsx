import { useEffect, useMemo, useRef, useState } from 'react';
import { Setup } from './Setup';
import {
  decisionLabels,
  kindLabels,
  rollbackCaveat,
  statusLabels,
  type Incident,
} from '@nexathon/notifier/format';
import { useIncidents, type DataMode } from './useIncidents';
import { useActivity } from './useActivity';

const mode: DataMode = import.meta.env.VITE_DATA_MODE === 'fixtures' ? 'fixtures' : 'live';

const phaseLabels: Record<string, string> = {
  sandbox: 'Sandbox', checkout: 'Checkout', setup: 'Setup', reproduction: 'Reproduction',
  agent: 'Agent', verification: 'Verification', patch: 'Patch',
};
const runStatusLabels: Record<string, string> = {
  queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Stopped',
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function shortSha(value?: string) {
  return value ? value.slice(0, 7) : '—';
}

function hostOf(value?: string) {
  if (!value) return '—';
  try { return new URL(value).host; } catch { return value; }
}

function StatusPill({ status }: { status: Incident['status'] }) {
  return <span className={`status status-${status}`}>{statusLabels[status]}</span>;
}

function IncidentCard({ incident, selected, onSelect }: { incident: Incident; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`incident-card${selected ? ' selected' : ''}`} onClick={onSelect} type="button">
      <span className="card-topline"><span>{formatDate(incident.detectedAt)}</span><StatusPill status={incident.status} /></span>
      <strong>{kindLabels[incident.kind]}</strong>
      <span className="card-meta">{incident.decision ? decisionLabels[incident.decision] : 'Pending'} · {shortSha(incident.commitSha)} · {incident.probePath ?? 'build'}</span>
      <span className="card-summary">{incident.evidence[0] ?? 'No evidence recorded.'}</span>
    </button>
  );
}

function Evidence({ incident }: { incident: Incident }) {
  return <section className="panel evidence-panel">
    <div className="section-heading"><h2>Evidence</h2><span>{incident.evidence.length} entries</span></div>
    <ul className="evidence-list">{incident.evidence.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
  </section>;
}

function Timeline({ events }: { events: Incident['events'] }) {
  return <section className="panel timeline-panel">
    <div className="section-heading"><h2>Incident timeline</h2><span>chronological record</span></div>
    <ol className="timeline">
      {events.map((event, index) => <li key={`${event.at}-${event.type}-${index}`}>
        <span className="timeline-dot" aria-hidden="true" />
        <div><div className="timeline-meta"><strong>{event.type.replaceAll('_', ' ')}</strong><time dateTime={event.at}>{formatDate(event.at)}</time></div><p>{event.message}</p></div>
      </li>)}
    </ol>
  </section>;
}

function LiveActivity({ incidentId }: { incidentId: string }) {
  const { run, events, error } = useActivity(mode, incidentId);
  const feed = useRef<HTMLOListElement>(null);
  const live = run?.status === 'queued' || run?.status === 'running';
  useEffect(() => {
    const node = feed.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events.length, run?.outcome]);
  return <section className="panel activity-panel" aria-live="polite">
    <div className="section-heading">
      <h2>Live agent activity</h2>
      {run
        ? <span className={`run-badge ${live ? 'live' : run.status}`}>
            {live && <span className="pulse" aria-hidden="true" />}
            {run.source === 'ai' ? 'AI run' : 'Rehearsal'} · {runStatusLabels[run.status]}
          </span>
        : <span>no run yet</span>}
    </div>
    {error && <p className="activity-error" role="status">{error}</p>}
    {!run && <p className="activity-empty">
      {mode === 'fixtures'
        ? 'Fixture data only. Run the local controller to watch an agent work.'
        : 'No agent run for this incident yet. Start one with `bun run --cwd apps/controller start:run -- --incident=' + incidentId + '`.'}
    </p>}
    {run && <>
      <p className="activity-now">{events.at(-1)?.message ?? 'Waiting for the first progress event.'}</p>
      <ol className="activity-feed" ref={feed}>
        {events.map(event => <li key={event.seq} className={`activity-item phase-${event.phase}`}>
          <span className="activity-phase">{phaseLabels[event.phase] ?? event.phase}</span>
          <p>{event.message}</p>
          <time dateTime={event.at}>{formatTime(event.at)}</time>
        </li>)}
      </ol>
      {events.length === 0 && !error && <p className="activity-empty">Waiting for the first safe progress event…</p>}
      {run.outcome && <p className="activity-outcome">{run.outcome}</p>}
    </>}
  </section>;
}

function Detail({ incident }: { incident: Incident }) {
  const actionLabel = incident.decision === 'fix_pr' ? 'Open pull request' : incident.decision === 'rollback' ? 'View rollback target' : 'View action';
  const detected = incident.events.find(event => event.type === 'detected');
  const decision = incident.events.find(event => event.type === 'decision');
  return <main className="detail">
    <div className="detail-heading">
      <div><p className="eyebrow">Incident {incident.id}</p><h1>{kindLabels[incident.kind]}</h1><p className="muted">Detected {formatDate(incident.detectedAt)} · {incident.projectId}</p></div>
      <StatusPill status={incident.status} />
    </div>
    <section className="trigger" aria-label="What triggered this incident">
      <div>
        <span className="eyebrow">What triggered this</span>
        <h2>{detected?.message ?? incident.evidence[0] ?? 'The controller recorded a failure.'}</h2>
        <p>{incident.probePath ? `Probe ${incident.probePath}` : 'Deployment status check'}{incident.deploymentUrl ? ` on ${hostOf(incident.deploymentUrl)}` : ''}.</p>
      </div>
      <ul>
        {incident.evidence.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
        {decision && <li>{decision.message}</li>}
      </ul>
    </section>
    <section className="signal-grid" aria-label="Incident summary">
      <div><span>Decision</span><strong>{incident.decision ? decisionLabels[incident.decision] : 'Pending'}</strong></div>
      <div><span>Revision</span><strong className="mono">{incident.commitSha ?? '—'}</strong></div>
      <div><span>Probe route</span><strong className="mono">{incident.probePath ?? 'Build status'}</strong></div>
      <div><span>Production host</span><strong className="mono">{hostOf(incident.deploymentUrl)}</strong></div>
      <div><span>Previous host</span><strong className="mono">{hostOf(incident.previousDeploymentUrl)}</strong></div>
      <div><span>Timeline</span><strong>{incident.events.length} events</strong></div>
    </section>
    <section className="action-banner">
      <div><span className="eyebrow">Current action</span><h2>{incident.decision ? decisionLabels[incident.decision] : 'Investigation in progress'}</h2><p>{incident.status === 'recovered' ? 'Production recovery was verified after the guarded action.' : incident.status === 'pr_opened' ? 'A pull request is open for review. Nothing has been merged.' : incident.status === 'needs_human' ? 'Automatic work stopped because the evidence was not safe to act on.' : 'The controller is collecting evidence before taking action.'}</p></div>
      {incident.actionUrl && <a className="action-link" href={incident.actionUrl} target="_blank" rel="noreferrer">{actionLabel}<span aria-hidden="true">↗</span></a>}
    </section>
    {incident.decision === 'rollback' && <p className="caveat">{rollbackCaveat}</p>}
    <LiveActivity incidentId={incident.id} />
    <div className="detail-columns"><Evidence incident={incident} /><Timeline events={incident.events} /></div>
  </main>;
}

function LiveWatch() {
  const [clock, setClock] = useState(() => new Date());
  const [watch, setWatch] = useState<{ checkedAt: string | null; outcome: string; detail: string; probePath: string; intervalMs: number } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (mode === 'fixtures') return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch('/api/watch', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: abort.signal });
        if (response.ok) setWatch(await response.json());
      } catch { /* the next tick retries */ }
      if (!abort.signal.aborted) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, []);
  const checked = watch?.checkedAt ? new Date(watch.checkedAt) : null;
  const age = checked ? Math.max(0, Math.round((clock.getTime() - checked.getTime()) / 1000)) : null;
  const time = clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return <div className={`live-watch ${watch?.outcome ?? 'starting'}`} aria-live="polite">
    <strong className="live-clock">{time}</strong>
    {mode === 'fixtures'
      ? <span>Rehearsal data · local clock only</span>
      : <span>{watch?.probePath ?? '/api/tasks'} · {watch?.outcome ?? 'starting'}{age !== null ? ` · checked ${age}s ago` : ''}</span>}
  </div>;
}

export default function App() {
  const [showSetup, setShowSetup] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const snapshot = useIncidents(mode, selectedId, refresh);
  const selected = snapshot.detail ?? snapshot.incidents[0] ?? null;
  const counts = useMemo(() => ({ active: snapshot.incidents.filter(item => !['recovered', 'needs_human', 'pr_opened'].includes(item.status)).length, recovered: snapshot.incidents.filter(item => item.status === 'recovered').length }), [snapshot.incidents]);

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark" aria-hidden="true">✳</span><span>Keel <em>deploy watch</em></span></div><div className="topbar-meta"><LiveWatch /><span className={`mode-dot ${mode}`} />{mode === 'fixtures' ? 'Rehearsal data' : 'Live controller'}<button className="refresh" onClick={() => setShowSetup(value => !value)} type="button">Setup</button><button className="refresh" onClick={() => setRefresh(value => value + 1)} type="button">Refresh</button></div></header>
    <div className="workspace">
      <aside className="sidebar"><div className="sidebar-heading"><div><p className="eyebrow">Operations</p><h2>Incidents</h2></div><span className="count">{snapshot.incidents.length}</span></div><div className="sidebar-stats"><span><strong>{counts.active}</strong> active</span><span><strong>{counts.recovered}</strong> recovered</span></div>
        {snapshot.loading && <p className="state-message">Loading incident evidence…</p>}
        {snapshot.error && <div className="error-box" role="alert"><strong>Controller unavailable</strong><p>{snapshot.error}</p><button onClick={() => setRefresh(value => value + 1)} type="button">Try again</button></div>}
        {!snapshot.loading && !snapshot.error && snapshot.incidents.length === 0 && <p className="state-message">No incidents recorded yet.</p>}
        <nav className="incident-list" aria-label="Incidents">{snapshot.incidents.map(incident => <IncidentCard key={incident.id} incident={incident} selected={selected?.id === incident.id} onSelect={() => setSelectedId(incident.id)} />)}</nav>
      </aside>
      {showSetup ? <Setup onClose={() => setShowSetup(false)} /> : selected ? <Detail incident={selected} /> : <main className="empty-detail"><span className="empty-icon">✳</span><h1>No incident selected</h1><p>When the controller records an incident, its evidence and recovery path will appear here.</p></main>}
    </div>
  </div>;
}
