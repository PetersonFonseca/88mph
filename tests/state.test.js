import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, MODES } from '../src/core/state.js';

test('o ciclo completo permite explorar e fazer uma segunda viagem', () => {
  const state = new GameState();
  const visited = [];
  state.onChange(current => visited.push(current.mode));
  for (const mode of [
    MODES.WALK, MODES.CAR, MODES.PANEL, MODES.CAR,
    MODES.DEPARTURE, MODES.ARRIVAL, MODES.CAR,
    MODES.WALK, MODES.CAR, MODES.PANEL, MODES.CAR,
    MODES.DEPARTURE, MODES.ARRIVAL, MODES.CAR,
  ]) state.set(mode);
  assert.equal(state.mode, MODES.CAR);
  assert.equal(visited.filter(mode => mode === MODES.ARRIVAL).length, 2);
  assert.equal(state.paused, false);
});

test('viagens a pé e saída durante a partida são rejeitadas sem mudar estado', () => {
  const state = new GameState();
  state.set(MODES.WALK);
  assert.throws(() => state.set(MODES.DEPARTURE), /Transição inválida/);
  assert.equal(state.mode, MODES.WALK);
  state.set(MODES.CAR);
  state.set(MODES.DEPARTURE);
  assert.throws(() => state.set(MODES.WALK), /Transição inválida/);
  assert.throws(() => state.set(MODES.PANEL), /Transição inválida/);
  assert.equal(state.mode, MODES.DEPARTURE);
});

test('pausar preserva o modo de condução e notifica os controles para limpar teclas', () => {
  const state = new GameState();
  state.set(MODES.CAR);
  const notifications = [];
  const unsubscribe = state.onChange(current => notifications.push({ mode: current.mode, paused: current.paused }));
  state.pause();
  assert.equal(state.mode, MODES.CAR);
  assert.equal(state.paused, true);
  state.pause(false);
  assert.deepEqual(notifications, [
    { mode: MODES.CAR, paused: true },
    { mode: MODES.CAR, paused: false },
  ]);
  unsubscribe();
  state.pause();
  assert.equal(notifications.length, 2);
});

test('repetir o mesmo modo não dispara outra transição; debug pode pular a abertura', () => {
  const state = new GameState();
  let calls = 0;
  state.onChange(() => calls++);
  state.set(MODES.TITLE);
  assert.equal(calls, 0);
  state.set(MODES.PANEL, true);
  assert.equal(state.mode, MODES.PANEL);
  assert.equal(calls, 1);
});
