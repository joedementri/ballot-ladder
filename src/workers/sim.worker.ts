/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { Engine } from '../sim/game';
import type { GameState, NewCharacter, RoleKind } from '../sim/model';
import type { BillAction } from '../sim/legislature';
import type { LeverKey } from '../sim/budget';

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
  // M9 governing
  introduceBill(issue: string, dir: 1 | -1, templateId?: string) {
    const r = engine!.introduceBill(issue, dir, templateId);
    return { result: r, view: engine!.view() };
  },
  billAction(billId: string, action: BillAction) {
    const r = engine!.billAction(billId, action);
    return { result: r, view: engine!.view() };
  },
  bidRole(role: RoleKind, committee?: string) {
    const r = engine!.bidRole(role, committee);
    return { result: r, view: engine!.view() };
  },
  cancelBid() {
    const r = engine!.cancelBid();
    return { result: r, view: engine!.view() };
  },
  setCommittees(list: string[]) {
    const r = engine!.setCommittees(list);
    return { result: r, view: engine!.view() };
  },
  setBudget(levers: Partial<Record<LeverKey, number>>) {
    const r = engine!.setBudget(levers);
    return { result: r, view: engine!.view() };
  },
  seekAppointment(officeId: string) {
    const r = engine!.seekAppointment(officeId);
    return { result: r, view: engine!.view() };
  },
  legislature: () => engine!.legislature(),
  budgetView: () => engine!.budgetView(),
  opportunities: () => engine!.opportunities(),
  availableOffices: () => engine!.availableOffices(),
  jurisdiction: (kind: Parameters<Engine['jurisdiction']>[0], id: string) => engine!.jurisdiction(kind, id),
  holderMap: (layer: Parameters<Engine['holderMap']>[0]) => engine!.holderMap(layer),
  national: () => engine!.national(),
  recMap: () => engine!.recMap(),
  targets: () => engine!.targets(),
  actionCost: (id: string) => engine!.actionCost(id),
  fatigue: (id: string, target?: string) => engine!.fatigue(id, target),
  result: (idx: number) => engine!.result(idx),
};

export type SimApi = typeof api;
Comlink.expose(api);
