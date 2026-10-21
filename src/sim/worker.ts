/// <reference lib="webworker" />
import { runSims } from './run';
import { runQuick } from './quick';
import type { WorkerRequest, WorkerResponse } from './protocol';

const post = (msg: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.kind === 'run') {
      const summary = runSims(req.spec, req.n, req.seed, (done) => post({ id: req.id, kind: 'progress', done }));
      post({ id: req.id, kind: 'run', summary });
    } else {
      const results = req.specs.map((s) => runQuick(s, req.n, req.seed));
      post({ id: req.id, kind: 'quick', results });
    }
  } catch (err) {
    post({ id: req.id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
