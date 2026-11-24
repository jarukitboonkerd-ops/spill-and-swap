import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createRoomStore } from '../room.mjs';
import { createServer } from '../server.mjs';

async function apiFixture(t, options) {
  const server = createServer(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return async (path, { token, body, method = 'POST' } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(url + path, {
      method,
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
}

test('five clients share anonymous results and only the host controls rounds', async (t) => {
  let now = 1000;
  const api = await apiFixture(t, {store: createRoomStore({now: () => now})});
  const created = await api('/api/rooms');
  assert.equal(created.status, 201);
  const { code, token: host } = created.data;
  const room = '/api/rooms/' + code;
  const read = (token) => api(room, { method: 'GET', token });
  assert.equal((await read(host)).data.playerCount, 1);
  assert.equal((await read()).status, 403);
  const tokens = [host];
  for (const digit of ['1', '2', '3', '4']) {
    const body = { joinKey: digit.repeat(32) };
    const joined = await api(room + '/join', { body });
    assert.equal(joined.status, 200);
    assert.deepEqual((await api(room + '/join', { body })).data, joined.data);
    tokens.push(joined.data.token);
  }
  const guest = tokens[1];
  assert.equal((await api(room + '/start', { token: guest })).status, 403);
  assert.equal((await read(host)).data.phase, 'lobby');
  const { roundId } = (await api(room + '/start', { token: host })).data;
  now += 3000;
  assert.equal((await read(host)).data.playerCount, 5);
  assert.equal((await api(room + '/join', { body: { joinKey: '1'.repeat(32) } })).data.token, guest);
  assert.equal((await api(room + '/join', { body: { joinKey: '9'.repeat(32) } })).status, 409);

  for (const [i, token] of tokens.entries()) {
    assert.equal((await api(room + '/answers', { token, body: { roundId, text: `คำตอบ ${i}` } })).status, 200);
    if (i < 4) {
      const pending = await read(guest);
      assert.equal(pending.data.answers, null);
      assert.equal(pending.data.submittedCount, i + 1);
      assert.doesNotMatch(JSON.stringify(pending.data), /คำตอบ \d/);
    }
  }

  const stateKeys = ['answerStartsAt', 'answers', 'deadline', 'hasSubmitted', 'isHost', 'isReady', 'mode', 'modes', 'phase', 'playerCount',
    'question', 'questionCount', 'questionNumber', 'readyCount', 'roundId', 'serverNow', 'submittedCount', 'unlockedModes'];
  const results = await Promise.all(tokens.map(read));
  for (const result of results) {
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(result.data).sort(), stateKeys);
    assert.equal(result.data.phase, 'revealed');
    assert.deepEqual(result.data.answers, results[0].data.answers);
    assert.deepEqual([...result.data.answers].sort(), tokens.map((_, i) => `คำตอบ ${i}`));
  }

  const ready = (token, isReady) => api(room + '/ready', { token, body: { roundId, isReady } });
  assert.equal((await api(room + '/mode', { token: host, body: { mode: 'memories' } })).status, 409);
  assert.equal((await ready(host, 'true')).status, 400);
  assert.equal((await ready(host, true)).data.phase, 'revealed');
  assert.equal((await read(guest)).data.readyCount, 1);
  assert.equal((await read(guest)).data.isReady, false);
  for (const token of tokens.slice(1)) await ready(token, true);
  const next = (await read(guest)).data;
  assert.equal(next.phase, 'answering');
  assert.equal(next.questionNumber, 2);
  assert.equal(next.answers, null);
});

test('rejects malformed JSON and unknown rooms', async (t) => {
  const api = await apiFixture(t);
  const created = await api('/api/rooms');
  const room = '/api/rooms/' + created.data.code;
  assert.equal((await api(room + '/join', { body: '{' })).status, 400);
  assert.equal((await api('/api/rooms/0000000000000000', { method: 'GET' })).status, 404);
});

test('serves the QR encoder locally for browsers', async (t) => {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/qr-encoder.mjs');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
  assert.match(await response.text(), /createDataURL/);
});
