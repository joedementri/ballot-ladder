import { useEffect, useMemo, useState } from 'react';
import { money, sim, useGame, num } from '../../store/game';
import { ACTIONS, GROUPS, STAFF_ROLES, STAFF_TIER, groupAlignment, staffCost, type ActionDef } from '../../sim/campaign';
import { ISSUES } from '../../sim/issues';
import { Card } from '../kit';

type Target = { id: string; label: string; pop: number; rec: number };

/** Grid of actions the player can take this month, with inline target pickers. */
export function Actions() {
  const { view, run, busy } = useGame();
  const [targets, setTargets] = useState<Target[]>([]);
  const [costs, setCosts] = useState<Record<string, { ap: number; cash: number }>>({});
  const [sel, setSel] = useState<Record<string, string>>({});
  const [cat, setCat] = useState<ActionDef['category'] | 'All'>('All');
  const campaignKey = `${view?.campaign?.officeId}|${view?.me.office?.id}`;

  useEffect(() => {
    sim.targets().then(setTargets);
    Promise.all(ACTIONS.map(async (a) => [a.id, await sim.actionCost(a.id)] as const)).then((r) => setCosts(Object.fromEntries(r)));
  }, [campaignKey, view?.month]);

  if (!view) return null;
  const P = view.player;
  const c = view.campaign;
  const level = Math.max(view.me.office?.level ?? 1, c?.level ?? 1);
  const opps = c?.field.filter((f) => !f.isPlayer) ?? [];
  const cats = ['All', 'Money', 'Outreach', 'Media', 'Policy', 'Organization', 'Personal'] as const;
  const visible = ACTIONS.filter((a) => (cat === 'All' || a.category === cat) && (!a.needsCampaign || (c && c.stage !== 'done')));

  const options = (a: ActionDef): { value: string; label: string }[] => {
    switch (a.target) {
      case 'unit':
        return targets.map((t) => ({ value: t.id, label: `${t.label} · ${num(t.pop)} · ${(t.rec * 100).toFixed(0)}% know you` }));
      case 'issue':
        return ISSUES.map((i) => ({ value: i.key, label: i.label }));
      case 'group':
        return GROUPS.map((g) => ({ value: g.key, label: `${g.label} (${groupAlignment(view.me.pos, g) >= 0.1 ? 'aligned' : groupAlignment(view.me.pos, g) <= -0.1 ? 'opposed' : 'mixed'})` }));
      case 'opponent':
        return opps.map((o) => ({ value: o.id, label: `${o.name} (${o.party})` }));
      case 'staff':
        return STAFF_ROLES.filter((r) => P.staff[r.key] < 3).map((r) => ({ value: r.key, label: `${r.label}: ${STAFF_TIER[P.staff[r.key]]} → ${STAFF_TIER[P.staff[r.key] + 1]} (${money(staffCost(P.staff[r.key] + 1, level))}/mo)` }));
      case 'amount':
        return [0.1, 0.25, 0.5, 1].map((f) => ({ value: String(Math.floor(P.personal * f)), label: `${money(Math.floor(P.personal * f))} (${f * 100}% of savings)` }));
      default:
        return [];
    }
  };

  return (
    <Card
      title={`Actions — ${P.ap}/${P.apMax} AP`}
      right={
        <select className="input !w-auto !py-0.5 !text-xs" value={cat} onChange={(e) => setCat(e.target.value as any)} aria-label="Action category">
          {cats.map((x) => <option key={x}>{x}</option>)}
        </select>
      }
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {visible.map((a) => {
          const cost = costs[a.id] ?? { ap: a.ap, cash: 0 };
          const opts = options(a);
          const target = sel[a.id] ?? opts[0]?.value;
          const disabled = busy || P.ap < cost.ap || P.cash < cost.cash || (a.target !== 'none' && !target);
          return (
            <div key={a.id} className="panel-2 flex flex-col gap-1.5 p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium leading-tight">{a.label}</div>
                  <div className="muted text-[11px] leading-snug">{a.desc}</div>
                </div>
                <div className="shrink-0 text-right text-[11px] num">
                  <div className="font-semibold">{cost.ap} AP</div>
                  {cost.cash > 0 && <div className="muted">{money(cost.cash)}</div>}
                </div>
              </div>
              {opts.length > 0 && (
                <select className="input !py-1 !text-xs" value={target} onChange={(e) => setSel({ ...sel, [a.id]: e.target.value })} aria-label={`${a.label} target`}>
                  {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              )}
              <button className="btn-primary !py-1 !text-xs" disabled={disabled} onClick={() => run(async () => sim.act(a.id, target))}>
                Do it
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function useCandColors(field: { id: string; party: string; isPlayer: boolean }[] | undefined) {
  return useMemo(() => {
    const out: Record<string, string> = {};
    const shades: Record<string, string[]> = { D: ['#3b82f6', '#60a5fa', '#1d4ed8', '#93c5fd'], R: ['#ef4444', '#f87171', '#b91c1c', '#fca5a5'], I: ['#a78bfa', '#7c3aed'] };
    const used: Record<string, number> = {};
    for (const f of field ?? []) {
      if (f.isPlayer) {
        out[f.id] = 'var(--accent)';
        continue;
      }
      const i = used[f.party] ?? 0;
      used[f.party] = i + 1;
      out[f.id] = (shades[f.party] ?? shades.I)[i % 4];
    }
    out.undecided = '#94a3b8';
    return out;
  }, [field]);
}
