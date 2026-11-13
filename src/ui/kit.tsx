import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HELP } from './help';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart, RadarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, MarkAreaComponent, RadarComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { partyColor, useGame } from '../store/game';

echarts.use([LineChart, BarChart, PieChart, RadarChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, MarkAreaComponent, RadarComponent, CanvasRenderer]);

export const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/** ECharts wrapper that follows the app theme and container size. */
export function EChart({ option, height = 180 }: { option: EChartsOption; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const dark = useGame((s) => s.dark);
  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
    };
  }, []);
  useEffect(() => {
    const text = css('--muted');
    const line = css('--line');
    chart.current?.setOption(
      {
        backgroundColor: 'transparent',
        textStyle: { color: text, fontFamily: 'Inter, system-ui, sans-serif' },
        animationDuration: 400,
        tooltip: { trigger: 'axis', backgroundColor: css('--panel'), borderColor: line, textStyle: { color: css('--text'), fontSize: 12 } },
        ...option,
        grid: { left: 36, right: 12, top: 18, bottom: 22, containLabel: false, ...(option.grid as object) },
        xAxis: withDefaults(option.xAxis, { axisLine: { lineStyle: { color: line } }, axisTick: { show: false }, axisLabel: { color: text, fontSize: 10 } }),
        yAxis: withDefaults(option.yAxis, { splitLine: { lineStyle: { color: line } }, axisLabel: { color: text, fontSize: 10 } }),
      } as EChartsOption,
      true,
    );
  }, [option, dark]);
  return <div ref={ref} style={{ height, width: '100%' }} />;
}

/** Merge theme defaults into an axis option (which may be a single axis or an array of axes). */
function withDefaults(axis: unknown, defaults: Record<string, unknown>) {
  if (!axis) return undefined;
  const merge = (a: Record<string, any>) => ({ ...defaults, ...a, axisLabel: { ...(defaults.axisLabel as object), ...a.axisLabel } });
  return Array.isArray(axis) ? axis.map(merge) : merge(axis as Record<string, any>);
}

/**
 * Help popover: hover or focus on desktop, tap on touch. Rendered in a portal with fixed positioning
 * so scrolling containers (top bar, panels) don't clip it.
 */
export function Tip({ tip, children, className = '' }: { tip?: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setPos(null); };
    document.addEventListener('pointerdown', close);
    window.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('scroll', close, true); };
  }, [pos]);
  if (!tip) return <>{children}</>;
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.bottom > window.innerHeight - 140;
    setPos({ x: Math.min(Math.max(r.left + r.width / 2, 130), window.innerWidth - 130), y: up ? r.top - 6 : r.bottom + 6, up });
  };
  return (
    <span
      ref={ref}
      tabIndex={0}
      className={`cursor-help underline decoration-dotted decoration-from-font underline-offset-2 ${className}`}
      style={{ textDecorationColor: 'var(--line)' }}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onFocus={show}
      onBlur={() => setPos(null)}
      // Taps fire mouseenter then click, so click only opens; a tap elsewhere or scrolling closes it.
      onClick={(e) => { e.stopPropagation(); show(); }}
    >
      {children}
      {pos &&
        createPortal(
          <span
            role="tooltip"
            className="panel pointer-events-none fixed z-[80] block w-60 p-2 text-left text-[11.5px] font-normal normal-case leading-snug tracking-normal shadow-xl"
            style={{ left: pos.x, top: pos.y, transform: `translate(-50%, ${pos.up ? '-100%' : '0'})`, color: 'var(--text)' }}
          >
            {tip}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** Wrap a string label with its help text from HELP (if any). */
export function HelpLabel({ label, help }: { label: ReactNode; help?: string }) {
  const tip = help ?? (typeof label === 'string' ? HELP[label] : undefined);
  return <Tip tip={tip}>{label}</Tip>;
}

export function Card({ title, right, children, className = '', help }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; help?: string }) {
  return (
    <section className={`panel p-3 rise ${className}`}>
      {(title || right) && (
        <header className="mb-2 flex items-center justify-between gap-2">
          <h3 className="label"><HelpLabel label={title} help={help} /></h3>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Meter({ value, color = 'var(--accent)', label, right, small, help }: { value: number; color?: string; label?: ReactNode; right?: ReactNode; small?: boolean; help?: string }) {
  return (
    <div className="w-full">
      {(label || right) && (
        <div className="mb-0.5 flex justify-between text-xs">
          <span className="muted"><HelpLabel label={label} help={help} /></span>
          <span className="num font-medium">{right}</span>
        </div>
      )}
      <div className={`w-full overflow-hidden rounded-full ${small ? 'h-1.5' : 'h-2'}`} style={{ background: 'var(--line)' }}>
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} />
      </div>
    </div>
  );
}

/** Two-sided D/R bar. */
export function PartisanBar({ d, height = 8, labels = true }: { d: number; height?: number; labels?: boolean }) {
  return (
    <div>
      <div className="flex w-full overflow-hidden rounded-full" style={{ height }}>
        <div style={{ width: `${d * 100}%`, background: 'var(--dem)' }} className="transition-[width] duration-500" />
        <div style={{ width: `${(1 - d) * 100}%`, background: 'var(--rep)' }} className="transition-[width] duration-500" />
      </div>
      {labels && (
        <div className="mt-0.5 flex justify-between text-[11px] num">
          <span style={{ color: 'var(--dem)' }}>D {(d * 100).toFixed(1)}%</span>
          <span style={{ color: 'var(--rep)' }}>R {((1 - d) * 100).toFixed(1)}%</span>
        </div>
      )}
    </div>
  );
}

export function Stat({ label, value, sub, tone, help }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad'; help?: string }) {
  return (
    <div className="min-w-0">
      <div className="label truncate"><HelpLabel label={label} help={help} /></div>
      <div className="num text-lg font-semibold leading-tight" style={{ color: tone === 'good' ? 'var(--accent)' : tone === 'bad' ? 'var(--rep)' : undefined }}>
        {value}
      </div>
      {sub && <div className="muted truncate text-[11px]">{sub}</div>}
    </div>
  );
}

export function PartyTag({ party }: { party?: string | null }) {
  return (
    <span className="chip text-white" style={{ background: partyColor(party), padding: '1px 6px' }}>
      {party ?? '–'}
    </span>
  );
}

export function Seg<T extends string>({ value, options, onChange, size = 'sm' }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: 'sm' | 'xs' }) {
  return (
    <div className="inline-flex flex-wrap rounded-lg p-0.5" style={{ background: 'var(--panel-2)', border: '1px solid var(--line)' }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2 ${size === 'xs' ? 'py-0.5 text-[11px]' : 'py-1 text-xs'} font-medium transition-colors`}
          style={o.value === value ? { background: 'var(--panel)', color: 'var(--text)', boxShadow: '0 1px 2px rgba(0,0,0,.15)' } : { color: 'var(--muted)' }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Global keyboard shortcuts: `keys` maps a lowercased key ("e", "1", "Escape") to a handler. Ignored while typing in a
 * text field (except Escape), with Ctrl/Cmd/Alt held, or on key repeat.
 */
export function useHotkeys(keys: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  const ref = useRef(keys);
  useEffect(() => {
    ref.current = keys;
  });
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key !== 'Escape' && isTyping(e.target)) return;
      const fn = ref.current[key];
      if (!fn) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [enabled]);
}

function isTyping(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit', 'file'].includes((t as HTMLInputElement).type);
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="muted rounded-lg border border-dashed p-4 text-center text-sm hairline">{children}</div>;
}
