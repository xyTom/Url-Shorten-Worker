# API Documentation

[简体中文](API_zh-hans.md)

Short links and Pastebin entries can be created programmatically via the HTTP API.

### API Endpoint

Your deployed Cloudflare Worker URL, for example: `https://url.dem0.workers.dev/` or a custom bound domain.

---

### 1. Create Short URL (`POST /`)

- **Method**: `POST`
- **Content-Type**: `application/json`

```json
{
  "url": "https://example.com",
  "captcha_token": "your_captcha_token_if_enabled",
  "key": "demo"
}
```

---

### 2. Create Pastebin Entry (`POST /`)

You can submit plain text either as JSON (`application/json`) or as a raw text stream (`text/plain`, ideal for multi-megabyte files without JSON escaping overhead):

#### Option A: JSON Request

```json
{
  "type": "paste",
  "text": "Hello, world!\nLine 2...",
  "captcha_token": "your_captcha_token_if_enabled",
  "key": "my-note"
}
```

#### Option B: Raw `text/plain` Request (`cURL` friendly)

```bash
curl -X POST "https://url.dem0.workers.dev/" \
  -H "Content-Type: text/plain;charset=UTF-8" \
  -H "X-Captcha-Token: your_captcha_token_if_enabled" \
  -H "X-Custom-Key: my-log" \
  --data-binary @server.log
```

> **Storage Limit**: By default, `config.paste.max_bytes` allows up to **`10 MiB`** (`10,485,760` UTF-8 bytes) per paste, and enforces a hard ceiling below Cloudflare Workers KV's `25 MiB` (`26,214,400` bytes) value limit.

---

### Request Parameters

| Parameter | Type | Required | Description | Example |
| :---: | :---: | :---: | :--- | :--- |
| `url` | `string` | Required for URL mode | Target URL (must start with `http://` or `https://`, and cannot point to the shortener's own domain) | `https://example.com` |
| `text` | `string` | Required for Pastebin mode | Plain text content to store (also accepts `content`) | `"Hello world"` |
| `type` | `string` | No | Explicitly set `"url"` or `"paste"` (helpful when storing a URL string as plain text in Pastebin) | `"paste"` |
| `captcha_token` | `string` | Conditional | CAPTCHA token when `captcha.enabled` and `captcha.require_on_create` are `true` (also accepts `X-Captcha-Token` header) | `785975238a3c4f0c...` |
| `key` | `string` | No | Custom short key (`1–64` chars: `A-Z`, `a-z`, `0-9`, `-`, `_`, excluding reserved `raw`) when `config.custom_link` is `true` (also accepts `keyPhrase`, `custom_key`, or `X-Custom-Key` header) | `demo` |

---

### Accessing Pastebin Entries (`GET`)

- `GET /:key` — Renders the styled Pastebin reader page (with Copy, Line Wrap, Raw, and Download actions)
- `GET /:key?raw=1` or `GET /raw/:key` — Returns raw `text/plain;charset=UTF-8` content (`X-Content-Type-Options: nosniff`)
- `GET /:key?download=1` — Downloads the content as `<key>.txt`

---

### Response

- **Content-Type**: `application/json;charset=UTF-8`

#### Success Response (`200 OK`)

URL mode:
```json
{
  "status": 200,
  "type": "url",
  "key": "/demo",
  "short_url": "/demo"
}
```

Pastebin mode:
```json
{
  "status": 200,
  "type": "paste",
  "key": "/my-note",
  "short_url": "/my-note",
  "raw_url": "/my-note?raw=1",
  "bytes": 24
}
```

#### Error Status Codes

| Status | Meaning |
| :---: | :--- |
| `400` | Invalid JSON body, empty paste content, invalid/self-referencing `url`, or invalid custom `key` format |
| `403` | CAPTCHA token missing/invalid, custom link / Pastebin disabled, or URL flagged as unsafe by Safe Browsing |
| `405` | Unsupported HTTP method (only `GET`, `HEAD`, `POST`, `OPTIONS` are allowed) |
| `409` | Requested custom `key` already exists |
| `413` | Paste UTF-8 byte size exceeds `config.paste.max_bytes` or Cloudflare KV's `25 MiB` value limit |
| `500` | Cloudflare KV storage error or daily KV write limit reached |
