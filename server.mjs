import { readFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRoomStore, RoomError } from './room.mjs';
import { handleRoom, maxBodyBytes, parseBody, roomPage, roomRoute } from './room-api.mjs';

const assets = new Map([
  ['/qr-encoder.mjs', [new URL(import.meta.resolve('qrcode-generator')), 'text/javascript']],
  ['/', [new URL('./public/index.html', import.meta.url), 'text/html']],
  ['/app.js', [new URL('./public/app.js', import.meta.url), 'text/javascript']],
  ['/styles.css', [new URL('./public/styles.css', import.meta.url), 'text/css']],
]);

function json(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= maxBodyBytes) chunks.push(chunk);
  }
  if (size > maxBodyBytes) throw new RoomError(413, 'ข้อมูลยาวเกินกำหนด');
  return parseBody(Buffer.concat(chunks).toString('utf8'));
}

export function createServer({ store = createRoomStore() } = {}) {
  return httpServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const { method } = request;
      const asset = roomPage.test(path) ? assets.get('/') : assets.get(path);
      if (method === 'GET' && asset) {
        const [file, type] = asset;
        const content = await readFile(file);
        response.writeHead(200, {
          'Content-Type': type + '; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(content);
        return;
      }

      if (method === 'POST' && path === '/api/rooms') {
        json(response, 201, store.createRoom());
        return;
      }

      const route = path.match(roomRoute);
      if (!route) throw new RoomError(404, 'ไม่พบหน้านี้');
      const data = await handleRoom(store, route, method, request.headers.authorization, () => body(request));
      json(response, 200, data);
    } catch (error) {
      if (error instanceof RoomError) {
        json(response, error.status, { error: error.message });
      } else {
        json(response, 500, { error: 'เซิร์ฟเวอร์ทำงานผิดพลาด' });
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createServer().listen(port, '0.0.0.0', () => {
    console.log('Open http://localhost:' + server.address().port);
  });
}
