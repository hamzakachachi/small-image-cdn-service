# Nova Image CDN

Standalone image service for NovaEngel product images.

It receives temporary NovaEngel image URLs from Laravel, stores images on VPS disk, generates product variants with Sharp, and returns stable public CDN URLs.

## What It Creates

For each imported image:

- `original`
- `thumb` at max `168x180`
- `cover` at max `372x405`
- `preview` at max `1536x1536`

Files are sharded under `products/{hash}/{hash}/{external_id}` to avoid large flat directories.

## Local Development

```bash
cp .env.example .env
npm install
npm test
npm start
```

Health check:

```bash
curl http://localhost:8080/health
```

## Docker

```bash
cp .env.example .env
docker compose -f docker-compose.example.yml --env-file .env up -d --build
```

Put the service behind Nginx or another reverse proxy and set `CDN_BASE_URL` to the public image origin, for example:

```env
CDN_BASE_URL=https://cdn.example.com
```

## Environment

```env
PORT=8080
API_TOKEN=change-this-token
CDN_BASE_URL=https://cdn.example.com
STORAGE_ROOT=/data/images
PUBLIC_PATH_PREFIX=cdn
MAX_SOURCE_BYTES=15728640
MIN_SOURCE_BYTES=500
FETCH_TIMEOUT_MS=30000
```

Use a long random value for `API_TOKEN`. Laravel must use the same value as `IMAGE_CDN_TOKEN`.

## API

`POST /v1/images/import`

```json
{
  "external_id": "novaengel_189313",
  "source_url": "https://temporary-novaengel-url",
  "force": false
}
```

Requires `Authorization: Bearer <API_TOKEN>`.

Response:

```json
{
  "external_id": "novaengel_189313",
  "urls": {
    "original": "https://cdn.example.com/cdn/products/...",
    "thumb": "https://cdn.example.com/cdn/products/...",
    "cover": "https://cdn.example.com/cdn/products/...",
    "preview": "https://cdn.example.com/cdn/products/..."
  },
  "mime": "image/jpeg",
  "checksum": "..."
}
```

`DELETE /v1/images/{external_id}`

Deletes the stored image directory. This endpoint also requires the bearer token.

`GET /health`

Returns service health.

Static images are served from:

```text
/{PUBLIC_PATH_PREFIX}/...
```

With the default config this is:

```text
/cdn/products/...
```
