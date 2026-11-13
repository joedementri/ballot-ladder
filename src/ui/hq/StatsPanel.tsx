import { useEffect, useState } from 'react';
import { money, pct, sim, useGame } from '../../store/game';
import type { NationalInfo } from '../../sim/game';
import { ISSUES } from '../../sim/issues';
import { Card, EChart, PartisanBar, Stat, css } from '../kit';

export function StatsPanel() {
  const { view, mapVersion } = useGame();
  const [nat, setNat] = useState<NationalInfo | null>(null);
  useEffect(() => {
    sim.national().then(setNat);
  }, [mapVersion]);
  if (!view) return null;
  const w = view.world;
  const h = view.history;
  const labels = h.map((x) => `${x.month}/${String(x.year).slice(2)}`);
  const legis = nat ? Object.values(nat.legislatures) : [];
  const line = (name: string, data: number[], color: string, extra: object = {}) => ({ name, type: 'line' as const, smooth: true, symbol: 'none', data, lineStyle: { color, width: 2 }, itemStyle: { color }, ...extra });

  return (
    <div className="space-y-3">
      <Card title="National snapshot">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Pres. approval" value={pct(w.presApproval)} sub={`${w.presParty === 'D' ? 'Democratic' : 'Republican'} president`} />
          <Stat label="Generic ballot" value={w.genericBallot >= 0 ? `D+${w.genericBallot.toFixed(1)}` : `R+${(-w.genericBallot).toFixed(1)}`} />
          <Stat label="Right track" value={pct(w.rightTrack)} />
          <Stat label="Unemployment" value={`${w.unemployment.toFixed(1)}%`} />
          <Stat label="Inflation" value={`${w.inflation.toFixed(1)}%`} />
          <Stat label="GDP growth" value={`${w.gdp.toFixed(1)}%`} />
        </div>
      </Card>

      {nat && (
        <Card title="Balance of power (simulated)">
          <div className="space-y-2">
            {[['U.S. House', nat.house, 435], ['U.S. Senate', nat.senate, 100], ['Governors', nat.governors, 50], ['State legislatures', { D: legis.filter((x) => x === 'D').length, R: legis.filter((x) => x === 'R').length, S: legis.filter((x) => x === 'S').length }, 50]].map(([name, c]: any) => (
              <div key={name}>
                <div className="flex justify-between text-xs">
                  <span>{name}</span>
                  <span className="num"><span style={{ color: 'var(--dem)' }}>{c.D ?? 0} D</span> · <span style={{ color: 'var(--rep)' }}>{c.R ?? 0} R</span>{c.I ? ` · ${c.I} I` : ''}{c.S ? ` · ${c.S} split` : ''}</span>
                </div>
                <div className="relative">
                  <PartisanBar d={(c.D ?? 0) / ((c.D ?? 0) + (c.R ?? 0) || 1)} height={8} labels={false} />
                  <div className="absolute inset-y-0 left-1/2 w-px" style={{ background: 'var(--text)', opacity: 0.5 }} />
                </div>
              </div>
            ))}
          </div>
          {nat.pres?.holder && <div className="muted mt-2 text-xs">President: {nat.pres.holder.name} ({nat.pres.holder.party}), in office since {nat.pres.holder.since}</div>}
        </Card>
      )}

      <Card title="Approval & generic ballot">
        <EChart
          height={160}
          option={{
            legend: { top: 0, textStyle: { color: css('--muted'), fontSize: 10 }, itemHeight: 6 },
            grid: { top: 26, right: 30 },
            xAxis: { type: 'category', data: labels },
            yAxis: [{ type: 'value', min: 0.25, max: 0.7, axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` } }, { type: 'value', min: -12, max: 12, splitLine: { show: false }, axisLabel: { color: css('--muted'), fontSize: 10 } }] as any,
            series: [line('Pres. approval', h.map((x) => x.presApproval), '#f59e0b'), line('Generic ballot (D–R)', h.map((x) => x.generic), '#8b5cf6', { yAxisIndex: 1 })],
          }}
        />
      </Card>

      <Card title="Economy">
        <EChart
          height={150}
          option={{
            legend: { top: 0, textStyle: { color: css('--muted'), fontSize: 10 }, itemHeight: 6 },
            grid: { top: 26 },
            xAxis: { type: 'category', data: labels },
            yAxis: { type: 'value', axisLabel: { formatter: '{value}%' } },
            series: [line('Unemployment', h.map((x) => x.unemployment), '#0ea5e9'), line('Inflation', h.map((x) => x.inflation), '#f43f5e')],
          }}
        />
      </Card>

      <Card title="What voters care about">
        <EChart
          height={230}
          option={{
            grid: { left: 110, right: 16, top: 6, bottom: 16 },
            xAxis: { type: 'value', max: 1, axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}` } },
            yAxis: { type: 'category', data: ISSUES.map((i) => i.label), inverse: true, axisLabel: { color: css('--muted'), fontSize: 10 } },
            tooltip: { trigger: 'axis', valueFormatter: (v: any) => `${Math.round(v * 100)} salience` },
            series: [{ type: 'bar', data: w.salience.map((v) => +v.toFixed(2)), itemStyle: { color: css('--accent'), borderRadius: 3 }, barMaxWidth: 12 }],
          }}
        />
      </Card>

      <Card title="Your trajectory">
        <EChart
          height={160}
          option={{
            legend: { top: 0, textStyle: { color: css('--muted'), fontSize: 10 }, itemHeight: 6 },
            grid: { top: 26, right: 44 },
            xAxis: { type: 'category', data: labels },
            yAxis: [{ type: 'value', min: 0, max: 1, axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` } }, { type: 'value', splitLine: { show: false }, axisLabel: { formatter: (v: number) => money(v), color: css('--muted'), fontSize: 10 } }] as any,
            tooltip: { trigger: 'axis' },
            series: [line('Approval / favorability', h.map((x) => x.approval), css('--accent')), line('Name recognition', h.map((x) => x.rec), '#f59e0b'), { ...line('Campaign cash', h.map((x) => x.cash), '#64748b'), yAxisIndex: 1, lineStyle: { type: 'dashed', color: '#64748b' } }],
          }}
        />
      </Card>
    </div>
  );
}
