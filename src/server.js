import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import express from 'express';
import sharp from 'sharp';

const PORT = Number(process.env.PORT || 8080);
const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || './data/images');
const CDN_BASE_URL = (process.env.CDN_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const PUBLIC_PATH_PREFIX = `/${(process.env.PUBLIC_PATH_PREFIX || 'cdn').replace(/^\/+|\/+$/g, '')}`;
const API_TOKEN = process.env.API_TOKEN || '';
const MAX_SOURCE_BYTES = Number(process.env.MAX_SOURCE_BYTES || 15 * 1024 * 1024);
const MIN_SOURCE_BYTES = Number(process.env.MIN_SOURCE_BYTES || 500);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);

const variants = {
  thumb: { width: 168, height: 180 },
  cover: { width: 372, height: 405 },
  preview: { width: 1536, height: 1536 },
};

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(PUBLIC_PATH_PREFIX, express.static(STORAGE_ROOT, {
  immutable: true,
  maxAge: '365d',
}));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/v1/images/import', requireToken, async (req, res, next) => {
  try {
    const { external_id: externalId, source_url: sourceUrl, force = false } = req.body || {};
    validateImportPayload(externalId, sourceUrl);

    const key = buildStorageKey(externalId);
    const dir = path.join(STORAGE_ROOT, key);
    const manifestPath = path.join(dir, 'manifest.json');

    if (!force) {
      const existing = await readManifest(manifestPath);
      if (existing) {
        return res.json(existing);
      }
    }

    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });

    const imageBuffer = await downloadImage(sourceUrl);
    const metadata = await sharp(imageBuffer, { failOn: 'truncated' }).metadata();
    const ext = extensionForFormat(metadata.format);
    const checksum = crypto.createHash('sha256').update(imageBuffer).digest('hex');
    const originalName = `original.${ext}`;

    await fs.writeFile(path.join(dir, originalName), imageBuffer);

    const urls = {
      original: publicUrl(key, originalName),
    };

    await Promise.all(Object.entries(variants).map(async ([name, size]) => {
      const fileName = `${name}.${ext}`;
      await sharp(imageBuffer)
        .rotate()
        .resize(size.width, size.height, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toFormat(outputFormat(ext), { quality: 85 })
        .toFile(path.join(dir, fileName));
      urls[name] = publicUrl(key, fileName);
    }));

    const manifest = {
      external_id: externalId,
      urls,
      mime: mimeForExtension(ext),
      checksum,
      bytes: imageBuffer.length,
      width: metadata.width || null,
      height: metadata.height || null,
    };

    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    res.status(201).json(manifest);
  } catch (error) {
    next(error);
  }
});

app.delete('/v1/images/:external_id', requireToken, async (req, res, next) => {
  try {
    const externalId = req.params.external_id;
    validateExternalId(externalId);
    await fs.rm(path.join(STORAGE_ROOT, buildStorageKey(externalId)), {
      recursive: true,
      force: true,
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  const status = error.statusCode || 500;
  res.status(status).json({
    message: error.message || 'Unexpected error',
  });
});

function requireToken(req, res, next) {
  if (!API_TOKEN) {
    return res.status(500).json({ message: 'API_TOKEN is not configured' });
  }

  const expected = `Bearer ${API_TOKEN}`;
  if (req.get('authorization') !== expected) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  next();
}

function validateImportPayload(externalId, sourceUrl) {
  validateExternalId(externalId);

  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw badRequest('source_url must be a valid URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw badRequest('source_url must be http or https');
  }
}

function validateExternalId(externalId) {
  if (typeof externalId !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(externalId)) {
    throw badRequest('external_id may only contain letters, numbers, dots, dashes, and underscores');
  }
}

async function downloadImage(sourceUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(sourceUrl, {
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw badRequest(`source_url returned HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !contentType.toLowerCase().startsWith('image/')) {
      throw badRequest('source_url did not return an image');
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_SOURCE_BYTES) {
      throw badRequest('source image is too large');
    }

    const buffer = await readResponseBody(response);

    if (buffer.length < MIN_SOURCE_BYTES) {
      throw badRequest('source image is too small');
    }

    if (buffer.length > MAX_SOURCE_BYTES) {
      throw badRequest('source image is too large');
    }

    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBody(response) {
  if (!response.body) {
    return Buffer.from(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    received += value.length;
    if (received > MAX_SOURCE_BYTES) {
      throw badRequest('source image is too large');
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

function buildStorageKey(externalId) {
  const hash = crypto.createHash('sha1').update(externalId).digest('hex');
  return path.join('products', hash.slice(0, 2), hash.slice(2, 4), externalId);
}

async function readManifest(manifestPath) {
  try {
    return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function publicUrl(key, fileName) {
  return `${CDN_BASE_URL}${PUBLIC_PATH_PREFIX}/${key.split(path.sep).join('/')}/${fileName}`;
}

function extensionForFormat(format) {
  if (format === 'jpeg') {
    return 'jpg';
  }

  if (['jpg', 'png', 'webp', 'gif', 'avif'].includes(format)) {
    return format;
  }

  throw badRequest('unsupported image format');
}

function outputFormat(ext) {
  return ext === 'jpg' ? 'jpeg' : ext;
}

function mimeForExtension(ext) {
  return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 422;
  return error;
}

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Nova image CDN listening on ${PORT}`);
  });
}

export default app;
