import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoomStore } from '../room.mjs';

function fixture() {
  let now = 1000;
  const store = createRoomStore({
    now: () => now,
    shuffle: (answers) => answers.reverse(),
  });
  const { code, token: host } = store.createRoom();
  const { token: guest } = store.join(code, '1'.repeat(32));
  const state = (token = host) => store.read(code, token);
  const tick = (ms) => { now += ms; };
  const start = () => { const id = store.start(code, host).roundId; tick(3000); return id; };
  return { store, code, host, guest, state, start, tick, expire: () => { now += 60_000; } };
}

test('reveals on last submission and keeps the shuffled order', () => {
  const { store, code, host, guest, state, start } = fixture();
  const id = start();
  store.submit(code, host, id, 'หนึ่ง');
  assert.equal(state(guest).answers, null);
  store.submit(code, guest, id, 'สอง');
  assert.deepEqual(state().answers, ['สอง', 'หนึ่ง']);
  assert.deepEqual(state(guest).answers, state().answers);
});

test('closes on a status read at the deadline with partial or zero answers', () => {
  for (const send of [true, false]) {
    const { store, code, host, state, start, expire } = fixture();
    const id = start();
    assert.equal(state().deadline - state().serverNow, 60_000);
    if (send) store.submit(code, host, id, 'ทัน');
    expire();
    assert.equal(state().phase, 'revealed');
    assert.deepEqual(state().answers, send ? ['ทัน'] : []);
  }
});

test('rejects a submission at the deadline before any status read', () => {
  const { store, code, host, state, start, expire } = fixture();
  const id = start();
  expire();
  assert.throws(() => store.submit(code, host, id, 'สาย'), { status: 409 });
  assert.deepEqual(state().answers, []);
});

test('rejects duplicate, invalid and stale submissions while retaining duplicate text from different people', () => {
  const { store, code, host, guest, state, start } = fixture();
  const id = start();
  for (const invalid of [' ', '🙂'.repeat(501), null]) {
    assert.throws(() => store.submit(code, host, id, invalid), { status: 400 });
  }
  const answer = '🙂'.repeat(500);
  assert.equal(state().submittedCount, 0);
  store.submit(code, host, id, answer);
  assert.throws(() => store.submit(code, host, id, 'ซ้ำ'), { status: 409 });
  store.submit(code, guest, id, answer);
  assert.deepEqual(state().answers, [answer, answer]);
  store.ready(code, host, id, true);
  store.ready(code, guest, id, true);
  assert.equal(state().answers, null);
  assert.equal(state().playerCount, 2);
  assert.notEqual(state().roundId, id);
  assert.throws(() => store.submit(code, guest, id, 'เก่า'), { status: 409 });
  assert.equal(state().submittedCount, 0);
});

test('unanimous readiness advances five basic questions before unlocking the next modes', () => {
  const { store, code, host, guest, state, start, tick } = fixture();
  assert.deepEqual(state().unlockedModes, ['basic']);
  const questions = new Set();
  let id = start();
  for (let number = 1; number <= 5; number += 1) {
    assert.equal(state().questionNumber, number);
    questions.add(state().question);
    store.submit(code, host, id, 'หนึ่ง');
    store.submit(code, guest, id, 'สอง');
    assert.deepEqual(state().answers, ['สอง', 'หนึ่ง']);
    store.ready(code, host, id, true);
    store.ready(code, host, id, true);
    assert.equal(state(guest).readyCount, 1);
    assert.equal(state(guest).isReady, false);
    assert.equal(state().isReady, true);
    store.ready(code, host, id, false);
    store.ready(code, guest, id, true);
    assert.equal(state().phase, 'revealed');
    assert.equal(state().readyCount, 1);
    store.ready(code, host, id, true);
    assert.equal(state().readyCount, 0);
    assert.equal(state().answers, null);
    assert.throws(() => store.ready(code, guest, id, true), { status: 409 });
    id = state().roundId;
    tick(3000);
  }
  assert.equal(questions.size, 5);
  assert.equal(state().phase, 'modes');
  assert.deepEqual(state().unlockedModes, ['basic', 'memories', 'multiverse']);
  assert.throws(() => store.selectMode(code, guest, 'memories'), { status: 403 });
  assert.throws(() => store.selectMode(code, host, 'romantic'), { status: 409 });
  store.selectMode(code, host, 'multiverse');
  assert.equal(state(guest).mode, 'multiverse');
  assert.equal(state().questionNumber, 1);
  assert.equal(state().phase, 'answering');
});

test('server reserves three seconds before opening and sixty seconds to answer', () => {
  const { store, code, host, tick } = fixture();
  const round = store.start(code, host);
  assert.equal(round.answerStartsAt, round.serverNow + 3000);
  assert.equal(round.deadline, round.answerStartsAt + 60_000);
  tick(2999);
  assert.throws(() => store.submit(code, host, round.roundId, 'early'), {status: 409});
  tick(1);
  assert.equal(store.submit(code, host, round.roundId, 'on time').hasSubmitted, true);
});

test('a stored round without a countdown keeps its original deadline', () => {
  const rooms = new Map();
  const store = createRoomStore({rooms, now: () => 1000});
  const {code, token} = store.createRoom();
  store.start(code, token);
  const state = rooms.get(code);
  state.deadline = 61_000;
  delete state.answerStartsAt;
  assert.equal(store.read(code, token).answerStartsAt, 1000);
  assert.equal(store.submit(code, token, 1, 'existing room').hasSubmitted, true);
});
