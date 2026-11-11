import { useEffect, useState } from 'react';
import { leanLabel, num, sim, useGame } from '../../store/game';
import type { OfficeOption } from '../../sim/game';
import { Card, Empty, PartyTag } from '../kit';
import { focusOn } from '../map/MapView';
import { Opportunities } from './Opportunities';

export function RunPanel() {
  const { view, run, busy, setTab } = useGame();
  const [offices, setOffices] = useState<OfficeOption[] | null>(null);
  useEffect(() => {
    sim.availableOffices().then(setOffices);
  }, [view?.year, view?.month, view?.campaign?.officeId, view?.me.office?.id]);
  if (!view) return null;
  const running = view.campaign && view.campaign.stage !== 'done';

  return (
    <div className="space-y-3">
      <Card title="The political ladder">
        <p className="muted text-xs leading-relaxed">
          Every seat that represents <b style={{ color: 'var(--text)' }}>{view.me.homeTown}</b>. Local races are nonpartisan and held in odd years; partisan offices hold primaries before the November general. Win, govern well, build name recognition and money, then climb.
        </p>
        {running && (
          <div className="panel-2 mt-2 flex items-center justify-between p-2 text-xs">
            <span>You are running for <b>{view.campaign!.title}</b>.</span>
            <button className="btn-ghost !py-0.5 !text-xs" onClick={() => setTab('campaign')}>Go to campaign</button>
          </div>
        )}
      </Card>
      <Opportunities />
      {!offices && <Empty>Loading offices…</Empty>}
      {offices && (
        <div className="space-y-2">
          {offices.map((o) => {
            const mine = view.me.office?.id === o.id;
            return (
              <div key={o.id} className="panel rise p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="label">{o.type} · Level {o.level}{o.special && <span style={{ color: 'var(--accent)' }}> · {o.special}</span>}</div>
                    <div className="truncate font-semibold">{o.title}</div>
                    <div className="muted text-xs">
                      {o.holder === 'Vacant' ? 'Open seat' : <>Held by {o.holder} {o.holderParty && <PartyTag party={o.holderParty} />}</>}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="num text-lg font-bold">{o.year}</div>
                    <div className="muted text-[11px]">file by {o.filingBy}</div>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                  <span className="muted num">{num(o.pop)} constituents · <span style={{ color: o.lean >= 0.5 ? 'var(--dem)' : 'var(--rep)' }}>{leanLabel(o.lean)}</span></span>
                  <div className="flex gap-1">
                    <button className="btn-ghost !py-0.5 !text-xs" onClick={() => {
                      const [t, a] = o.id.split(':');
                      const kind = t === 'house' ? 'cd' : t === 'gov' || t === 'sen' ? 'state' : t === 'county' ? 'county' : t === 'council' || t === 'mayor' ? 'town' : t === 'pres' ? null : t;
                      if (kind) focusOn(kind as any, a);
                    }}>Map</button>
                    <button className="btn-primary !py-0.5 !text-xs" disabled={busy || !!running || !o.eligible} title={o.reason} onClick={() => run(async () => { const r = await sim.file(o.id); if (r.result.ok) setTab('campaign'); return r; })}>
                      {mine ? 'Seek re-election' : !o.eligible ? o.reason : 'File to run'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
