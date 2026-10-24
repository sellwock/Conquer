import type { SimSummary } from './run';
import type { Outcomes, QuickResult } from './quick';
import type { SimSpec } from './types';

export type WorkerRequest =
  | { id: number; kind: 'run'; spec: SimSpec; n: number; seed: string }
  | { id: number; kind: 'quick'; specs: SimSpec[]; n: number; seed: string }
  | { id: number; kind: 'outcomes'; spec: SimSpec; n: number; seed: string };

export type WorkerResponse =
  | { id: number; kind: 'progress'; done: number }
  | { id: number; kind: 'run'; summary: SimSummary }
  | { id: number; kind: 'quick'; results: QuickResult[] }
  | { id: number; kind: 'outcomes'; outcomes: Outcomes }
  | { id: number; kind: 'error'; message: string };
