import { useEffect, useMemo, useState } from 'react';
import { data, leanLabel, num, sim, useGame, partyColor } from '../../store/game';
import { demoFrom, type Res } from '../../data/types';
import { EChart, PartisanBar, PartyTag, Stat } from '../kit';
import { focusOn } from '../map/MapView';
import type { JurisdictionInfo, StateMaps } from '../../sim/game';
import { ideologyLabel } from '../../sim/issues';

export function Inspector() {
  const { selection, select, phase, mapVersion, view } = useGame();
  const [info, setInfo] = useState<JurisdictionInfo | null>(null);
  const [townRec, setTownRec] = useState<any>(null);
  const [house, setHouse] = useState<Record<string, Res> | null>(null);

  useEffect(() => {
    setHouse(null);
    if (selection?.kind !== 'cd') return;
    let live = true;
    data.houseHistory().then((h) => live && setHouse(h[selection.id] ?? null));
    return () => {
      live = false;
    };
  }, [selection]);

  useEffect(() => {
    setInfo(null);
    if (!selection || phase !== 'play') return;
    let live = true;
    sim.jurisdiction(selection.kind, selection.id).then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, [selection, phase, mapVersion]);

  useEffect(() => {
    if (selection?.kind === 'town') data.town(selection.id).then(setTownRec);
    else setTownRec(null);
  }, [selection]);

  const rec = useMemo(() => {
    if (!selection) return null;
    const { kind, id } = selection;
    if (kind === 'state') {
      const s = data.states[id];
      return s && { pop: s.pop, lean: s.lean, demo: demoFrom(s.d), pres: s.pres, senate: s.senate, gov: s.gov ?? null, label: 'State' };
    }
    if (kind === 'county') {
      const c = data.counties[id];
      return c && { pop: c.d[0] ?? 0, lean: c.lean, demo: demoFrom(c.d), pres: c.pres ?? {}, senate: null, label: c.leanSrc === 'model' ? 'County (lean modeled)' : 'County' };
    }
    if (kind === 'town') return townRec && { pop: townRec.pop, lean: townRec.lean, demo: townRec.demo, pres: null, senate: null, label: townRec.id.startsWith('M') ? 'Township / town (minor civil division)' : 'Incorporated place' };
    const d = data.districts[`${kind}:${id}`];
    const redrawn = d && !!data.activePlans[`${kind}:${d.st}`];
    const lines = redrawn ? ' (2031 lines)' : kind === 'cd' ? ' (119th)' : '';
    return d && { pop: d.pop, lean: d.lean, demo: demoFrom(d.d), pres: null, senate: null, label: `${kind === 'cd' ? 'Congressional district' : kind === 'sldu' ? 'State senate district' : 'State house district'}${lines}${d.retired ? ', eliminated in 2033' : ''}` };
    // mapVersion: district stats change when new maps are enacted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, townRec, mapVersion]);

  if (!selection || !rec) return null;
  const years = rec.pres ? Object.keys(rec.pres).filter((y) => /^\d{4}$/.test(y)).sort() : [];
  const sYears = rec.senate ? Object.keys(rec.senate).filter((y) => +y.slice(0, 4) >= 1990).sort() : [];
  const gov = 'gov' in rec ? rec.gov : null;
  const margin = (r: number[]) => (r[2] ? ((r[0] - r[1]) / r[2]) * 100 : 0);
  const mine = view?.me.homeId === selection.id;

  return (
    <aside className="panel rise absolute bottom-3 right-14 top-16 z-10 flex w-[340px] max-w-[calc(100%-80px)] flex-col overflow-hidden shadow-2xl max-md:bottom-auto max-md:max-h-[55%]">
      <header className="flex items-start justify-between gap-2 border-b p-3 hairline">
        <div className="min-w-0">
          <div className="label">{rec.label}</div>
          <h2 className="truncate text-base font-semibold">{selection.name}</h2>
          {mine && <span className="chip mt-1" style={{ background: 'var(--accent)', color: 'var(--panel)' }}>Your home</span>}
        </div>
        <div className="flex shrink-0 gap-1">
          <button className="btn-ghost !px-2" onClick={() => focusOn(selection.kind, selection.id)} title="Zoom to">⤢</button>
          <button className="btn-ghost !px-2" onClick={() => select(null)} title="Close" aria-label="Close inspector">✕</button>
        </div>
      </header>
      <div className="scroll-thin flex-1 space-y-3 overflow-y-auto p-3">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Population" value={num(Math.round(rec.pop))} />
          <Stat label="Lean" value={<span style={{ color: rec.lean >= 0.5 ? 'var(--dem)' : 'var(--rep)' }}>{leanLabel(rec.lean)}</span>} />
          <Stat label="Density" value={`${num(Math.round(rec.demo.density))}`} sub="per sq mi" />
        </div>
        <PartisanBar d={rec.lean} />

        {years.length > 0 && (
          <div>
            <div className="label mb-1">Presidential margin (real results)</div>
            <EChart
              height={130}
              option={{
                xAxis: { type: 'category', data: years },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => (v > 0 ? `D+${v}` : v < 0 ? `R+${-v}` : '0') } },
                tooltip: { trigger: 'axis', valueFormatter: (v: any) => (v > 0 ? `D+${(+v).toFixed(1)}` : `R+${(-v).toFixed(1)}`) },
                series: [
                  {
                    type: 'bar',
                    data: years.map((y) => ({ value: +margin(rec.pres![y]).toFixed(1), itemStyle: { color: margin(rec.pres![y]) > 0 ? '#3b82f6' : '#ef4444', borderRadius: 2 } })),
                    barMaxWidth: 18,
                  },
                ],
              }}
            />
          </div>
        )}
        {sYears.length > 0 && (
          <div>
            <div className="label mb-1">U.S. Senate margin (real results)</div>
            <EChart
              height={110}
              option={{
                xAxis: { type: 'category', data: sYears.map((y) => y.replace('s', '*')) },
                yAxis: { type: 'value' },
                tooltip: { trigger: 'axis', valueFormatter: (v: any) => (v > 0 ? `D+${(+v).toFixed(1)}` : `R+${(-v).toFixed(1)}`) },
                series: [{ type: 'bar', data: sYears.map((y) => ({ value: +margin(rec.senate![y]).toFixed(1), itemStyle: { color: margin(rec.senate![y]) > 0 ? '#3b82f6' : '#ef4444' } })), barMaxWidth: 12 }],
              }}
            />
          </div>
        )}

        {gov && Object.keys(gov).length > 0 && (
          <div>
            <div className="label mb-1">Governor margin (real results)</div>
            <MarginChart res={gov} />
          </div>
        )}
        {house && (
          <div>
            <div className="label mb-1">U.S. House margin (real results)</div>
            <MarginChart res={house} />
            <div className="muted mt-1 text-[11px]">Lines were redrawn after each census (and mid-decade in some states), so older results are for the district that had this number. Bars at ±100 were uncontested.</div>
          </div>
        )}

        <div>
          <div className="label mb-1">Demographics (ACS 2019–23)</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <Row k="Median age" v={rec.demo.age.toFixed(1)} />
            <Row k="Median income" v={`$${num(Math.round(rec.demo.income))}`} />
            <Row k="Bachelor's+" v={`${(rec.demo.college * 100).toFixed(0)}%`} />
            <Row k="White" v={`${(rec.demo.white * 100).toFixed(0)}%`} />
            <Row k="Black" v={`${(rec.demo.black * 100).toFixed(0)}%`} />
            <Row k="Hispanic" v={`${(rec.demo.hispanic * 100).toFixed(0)}%`} />
            <Row k="Asian" v={`${(rec.demo.asian * 100).toFixed(0)}%`} />
          </div>
        </div>

        {info?.chambers && (
          <div>
            <div className="label mb-1">Chamber control (simulated)</div>
            <div className="space-y-1.5">
              {Object.entries(info.chambers).map(([ch, c]) => {
                const tot = (c.D ?? 0) + (c.R ?? 0) + (c.I ?? 0) || 1;
                return (
                  <div key={ch}>
                    <div className="flex justify-between text-xs">
                      <span>{ch}</span>
                      <span className="num">
                        <span style={{ color: 'var(--dem)' }}>{c.D ?? 0}D</span> · <span style={{ color: 'var(--rep)' }}>{c.R ?? 0}R</span>
                        {c.I ? ` · ${c.I}I` : ''}
                      </span>
                    </div>
                    <PartisanBar d={(c.D ?? 0) / tot} height={6} labels={false} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {selection.kind === 'state' && phase === 'play' && <Redistricting st={selection.id} />}

        {phase === 'play' && (
          <div>
            <div className="label mb-1">Officeholders</div>
            {!info && <div className="muted text-xs">Loading…</div>}
            {info && info.offices.length === 0 && <div className="muted text-xs">No offices modeled here (no county government in CT/RI).</div>}
            <ul className="space-y-1.5">
              {info?.offices.map((o) => (
                <li key={o!.officeId} className="panel-2 flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
                  <div className="min-w-0">
                    <div className="truncate font-medium" style={{ color: o!.holder?.isPlayer ? 'var(--accent)' : undefined }}>
                      {o!.holder?.name ?? 'Vacant'} {o!.holder?.isPlayer && '(you)'}
                      {o!.holder?.rival && <span className="chip ml-1 align-middle" style={{ border: '1px solid var(--rep)', color: 'var(--rep)' }} title="One of your rivals (Career tab)">Rival</span>}
                    </div>
                    <div className="muted truncate">
                      {o!.title} · next {o!.nextElection}
                      {o!.holder && ` · ${ideologyLabel(o!.holder.ideology)}`}
                    </div>
                  </div>
                  {o!.holder && (o!.partisan ? <PartyTag party={o!.holder.party} /> : <span className="chip" style={{ border: `1px solid ${partyColor(o!.holder.party)}`, color: partyColor(o!.holder.party) }}>NP</span>)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}

const PLAN_LABEL: Record<string, string> = { fair: 'Fair map', D: 'Democratic gerrymander', R: 'Republican gerrymander', keep: 'Old lines kept' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Reapportionment and the state's maps after the 2030 census: enacted, or who will draw them. */
function Redistricting({ st }: { st: string }) {
  const { mapVersion } = useGame();
  const [info, setInfo] = useState<StateMaps | null>(null);
  useEffect(() => {
    let live = true;
    sim.stateMaps(st).then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, [st, mapVersion]);
  if (!info?.maps.length) return null;
  const cd = info.maps.find((m) => m.kind === 'cd');
  return (
    <div>
      <div className="label mb-1">Redistricting after the {info.census} census</div>
      {info.seats?.now != null && (
        <div className="mb-1 text-xs">
          U.S. House seats: {info.seats.before} → <span className="font-semibold">{info.seats.now}</span>
          {info.seats.now !== info.seats.before && <span className="muted"> ({info.seats.now > info.seats.before! ? '+' : ''}{info.seats.now - info.seats.before!})</span>}
        </div>
      )}
      <ul className="space-y-1 text-xs">
        {info.maps.map((m) => (
          <li key={m.kind} className="flex justify-between gap-2 border-b pb-1 hairline">
            <span className="shrink-0 capitalize">{m.label}</span>
            <span className="muted text-right">
              {m.enacted ? `${PLAN_LABEL[m.plan ?? 'fair']}, by ${m.by}` : `${MONTHS[m.when - 1]} ${info.census + 1}: ${m.keep ? 'old lines kept' : m.by}`}
              {m.expected && ` · ${Math.round(m.expected.D)}D–${Math.round(m.expected.R)}R expected`}
              {m.challenged && ' · in court'}
            </span>
          </li>
        ))}
      </ul>
      {cd?.range && !cd.enacted && (
        <div className="muted mt-1 text-[11px]">
          Democratic seats under each possible House map: Democratic gerrymander {cd.range.D.toFixed(1)}, fair {cd.range.fair?.toFixed(1)}, Republican gerrymander {cd.range.R.toFixed(1)}.
        </div>
      )}
    </div>
  );
}

/** Bar chart of D–R margins by year (specials marked *, uncontested races shown at ±100). */
function MarginChart({ res }: { res: Record<string, Res> }) {
  const years = Object.keys(res).filter((y) => +y.slice(0, 4) >= 1998).sort();
  const m = (r: Res) => (r[2] ? ((r[0] - r[1]) / r[2]) * 100 : r[0] ? 100 : r[1] ? -100 : 0);
  const fmt = (v: number) => (Math.abs(v) >= 100 ? (v > 0 ? 'D unopposed' : 'R unopposed') : v > 0 ? `D+${v.toFixed(1)}` : `R+${(-v).toFixed(1)}`);
  return (
    <EChart
      height={110}
      option={{
        xAxis: { type: 'category', data: years.map((y) => y.replace('s', '*')) },
        yAxis: { type: 'value', min: (v: any) => Math.max(-100, Math.min(0, Math.floor(v.min / 10) * 10)), max: (v: any) => Math.min(100, Math.max(0, Math.ceil(v.max / 10) * 10)) },
        tooltip: { trigger: 'axis', valueFormatter: (v: any) => fmt(+v) },
        series: [{ type: 'bar', data: years.map((y) => ({ value: +m(res[y]).toFixed(1), itemStyle: { color: m(res[y]) > 0 ? '#3b82f6' : '#ef4444', opacity: res[y][2] ? 1 : 0.4 } })), barMaxWidth: 12 }],
      }}
    />
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2 border-b pb-1 hairline">
      <span className="muted">{k}</span>
      <span className="num font-medium">{v}</span>
    </div>
  );
}
