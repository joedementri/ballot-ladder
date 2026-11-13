import { useEffect, useMemo, useState } from 'react';
import { data, leanLabel, num, useGame, money } from '../../store/game';
import { STATE_LIST, type Party, type Town } from '../../data/types';
import { ISSUES, PARTY_BASE, ideologyLabel, ideologyScore } from '../../sim/issues';
import { BACKGROUNDS } from '../../sim/campaign';
import type { Background, Difficulty, Skills } from '../../sim/model';
import { DIFFICULTY } from '../../sim/difficulty';
import { quickDShare, unitShares, type Candidate } from '../../sim/vote';
import { shortTownName } from '../../sim/offices';
import { PartisanBar, Seg } from '../kit';
import { focusOn } from '../map/MapView';

const SKILL_KEYS: (keyof Skills)[] = ['charisma', 'debate', 'fundraising', 'policy', 'integrity', 'organization'];
const SKILL_LABEL: Record<keyof Skills, string> = { charisma: 'Charisma', debate: 'Debate', fundraising: 'Fundraising', policy: 'Policy', integrity: 'Integrity', organization: 'Organization' };
const POOL = 60;
const BASE_SKILL = 40;

export function Creation() {
  const { newGame, busy, pickedTown, pickTown, setPhase } = useGame();
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [gender, setGender] = useState<'M' | 'F'>('F');
  const [age, setAge] = useState(32);
  const [party, setParty] = useState<Party>('D');
  const [bg, setBg] = useState<Background>('lawyer');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [st, setSt] = useState('PA');
  const [query, setQuery] = useState('');
  const [towns, setTowns] = useState<Town[]>([]);
  const [home, setHome] = useState<Town | null>(null);
  const [skills, setSkills] = useState<Skills>({ charisma: 50, debate: 50, fundraising: 50, policy: 50, integrity: 50, organization: 50 });
  const [pos, setPos] = useState<number[]>(PARTY_BASE.D.map((x) => +(x * 0.8).toFixed(2)));
  const [step, setStep] = useState(0);
  const [start, setStart] = useState<2025 | 2027>(2025);
  const [latest, setLatest] = useState<number[]>([]);
  useEffect(() => {
    data.json<{ latest?: number[] }>('meta.json').then((m) => setLatest(m.latest ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    data.townsOf(st).then(setTowns);
  }, [st]);
  useEffect(() => {
    if (!pickedTown) return;
    data.town(pickedTown).then((t) => {
      if (!t) return;
      setSt(t.st);
      setHome(t);
      setQuery(shortTownName(t.name));
    });
  }, [pickedTown]);

  const used = SKILL_KEYS.reduce((a, k) => a + skills[k] - BASE_SKILL, 0);
  const left = POOL - used;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return towns.slice(0, 8);
    return towns.filter((t) => t.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query, towns]);

  // Live electoral fit: you vs a generic opponent (general) and vs a generic same-party rival (primary), in your town.
  const fit = useMemo(() => {
    if (!home) return null;
    const unit = { id: `fit-${home.id}`, label: home.name, pop: home.pop, lean: home.lean, demo: home.demo };
    const me: Candidate = { id: 'me', name: 'me', party, pos, rec: 0.5, fav: 0.5, incumbent: 0, spend: 1, endorse: 0, scandal: 0, skill: 0.5 };
    const other: Party = party === 'R' ? 'D' : 'R';
    const opp: Candidate = { ...me, id: 'opp', party: other, pos: PARTY_BASE[other] };
    const ctx = { kind: 'general' as const, env: 0, envWeight: 1, expectedSpend: 1 };
    const general = party === 'D' ? quickDShare(unit, me, opp, ctx) : 1 - quickDShare(unit, opp, me, ctx);
    const rival: Candidate = { ...me, id: 'rival', pos: PARTY_BASE[party === 'I' ? 'D' : party] };
    const primary = party === 'I' ? null : unitShares(unit, [me, rival], { kind: 'primary', party, env: 0, envWeight: 1, expectedSpend: 1 }).shares[0];
    return { general, primary };
  }, [home, party, pos]);

  const valid = first.trim() && last.trim() && home && left >= 0;
  const setSkill = (k: keyof Skills, v: number) => setSkills((s) => ({ ...s, [k]: Math.max(20, Math.min(90, v)) }));
  const steps = ['Identity', 'Home', 'Skills', 'Platform'];

  return (
    <div className="panel rise flex max-h-full w-full flex-col overflow-hidden shadow-2xl">
      <header className="border-b p-4 hairline">
        <div className="label">New career</div>
        <h1 className="text-xl font-bold">Create your candidate</h1>
        <div className="mt-3 flex gap-1">
          {steps.map((s, i) => (
            <button key={s} onClick={() => setStep(i)} className="flex-1 rounded-md px-2 py-1 text-xs font-medium" style={{ background: i === step ? 'var(--accent)' : 'var(--panel-2)', color: i === step ? 'var(--panel)' : 'var(--muted)', border: '1px solid var(--line)' }}>
              {i + 1}. {s}
            </button>
          ))}
        </div>
      </header>
      <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-4">
        {step === 0 && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1"><span className="label">First name</span><input className="input" value={first} onChange={(e) => setFirst(e.target.value)} placeholder="Jordan" /></label>
              <label className="space-y-1"><span className="label">Last name</span><input className="input" value={last} onChange={(e) => setLast(e.target.value)} placeholder="Reyes" /></label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <div className="space-y-1"><div className="label">Gender</div><Seg value={gender} onChange={setGender} options={[{ value: 'F', label: 'Woman' }, { value: 'M', label: 'Man' }]} /></div>
              <label className="min-w-[160px] flex-1 space-y-1"><span className="label">Age: {age}</span><input type="range" min={18} max={70} value={age} onChange={(e) => setAge(+e.target.value)} className="w-full" /></label>
            </div>
            <div className="space-y-1">
              <div className="label">Party</div>
              <div className="grid grid-cols-3 gap-2">
                {(['D', 'R', 'I'] as Party[]).map((p) => (
                  <button key={p} onClick={() => { setParty(p); setPos(PARTY_BASE[p].map((x) => +(x * 0.8).toFixed(2))); }} className="panel-2 p-2 text-left text-sm" style={{ outline: party === p ? `2px solid ${p === 'D' ? 'var(--dem)' : p === 'R' ? 'var(--rep)' : 'var(--ind)'}` : undefined }}>
                    <div className="font-semibold" style={{ color: p === 'D' ? 'var(--dem)' : p === 'R' ? 'var(--rep)' : 'var(--ind)' }}>{p === 'D' ? 'Democrat' : p === 'R' ? 'Republican' : 'Independent'}</div>
                    <div className="muted text-[11px]">{p === 'I' ? 'No primaries, but no party base' : 'Party base & primaries'}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <div className="label">Background</div>
              <div className="grid grid-cols-2 gap-2">
                {(Object.entries(BACKGROUNDS) as [Background, (typeof BACKGROUNDS)[Background]][]).map(([k, b]) => (
                  <button key={k} onClick={() => setBg(k)} className="panel-2 p-2 text-left" style={{ outline: bg === k ? '2px solid var(--accent)' : undefined }}>
                    <div className="text-sm font-semibold">{b.label}</div>
                    <div className="muted text-[11px] leading-snug">{b.desc}</div>
                    <div className="mt-1 text-[11px] num" style={{ color: 'var(--accent)' }}>{money(b.cash)} savings · {Object.entries(b.skills).map(([s, v]) => `+${v} ${s}`).join(', ')}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <div className="label">Difficulty</div>
              <Seg value={difficulty} onChange={setDifficulty} options={(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => ({ value: d, label: DIFFICULTY[d].label }))} />
              <div className="muted text-[11px]">{DIFFICULTY[difficulty].desc}</div>
            </div>
            <div className="space-y-1">
              <div className="label">Start</div>
              <Seg value={String(start) as '2025' | '2027'} onChange={(v) => setStart(+v as 2025 | 2027)} options={[{ value: '2025', label: 'January 2025' }, { value: '2027', label: 'January 2027' }]} />
              <div className="muted text-[11px]">
                {start === 2025
                  ? 'The new Congress and administration take office. Every seat starts with its real party.'
                  : `After the 2026 midterms, with the 2028 presidential race ahead. ${latest.includes(2026) ? 'Seat control uses the real 2026 results.' : 'The 2026 midterms are simulated until real results are added to the game data; the 2025 New Jersey and Virginia governor races use the real winners.'}`}
              </div>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <p className="muted text-sm">Where do you live? You can only run for offices that represent your home — town council up to President. Search below or click any town dot on the map.</p>
            <div className="grid grid-cols-[90px_1fr] gap-2">
              <select className="input" value={st} onChange={(e) => { setSt(e.target.value); setHome(null); setQuery(''); focusOn('state', e.target.value); }}>
                {STATE_LIST.filter((s) => s !== 'DC' && s !== 'HI').map((s) => <option key={s}>{s}</option>)}
              </select>
              <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search towns, cities, townships…" />
            </div>
            <ul className="space-y-1">
              {matches.map((t) => (
                <li key={t.id}>
                  <button className="panel-2 flex w-full items-center justify-between px-3 py-2 text-left text-sm" style={{ outline: home?.id === t.id ? '2px solid var(--accent)' : undefined }} onClick={() => { setHome(t); pickTown(t.id); focusOn('town', t.id); }}>
                    <span className="truncate">{shortTownName(t.name)} <span className="muted text-xs">{t.id.startsWith('M') ? 'township' : 'place'}</span></span>
                    <span className="muted num text-xs">{num(t.pop)} · {leanLabel(t.lean)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {home && (
              <div className="panel-2 space-y-2 p-3">
                <div className="flex justify-between text-sm"><span className="font-semibold">{shortTownName(home.name)}, {home.st}</span><span className="num">{num(home.pop)} residents</span></div>
                <PartisanBar d={home.lean} />
                <div className="muted text-xs">Median income ${num(Math.round(home.demo.income))} · {(home.demo.college * 100).toFixed(0)}% college · median age {home.demo.age.toFixed(0)}</div>
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <div className="flex items-baseline justify-between">
              <p className="muted text-sm">Distribute points. Background bonuses are added on top.</p>
              <span className="num text-sm font-semibold" style={{ color: left < 0 ? 'var(--rep)' : 'var(--accent)' }}>{left} pts left</span>
            </div>
            {SKILL_KEYS.map((k) => {
              const bonus = (BACKGROUNDS[bg].skills as any)[k] ?? 0;
              return (
                <div key={k} className="grid grid-cols-[110px_1fr_64px] items-center gap-3">
                  <span className="text-sm">{SKILL_LABEL[k]}</span>
                  <input type="range" min={20} max={90} value={skills[k]} onChange={(e) => setSkill(k, +e.target.value)} />
                  <span className="num text-right text-sm">{skills[k]}{bonus ? <span style={{ color: 'var(--accent)' }}> +{bonus}</span> : ''}</span>
                </div>
              );
            })}
            <ul className="muted list-disc space-y-0.5 pl-5 text-xs">
              <li>Charisma: town halls, rallies, favorability</li>
              <li>Debate: debates and interviews (fewer gaffes)</li>
              <li>Fundraising: every dollar you raise</li>
              <li>Policy: debates and governing</li>
              <li>Integrity: lower scandal risk</li>
              <li>Organization: more action points each month</li>
            </ul>
          </>
        )}

        {step === 3 && (
          <>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="label">Overall</div>
                <div className="font-semibold">{ideologyLabel(ideologyScore(pos))}</div>
              </div>
              <div className="flex gap-1">
                <button className="btn-ghost !text-xs" onClick={() => setPos(PARTY_BASE[party].map((x) => +x.toFixed(2)))}>Party line</button>
                <button className="btn-ghost !text-xs" onClick={() => setPos(PARTY_BASE[party].map((x) => +(x * 0.45).toFixed(2)))}>Moderate</button>
              </div>
            </div>
            {fit && (
              <div className="panel-2 grid grid-cols-2 gap-3 p-3 text-xs">
                <div>
                  <div className="label">Home general election</div>
                  <div className="num text-lg font-semibold" style={{ color: fit.general >= 0.5 ? 'var(--accent)' : 'var(--rep)' }}>{(fit.general * 100).toFixed(1)}%</div>
                  <div className="muted">vs. generic opponent</div>
                </div>
                {fit.primary != null && (
                  <div>
                    <div className="label">Home primary</div>
                    <div className="num text-lg font-semibold" style={{ color: fit.primary >= 0.5 ? 'var(--accent)' : 'var(--rep)' }}>{(fit.primary * 100).toFixed(1)}%</div>
                    <div className="muted">vs. party-line rival</div>
                  </div>
                )}
              </div>
            )}
            <div className="space-y-2.5">
              {ISSUES.map((iss, i) => (
                <div key={iss.key}>
                  <div className="flex justify-between text-xs"><span className="font-medium">{iss.label}</span><span className="muted num">{pos[i] > 0 ? '+' : ''}{pos[i].toFixed(2)}</span></div>
                  <input type="range" min={-100} max={100} value={Math.round(pos[i] * 100)} onChange={(e) => setPos((p) => p.map((x, j) => (j === i ? +e.target.value / 100 : x)))} className="w-full" aria-label={iss.label} />
                  <div className="muted flex justify-between text-[10px]"><span>{iss.left}</span><span className="text-right">{iss.right}</span></div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <footer className="flex items-center justify-between gap-2 border-t p-3 hairline">
        <button className="btn-ghost" onClick={() => (step ? setStep(step - 1) : setPhase('title'))}>{step ? 'Back' : 'Cancel'}</button>
        <div className="muted hidden text-xs sm:block">{!first || !last ? 'Enter a name' : !home ? 'Choose a home town' : left < 0 ? 'Too many skill points' : 'Ready'}</div>
        {step < 3 ? (
          <button className="btn-primary" onClick={() => setStep(step + 1)}>Next</button>
        ) : (
          <button className="btn-primary" disabled={!valid || busy} onClick={() => newGame({ first: first.trim(), last: last.trim(), gender, age, party, homeTown: home!.id, background: bg, pos, skills, difficulty, start })}>
            {busy ? 'Building the world…' : 'Begin career'}
          </button>
        )}
      </footer>
    </div>
  );
}
