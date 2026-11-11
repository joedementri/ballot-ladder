/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { Engine } from '../sim/game';
import type { GameState, NewCharacter } from '../sim/model';

/** The simulation runs here so the UI thread stays smooth during big computations (e.g. national elections). */
let engine: Engine | null = null;

const api = {
  async init(base: string) {
    engine = new Engine(base);
    await engine.init();
    return true;
  },
  async newGame(ch: NewCharacter) {
    await engine!.newGame(ch);
    return engine!.view();
  },
  load(state: GameState) {
    engine!.load(state);
    return engine!.view();
  },
  exportState() {
    return engine!.exportState();
  },
  view() {
    return engine!.view();
  },
  async endTurn() {
    await engine!.endTurn();
    return engine!.view();
  },
  async act(actionId: string, target?: string) {
    const r = await engine!.act(actionId, target);
    return { result: r, view: engine!.view() };
  },
  decide(decisionId: string, option: number) {
    const r = engine!.decide(decisionId, option);
    return { result: r, view: engine!.view() };
  },
  async file(officeId: string) {
    const r = await engine!.file(officeId);
    return { result: r, view: engine!.view() };
  },
  withdraw() {
    const r = engine!.withdraw();
    return { result: r, view: engine!.view() };
  },
  ackNight() {
    engine!.ackNight();
    return engine!.view();
  },
  availableOffices: () => engine!.availableOffices(),
  jurisdiction: (kind: Parameters<Engine['jurisdiction']>[0], id: string) => engine!.jurisdiction(kind, id),
  holderMap: (layer: Parameters<Engine['holderMap']>[0]) => engine!.holderMap(layer),
  national: () => engine!.national(),
  recMap: () => engine!.recMap(),
  targets: () => engine!.targets(),
  actionCost: (id: string) => engine!.actionCost(id),
  result: (idx: number) => engine!.result(idx),
};

export type SimApi = typeof api;
Comlink.expose(api);
