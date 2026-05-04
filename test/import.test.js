import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

process.env.NODE_ENV = 'test';
process.env.API_TOKEN = 'test-token';
process.env.MIN_SOURCE_BYTES = '1';

const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-image-cdn-'));
process.env.STORAGE_ROOT = storageRoot;
process.env.CDN_BASE_URL = 'https://cdn.test';

const { default: app } = await import('../src/server.js');

let appServer;
let appUrl;
let sourceServer;
let sourceUrl;
let imageBuffer;

before(async () => {
  imageBuffer = await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: '#f40',
    },
  }).jpeg().toBuffer();

  sourceServer = http.createServer((req, res) => {
    if (req.url === '/tiny') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(Buffer.from([1]));
    }

    if (req.url === '/text') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('not image');
    }

    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': imageBuffer.length,
    });
    res.end(imageBuffer);
  });

  await listen(sourceServer);
  sourceUrl = `http://127.0.0.1:${sourceServer.address().port}/image.jpg`;

  appServer = app.listen(0);
  await onceListening(appServer);
  appUrl = `http://127.0.0.1:${appServer.address().port}`;
});

after(async () => {
  await close(appServer);
  await close(sourceServer);
  await fs.rm(storageRoot, { recursive: true, force: true });
});

test('imports an image and returns all variant URLs', async () => {
  const response = await importImage({ external_id: 'novaengel_123', source_url: sourceUrl });

  assert.equal(response.status, 201);
  const body = await response.json();

  assert.equal(body.external_id, 'novaengel_123');
  assert.ok(body.urls.original.startsWith('https://cdn.test/cdn/products/'));
  assert.ok(body.urls.thumb.endsWith('/thumb.jpg'));
  assert.ok(body.urls.cover.endsWith('/cover.jpg'));
  assert.ok(body.urls.preview.endsWith('/preview.jpg'));
  assert.equal(body.mime, 'image/jpeg');
});

test('returns existing manifest without force', async () => {
  const response = await importImage({ external_id: 'novaengel_123', source_url: sourceUrl });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).external_id, 'novaengel_123');
});

test('rejects invalid bearer token', async () => {
  const response = await fetch(`${appUrl}/v1/images/import`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer wrong',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ external_id: 'bad_auth', source_url: sourceUrl }),
  });

  assert.equal(response.status, 401);
});

test('rejects non-images and tiny files', async () => {
  const textResponse = await importImage({
    external_id: 'text_file',
    source_url: `http://127.0.0.1:${sourceServer.address().port}/text`,
    force: true,
  });

  assert.equal(textResponse.status, 422);

  const tinyResponse = await importImage({
    external_id: 'tiny_file',
    source_url: `http://127.0.0.1:${sourceServer.address().port}/tiny`,
    force: true,
  });

  assert.equal(tinyResponse.status, 422);
});

async function importImage(payload) {
  return fetch(`${appUrl}/v1/images/import`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

function listen(server) {
  server.listen(0);
  return onceListening(server);
}

function onceListening(server) {
  return new Promise((resolve) => server.once('listening', resolve));
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
