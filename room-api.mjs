import { RoomError } from './room.mjs';

export const roomRoute = /^\/api\/rooms\/([0-9a-f]{16})(?:\/(join|start|answers|ready|mode))?$/;
export const roomPage = /^\/room\/[0-9a-f]{16}$/;
export const maxBodyBytes = 16_384;

export function parseBody(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // Invalid JSON and invalid shapes use the same response.
  }
  throw new RoomError(400, 'รูปแบบข้อมูลไม่ถูกต้อง');
}

export async function handleRoom(store, route, method, authorization, body) {
  const [, code, action] = route;
  const token = authorization?.match(/^Bearer ([0-9a-f]{48})$/)?.[1];
  if (!action && method === 'GET') return store.read(code, token);
  if (method !== 'POST' || !action) throw new RoomError(405, 'วิธีเรียกใช้งานไม่ถูกต้อง');
  switch (action) {
    case 'join': return store.join(code, (await body()).joinKey);
    case 'start': return store.start(code, token);
    case 'mode': return store.selectMode(code, token, (await body()).mode);
    case 'ready': {
      const { roundId, isReady } = await body();
      if (!Number.isSafeInteger(roundId) || typeof isReady !== 'boolean') {
        throw new RoomError(400, 'ข้อมูลความพร้อมไม่ถูกต้อง');
      }
      return store.ready(code, token, roundId, isReady);
    }
    case 'answers': {
      const { roundId, text } = await body();
      if (!Number.isSafeInteger(roundId)) throw new RoomError(400, 'ข้อมูลรอบไม่ถูกต้อง');
      return store.submit(code, token, roundId, text);
    }
  }
}
