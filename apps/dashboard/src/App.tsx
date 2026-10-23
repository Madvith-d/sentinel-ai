import { useMemo, useState } from 'react';
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

function StatusPill({ status }: { status: Incident['status'] }) {
  return <span className={`status status-${status}`}>{statusLabels[status]}</span>;
}

function IncidentCard({ incident, selected, onSelect }: { incident: Incident; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`incident-card${selected ? ' selected' : ''}`} onClick={onSelect} type="button">
      <span className="card-topline"><span>{formatDate(incident.detectedAt)}</span><StatusPill status={incident.status} /></span>
      <strong>{kindLabels[incident.kind]}</strong>
      <span className="card-meta">{incident.projectId} · {shortSha(incident.commitSha)}</span>
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
  const live = run?.status === 'queued' || run?.status === 'running';
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
      <ol className="activity-feed">
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
  const actionLabel = incident.decision === 'fix_pr' ? 'Open draft PR' : incident.decision === 'rollback' ? 'View rollback target' : 'View action';
  return <main className="detail">
    <div className="detail-heading">
      <div><p className="eyebrow">Incident {incident.id}</p><h1>{kindLabels[incident.kind]}</h1><p className="muted">Detected {formatDate(incident.detectedAt)} · {incident.projectId}</p></div>
      <StatusPill status={incident.status} />
    </div>
    <section className="signal-grid" aria-label="Incident summary">
      <div><span>Decision</span><strong>{incident.decision ? decisionLabels[incident.decision] : 'Pending'}</strong></div>
      <div><span>Revision</span><strong className="mono">{shortSha(incident.commitSha)}</strong></div>
      <div><span>Probe route</span><strong className="mono">{incident.probePath ?? 'Build status'}</strong></div>
    </section>
    <section className="action-banner">
      <div><span className="eyebrow">Current action</span><h2>{incident.decision ? decisionLabels[incident.decision] : 'Investigation in progress'}</h2><p>{incident.status === 'recovered' ? 'Production recovery was verified after the guarded action.' : incident.status === 'pr_opened' ? 'A draft PR is ready for human review. Production has not been changed.' : incident.status === 'needs_human' ? 'Automatic work stopped because the evidence was not safe to act on.' : 'The controller is collecting evidence before taking action.'}</p></div>
      {incident.actionUrl && <a className="action-link" href={incident.actionUrl} target="_blank" rel="noreferrer">{actionLabel}<span aria-hidden="true">↗</span></a>}
    </section>
    {incident.decision === 'rollback' && <p className="caveat">{rollbackCaveat}</p>}
    <div className="detail-columns"><Evidence incident={incident} /><Timeline events={incident.events} /></div>
    <LiveActivity incidentId={incident.id} />
  </main>;
}

export default function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const snapshot = useIncidents(mode, selectedId, refresh);
  const selected = snapshot.detail ?? snapshot.incidents[0] ?? null;
  const counts = useMemo(() => ({ active: snapshot.incidents.filter(item => !['recovered', 'needs_human', 'pr_opened'].includes(item.status)).length, recovered: snapshot.incidents.filter(item => item.status === 'recovered').length }), [snapshot.incidents]);

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark" aria-hidden="true">✳</span><span>Nexathon <em>incident desk</em></span></div><div className="topbar-meta"><span className={`mode-dot ${mode}`} />{mode === 'fixtures' ? 'Rehearsal data' : 'Local controller'}<button className="refresh" onClick={() => setRefresh(value => value + 1)} type="button">Refresh</button></div></header>
    <div className="workspace">
      <aside className="sidebar"><div className="sidebar-heading"><div><p className="eyebrow">Operations</p><h2>Incidents</h2></div><span className="count">{snapshot.incidents.length}</span></div><div className="sidebar-stats"><span><strong>{counts.active}</strong> active</span><span><strong>{counts.recovered}</strong> recovered</span></div>
        {snapshot.loading && <p className="state-message">Loading incident evidence…</p>}
        {snapshot.error && <div className="error-box" role="alert"><strong>Controller unavailable</strong><p>{snapshot.error}</p><button onClick={() => setRefresh(value => value + 1)} type="button">Try again</button></div>}
        {!snapshot.loading && !snapshot.error && snapshot.incidents.length === 0 && <p className="state-message">No incidents recorded yet.</p>}
        <nav className="incident-list" aria-label="Incidents">{snapshot.incidents.map(incident => <IncidentCard key={incident.id} incident={incident} selected={selected?.id === incident.id} onSelect={() => setSelectedId(incident.id)} />)}</nav>
      </aside>
      {selected ? <Detail incident={selected} /> : <main className="empty-detail"><span className="empty-icon">✳</span><h1>No incident selected</h1><p>When the controller records an incident, its evidence and recovery path will appear here.</p></main>}
    </div>
  </div>;
}
