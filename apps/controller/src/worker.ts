import type { MonitorOptions, MonitorResult } from './monitor';
import { checkProject } from './monitor';

export interface PollingWorkerOptions extends Omit<MonitorOptions, 'projectId'> {
  projectIds: string[];
  intervalMs?: number;
  startImmediately?: boolean;
  onResult?: (projectId: string, result: MonitorResult) => void | Promise<void>;
  onError?: (projectId: string) => void | Promise<void>;
}

export interface PollingWorker {
  pollNow(): Promise<void>;
  stop(): Promise<void>;
}

export function startPollingWorker(options: PollingWorkerOptions): PollingWorker {
  const projectIds = [...new Set(options.projectIds.map(id => id.trim()).filter(Boolean))];
  if (projectIds.length === 0) throw new Error('At least one monitored Vercel project ID is required.');

  const intervalMs = Math.max(1_000, Math.min(Math.trunc(options.intervalMs ?? 30_000), 300_000));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeCycle: Promise<void> | undefined;

  const runCycle = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (activeCycle) return activeCycle;

    activeCycle = (async () => {
      for (const projectId of projectIds) {
        if (stopped) break;
        let result: MonitorResult;
        try {
          result = await checkProject({ ...options, projectId });
        } catch {
          try { await options.onError?.(projectId); } catch { /* keep other projects polling */ }
          continue;
        }
        try { await options.onResult?.(projectId, result); } catch {
          try { await options.onError?.(projectId); } catch { /* keep other projects polling */ }
        }
      }
    })().finally(() => {
      activeCycle = undefined;
      if (!stopped) timer = setTimeout(() => void runCycle(), intervalMs);
    });

    return activeCycle;
  };

  const worker: PollingWorker = {
    pollNow: async () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      await runCycle();
    },
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await activeCycle;
    },
  };

  if (options.startImmediately !== false) void runCycle();
  return worker;
}
