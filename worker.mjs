import { DurableObject } from 'cloudflare:workers';
import { createRoomStore, newRoomCode, RoomError } from './room.mjs';
import { handleRoom, maxBodyBytes, parseBody, roomPage, roomRoute } from './room-api.mjs';

const ROOM_LIFETIME_MS = 24 * 60 * 60 * 1000;

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function errorResponse(error) {
  if (error instanceof RoomError) return json({ error: error.message }, error.status);
  return json({ error: 'เซิร์ฟเวอร์ทำงานผิดพลาด' }, 500);
}

async function readBody(request) {
  if (!request.body) return parseBody('');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return parseBody(text + decoder.decode());
    size += value.byteLength;
    if (size > maxBodyBytes) {
      await reader.cancel();
      throw new RoomError(413, 'ข้อมูลยาวเกินกำหนด');
    }
    text += decoder.decode(value, { stream: true });
  }
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map();
    this.store = createRoomStore({ rooms: this.rooms });
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('room');
      if (saved) this.rooms.set(saved.code, saved.state);
    });
  }

  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      const create = path.match(/^\/create\/([0-9a-f]{16})$/);
      if (create && request.method === 'POST') {
        const code = create[1];
        const data = this.store.createRoom(code);
        await Promise.all([
          this.save(code),
          this.ctx.storage.setAlarm(Date.now() + ROOM_LIFETIME_MS),
        ]);
        return json(data, 201);
      }

      const route = path.match(roomRoute);
      if (!route) throw new RoomError(404, 'ไม่พบหน้านี้');
      const code = route[1];
      const phase = this.rooms.get(code)?.phase;
      const data = await handleRoom(this.store, route, request.method,
        request.headers.get('Authorization'), () => readBody(request));
      if (request.method === 'POST' || this.rooms.get(code)?.phase !== phase) {
        await this.save(code);
      }
      return json(data);
    } catch (error) {
      return errorResponse(error);
    }
  }

  save(code) {
    return this.ctx.storage.put('room', { code, state: this.rooms.get(code) });
  }

  async alarm() {
    this.rooms.clear();
    await this.ctx.storage.deleteAll();
  }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        const code = newRoomCode();
        return await env.ROOMS.getByName(code).fetch(new URL('/create/' + code, url), { method: 'POST' });
      }
      const route = url.pathname.match(roomRoute);
      if (route) return await env.ROOMS.getByName(route[1]).fetch(request);
      if (request.method === 'GET' && roomPage.test(url.pathname)) {
        return await env.ASSETS.fetch(new URL('/', url));
      }
      return json({ error: 'ไม่พบหน้านี้' }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  },
};
