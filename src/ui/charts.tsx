import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Hist } from '../lib/stats';

export function useWidth<T extends HTMLElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || fallback);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setW(Math.max(200, entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

export interface Marker {
  value: number;
  label: string;
  tone?: 'ink' | 'accent';
}

/** Integer-valued distribution as bars. Colors come from `colorFor` so a margin chart can split by side. */
export function Histogram(props: {
  hist: ReturnType<Hist['toJSON']>;
  colorFor: (v: number) => string;
  markers?: Marker[];
  fmt: (v: number) => string;
  tip: (v: number, p: number) => string;
  height?: number;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const h = useMemo(() => Hist.from(props.hist), [props.hist]);
  const height = props.height ?? 180;
  const lo = Math.min(h.quantile(0.004), ...(props.markers ?? []).map((m) => Math.floor(m.value)));
  const hi = Math.max(h.quantile(0.996), ...(props.markers ?? []).map((m) => Math.ceil(m.value)));
  const bins: { v: number; p: number }[] = [];
  for (let v = lo; v <= hi; v++) bins.push({ v, p: h.probEq(v) });
  const maxP = Math.max(...bins.map((b) => b.p), 1e-6);
  const nMarkers = props.markers?.length ?? 0;
  const pad = { l: 8, r: 8, t: nMarkers > 1 ? 40 : 26, b: 26 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const bw = iw / bins.length;
  const x = (v: number) => pad.l + (v - lo + 0.5) * bw;
  const ticks = niceTicks(lo, hi, Math.max(3, Math.floor(iw / 70)));
  const hb = hover != null ? bins.find((b) => b.v === hover) : undefined;

  const onMove = (e: PointerEvent) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const v = Math.round(lo + (px - pad.l) / bw - 0.5);
    setHover(v >= lo && v <= hi ? v : null);
  };

  return (
    <div class="chart" ref={ref}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={props.ariaLabel} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <line x1={pad.l} x2={width - pad.r} y1={pad.t + ih} y2={pad.t + ih} class="axis" />
        {bins.map((b) => {
          const bh = (b.p / maxP) * ih;
          if (bh <= 0) return null;
          const gap = bw > 5 ? 1 : 0;
          const r = Math.min(2, (bw - 2 * gap) / 2);
          return (
            <path
              key={b.v}
              d={roundedTop(x(b.v) - bw / 2 + gap, pad.t + ih - bh, Math.max(0.5, bw - 2 * gap), bh, r)}
              fill={props.colorFor(b.v)}
              opacity={hover == null || hover === b.v ? 1 : 0.45}
            />
          );
        })}
        {(props.markers ?? []).map((m, i, all) => {
          const mx = pad.l + (m.value - lo + 0.5) * bw;
          // Stack labels when two markers sit close together.
          const crowded = all.some((o, j) => j < i && Math.abs(pad.l + (o.value - lo + 0.5) * bw - mx) < 110);
          const ly = pad.t - 9 - (crowded ? 14 : 0);
          return (
            <g key={i} class={`marker ${m.tone ?? 'ink'}`}>
              <line x1={mx} x2={mx} y1={ly + 4} y2={pad.t + ih} />
              <text x={clampX(mx, width)} y={ly} text-anchor="middle">
                {m.label}
              </text>
            </g>
          );
        })}
        {ticks.map((t) => (
          <text key={t} class="tick" x={x(t)} y={height - 8} text-anchor="middle">
            {props.fmt(t)}
          </text>
        ))}
      </svg>
      {hb && (
        <div class="tooltip" style={{ left: `${Math.min(Math.max(x(hb.v) / width, 0.12), 0.88) * 100}%` }}>
          {props.tip(hb.v, hb.p)}
        </div>
      )}
    </div>
  );
}

const clampX = (x: number, w: number) => Math.min(Math.max(x, 40), w - 40);

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** Two-team probability bar with labels inside. */
export function SplitBar(props: { left: { label: string; p: number; color: string; ink: string }; right: { label: string; p: number; color: string; ink: string } }) {
  const { left, right } = props;
  return (
    <div class="splitbar" role="img" aria-label={`${left.label} ${(left.p * 100).toFixed(1)}%, ${right.label} ${(right.p * 100).toFixed(1)}%`}>
      <div style={{ flexGrow: Math.max(left.p, 0.02), background: left.color, color: left.ink }}>
        <span>{left.label}</span>
        <b>{(left.p * 100).toFixed(1)}%</b>
      </div>
      <div style={{ flexGrow: Math.max(right.p, 0.02), background: right.color, color: right.ink }}>
        <b>{(right.p * 100).toFixed(1)}%</b>
        <span>{right.label}</span>
      </div>
    </div>
  );
}

export interface Series {
  name: string;
  color: string;
  dashed?: boolean;
  points: { x: number; y: number }[];
}

/** Win-probability style line chart: y in [0,1], x in game seconds, period grid lines. */
export function ProbLine(props: {
  series: Series[];
  xMax: number;
  periods: number[];
  periodLabel: (i: number) => string;
  topLabel: string;
  bottomLabel: string;
  selected?: number;
  onPick?: (x: number) => void;
  describe: (x: number) => ComponentChildren;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hx, setHx] = useState<number | null>(null);
  const height = props.height ?? 220;
  const pad = { l: 34, r: 10, t: 12, b: 24 };
  const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
  const X = (v: number) => pad.l + (v / props.xMax) * iw;
  const Y = (p: number) => pad.t + (1 - p) * ih;
  const toX = (e: PointerEvent) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    return Math.min(props.xMax, Math.max(0, ((px - pad.l) / iw) * props.xMax));
  };
  const path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const valueAt = (s: Series, x: number) => {
    let best = s.points[0];
    for (const p of s.points) if (p.x <= x) best = p;
    return best?.y;
  };
  return (
    <div class="chart" ref={ref}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Win probability through the game"
        onPointerMove={(e) => setHx(toX(e))}
        onPointerLeave={() => setHx(null)}
        onClick={(e) => props.onPick?.(toX(e as unknown as PointerEvent))}
        style={{ cursor: props.onPick ? 'pointer' : 'default' }}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <g key={p}>
            <line class={p === 0.5 ? 'axis' : 'grid'} x1={pad.l} x2={width - pad.r} y1={Y(p)} y2={Y(p)} />
            <text class="tick" x={pad.l - 6} y={Y(p) + 4} text-anchor="end">
              {p === 1 ? '100' : p === 0 ? '100' : p === 0.5 ? '50' : '75'}
            </text>
          </g>
        ))}
        <text class="tick strong" x={pad.l + 4} y={pad.t + 12}>{props.topLabel}</text>
        <text class="tick strong" x={pad.l + 4} y={pad.t + ih - 5}>{props.bottomLabel}</text>
        {props.periods.map((ps, i) => (
          <g key={i}>
            <line class="grid" x1={X(ps)} x2={X(ps)} y1={pad.t} y2={pad.t + ih} />
            <text class="tick" x={X(ps) + 4} y={height - 6}>{props.periodLabel(i)}</text>
          </g>
        ))}
        {props.series.map((s) => (
          <path key={s.name} d={path(s.points)} fill="none" stroke={s.color} stroke-width={2} stroke-dasharray={s.dashed ? '5 4' : undefined} stroke-linejoin="round" />
        ))}
        {props.selected != null && <line class="pick" x1={X(props.selected)} x2={X(props.selected)} y1={pad.t} y2={pad.t + ih} />}
        {hx != null && (
          <g>
            <line class="crosshair" x1={X(hx)} x2={X(hx)} y1={pad.t} y2={pad.t + ih} />
            {props.series.map((s) => {
              const v = valueAt(s, hx);
              return v == null ? null : <circle key={s.name} cx={X(hx)} cy={Y(v)} r={4} fill={s.color} class="dot" />;
            })}
          </g>
        )}
      </svg>
      {hx != null && (
        <div class="tooltip" style={{ left: `${Math.min(Math.max(X(hx) / width, 0.15), 0.85) * 100}%` }}>
          {props.describe(hx)}
          {props.series.map((s) => {
            const v = valueAt(s, hx);
            return v == null ? null : (
              <div key={s.name} class="tt-row">
                <i style={{ background: s.color }} />
                {s.name}: {(Math.max(v, 1 - v) * 100).toFixed(0)}%
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** p10–p90 range with a mean dot, scaled to `max`. Used inline in tables. */
export function RangeDot(props: { lo: number; mid: number; hi: number; max: number; color: string; actual?: number }) {
  const w = 120, h = 16;
  const X = (v: number) => 4 + (Math.min(v, props.max) / props.max) * (w - 8);
  return (
    <svg class="rangedot" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <line class="track" x1={4} x2={w - 4} y1={h / 2} y2={h / 2} />
      <line x1={X(props.lo)} x2={X(props.hi)} y1={h / 2} y2={h / 2} stroke={props.color} stroke-width={4} stroke-linecap="round" opacity={0.45} />
      <circle cx={X(props.mid)} cy={h / 2} r={4.5} fill={props.color} class="dot" />
      {props.actual != null && <path class="actual" d={`M${X(props.actual)},2 l4,6 l-4,6 l-4,-6Z`} />}
    </svg>
  );
}

/** Horizontal bars around zero (e.g. minutes gained/lost, win-probability swing). */
export function DeltaBars(props: { rows: { label: string; value: number; note?: string }[]; fmt: (v: number) => string; pos: string; neg: string }) {
  const max = Math.max(...props.rows.map((r) => Math.abs(r.value)), 1e-6);
  return (
    <div class="deltabars">
      {props.rows.map((r) => (
        <div class="db-row" key={r.label}>
          <span class="db-label">{r.label}</span>
          <span class="db-track">
            <span class="db-zero" />
            <span
              class="db-bar"
              style={{
                background: r.value >= 0 ? props.pos : props.neg,
                width: `${(Math.abs(r.value) / max) * 50}%`,
                left: r.value >= 0 ? '50%' : `${50 - (Math.abs(r.value) / max) * 50}%`,
              }}
            />
          </span>
          <span class="db-val">{props.fmt(r.value)}</span>
          {r.note && <span class="db-note">{r.note}</span>}
        </div>
      ))}
    </div>
  );
}

/** Predicted probability (x) vs how often it happened (y); dots sized by sample, diagonal = perfect. */
export function Reliability(props: { bins: { lo: number; hi: number; n: number; meanP: number; rate: number }[]; color: string }) {
  const [ref, width] = useWidth<HTMLDivElement>(360);
  const [hover, setHover] = useState<number | null>(null);
  const size = Math.min(width, 420);
  const pad = 36;
  const inner = size - pad - 12;
  const X = (p: number) => pad + p * inner;
  const Y = (p: number) => 12 + (1 - p) * inner;
  const maxN = Math.max(1, ...props.bins.map((b) => b.n));
  const shown = props.bins.map((b, i) => ({ ...b, i })).filter((b) => b.n > 0);
  const hb = hover != null ? props.bins[hover] : undefined;
  return (
    <div class="chart reliability" ref={ref}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="Calibration: predicted win chance against how often the home team actually won">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line class="grid" x1={X(0)} x2={X(1)} y1={Y(t)} y2={Y(t)} />
            <text class="tick" x={pad - 6} y={Y(t) + 4} text-anchor="end">{Math.round(t * 100)}</text>
            <text class="tick" x={X(t)} y={size - 2} text-anchor="middle">{Math.round(t * 100)}</text>
          </g>
        ))}
        <line class="axis diag" x1={X(0)} y1={Y(0)} x2={X(1)} y2={Y(1)} />
        {shown.map((b) => (
          <circle
            key={b.i}
            cx={X(b.meanP)}
            cy={Y(b.rate)}
            r={4 + 8 * Math.sqrt(b.n / maxN)}
            fill={props.color}
            fill-opacity={hover == null || hover === b.i ? 0.85 : 0.35}
            class="dot"
            onPointerEnter={() => setHover(b.i)}
            onPointerLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {hb && (
        <div class="tooltip" style={{ left: `${(X(hb.meanP) / size) * 100}%` }}>
          Predicted {Math.round(hb.meanP * 100)}% · happened {Math.round(hb.rate * 100)}% · {hb.n} game{hb.n === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}
