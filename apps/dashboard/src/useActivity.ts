import { useEffect, useRef, useState } from 'react';
import { ApiError, readJson } from './api';
import { parseActivityEvent, parseActivityRuns, type ActivityEvent, type ActivityRun } from './activity';
import type { DataMode } from './useIncidents';

const POLL_MS = 1500;
const MAX_EVENTS = 500;

export interface ActivitySnapshot {
  run: ActivityRun | null;
  events: ActivityEvent[];
  error: string | null;
}

/** Watches the newest controller run for this incident and streams its live events. */
export function useActivity(mode: DataMode, incidentId: string | null): ActivitySnapshot {
  const [run, setRun] = useState<ActivityRun | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const status = useRef<ActivityRun['status'] | undefined>(undefined);
  status.current = run?.status;

  useEffect(() => {
    if (mode !== 'live') return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const runs = parseActivityRuns(await readJson('/api/agent/runs', abort.signal));
        if (abort.signal.aborted) return;
        setRun(runs.find(candidate => candidate.incidentId === incidentId) ?? null);
        setError(null);
      } catch (failure) {
        if (abort.signal.aborted) return;
        setError(failure instanceof ApiError ? failure.message : 'Agent activity could not be loaded.');
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(poll, POLL_MS);
      }
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [mode, incidentId]);

  const runId = run?.id;

  useEffect(() => {
    setEvents([]);
    if (mode !== 'live' || !runId) return;
    let closed = false;
    const source = new EventSource(`/api/agent/runs/${runId}/events`);
    source.addEventListener('activity', (message) => {
      if (closed) return;
      let payload: unknown;
      try { payload = JSON.parse((message as MessageEvent<string>).data); } catch { return; }
      const event = parseActivityEvent(payload);
      if (!event) return;
      setEvents(current => [...current.filter(item => item.seq !== event.seq), event].slice(-MAX_EVENTS));
    });
    source.addEventListener('done', () => { closed = true; source.close(); });
    source.onerror = () => {
      if (closed) return;
      // A finished run closes the stream on purpose; only report an unexpected drop.
      if (status.current === 'completed' || status.current === 'failed') { source.close(); return; }
      setError('The live activity stream dropped while the run was still active.');
    };
    return () => { closed = true; source.close(); };
  }, [mode, runId]);

  return { run, events, error };
}
