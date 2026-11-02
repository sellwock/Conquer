// Runs simulations off the main thread. Each job gets a dedicated worker so a superseded job can
// be killed outright instead of finishing in the background.
import SimWorker from './worker?worker&inline';
import { runSims, type SimSummary } from './run';
import { runOutcomes, runQuick, type Outcomes, type QuickResult } from './quick';
import type { WorkerRequest, WorkerResponse } from './protocol';
import type { SimSpec } from './types';

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

let nextId = 1;
const supportsWorkers = typeof Worker !== 'undefined';

export interface Job<T> {
  promise: Promise<T>;
  cancel: () => void;
}

type NewRequest = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never;

function startJob<T>(req: NewRequest, pick: (r: WorkerResponse) => T | undefined, onProgress?: (done: number) => void): Job<T> {
  const id = nextId++;
  let worker: Worker | null = null;
  let rejectFn: (e: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    rejectFn = reject;
    worker = new SimWorker();
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.kind === 'progress') {
        onProgress?.(msg.done);
        return;
      }
      worker?.terminate();
      worker = null;
      if (msg.kind === 'error') reject(new Error(msg.message));
      else {
        const v = pick(msg);
        if (v === undefined) reject(new Error('Unexpected worker response'));
        else resolve(v);
      }
    };
    worker.onerror = (e) => {
      worker?.terminate();
      worker = null;
      reject(new Error(e.message || 'Simulation worker failed'));
    };
    worker.postMessage({ ...req, id } as WorkerRequest);
  });
  return {
    promise,
    cancel: () => {
      if (worker) {
        worker.terminate();
        worker = null;
        rejectFn(new CancelledError());
      }
    },
  };
}

export function runInBackground(spec: SimSpec, n: number, seed: string, onProgress?: (done: number) => void): Job<SimSummary> {
  if (!supportsWorkers) return { promise: Promise.resolve(runSims(spec, n, seed, onProgress)), cancel: () => {} };
  return startJob({ kind: 'run', spec, n, seed }, (r) => (r.kind === 'run' ? r.summary : undefined), onProgress);
}

export function runQuickInBackground(specs: SimSpec[], n: number, seed: string): Job<QuickResult[]> {
  if (!supportsWorkers) return { promise: Promise.resolve(specs.map((s) => runQuick(s, n, seed))), cancel: () => {} };
  return startJob({ kind: 'quick', specs, n, seed }, (r) => (r.kind === 'quick' ? r.results : undefined));
}

export function runOutcomesInBackground(spec: SimSpec, n: number, seed: string, opts: { players?: boolean } = {}): Job<Outcomes> {
  if (!supportsWorkers) return { promise: Promise.resolve(runOutcomes(spec, n, seed, opts)), cancel: () => {} };
  return startJob({ kind: 'outcomes', spec, n, seed, players: opts.players }, (r) => (r.kind === 'outcomes' ? r.outcomes : undefined));
}
