import { cp, copyFile, mkdir } from 'node:fs/promises';

const assets = new URL('./.worker-assets/', import.meta.url);
await mkdir(assets, { recursive: true });
await cp(new URL('./public/', import.meta.url), assets, { recursive: true });
await copyFile(new URL(import.meta.resolve('qrcode-generator')), new URL('qr-encoder.mjs', assets));
