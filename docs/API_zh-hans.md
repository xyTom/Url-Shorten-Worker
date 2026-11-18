# API 接口文档

[English](API.md)

支持通过 HTTP API 以可编程方式创建短链接或 Pastebin 文本分享。

### 接口调用地址

自行部署的 Cloudflare Worker 地址，例如：`https://url.dem0.workers.dev/` 或是自行绑定的自定义域名。

---

### 1. 创建短链接 (`POST /`)

- **HTTP 方法**：`POST`
- **请求头**：`Content-Type: application/json`

```json
{
  "url": "https://example.com",
  "captcha_token": "启用验证码时传入的token",
  "key": "demo"
}
```

---

### 2. 创建 Pastebin 文本 (`POST /`)

支持通过 JSON（`application/json`）或纯文本流（`text/plain`，推荐用于上传数 MB 的大文本/日志文件，避免 JSON 转义膨胀）提交文本：

#### 方式 A：JSON 请求

```json
{
  "type": "paste",
  "text": "第一行文本\n第二行文本...",
  "captcha_token": "启用验证码时传入的token",
  "key": "my-note"
}
```

#### 方式 B：原生 `text/plain` 请求（适合 `cURL` 上传文件）

```bash
curl -X POST "https://url.dem0.workers.dev/" \
  -H "Content-Type: text/plain;charset=UTF-8" \
  -H "X-Captcha-Token: 启用验证码时传入的token" \
  -H "X-Custom-Key: my-log" \
  --data-binary @server.log
```

> **存储上限说明**：`config.paste.max_bytes` 默认允许单条 **`10 MiB`**（`10,485,760` UTF-8 字节），支持按需调整，并在代码层强制兜底不超过 Cloudflare Workers KV 单 Value 的 **`25 MiB`**（`26,214,400` 字节）硬上限。

---

### 请求参数

| 参数名 | 类型 | 是否必须 | 说明 | 示例 |
| :---: | :---: | :---: | :--- | :--- |
| `url` | `string` | 短链模式必传 | 目标网址（需以 `http://` 或 `https://` 开头，且不能指向当前短链自身域名） | `https://example.com` |
| `text` | `string` | 文本模式必传 | 要保存的文本内容（兼容 `content` 字段） | `"Hello world"` |
| `type` | `string` | 可选 | 显式指定 `"url"` 或 `"paste"`（例如希望将纯 URL 文本作为 Pastebin 展示时传 `"paste"`） | `"paste"` |
| `captcha_token` | `string` | 条件必须 | 当 `captcha.enabled` 且 `captcha.require_on_create` 为 `true` 时必传（兼容请求头 `X-Captcha-Token`） | `785975238a3c4f0c...` |
| `key` | `string` | 可选 | 自定义短码（`1–64` 位字母、数字、`-` 或 `_`，不可为保留字 `raw`），仅当 `config.custom_link` 为 `true` 时可用（兼容 `keyPhrase`、`custom_key` 及请求头 `X-Custom-Key`） | `demo` |

---

### 访问 Pastebin 文本 (`GET`)

- `GET /:key` — 展示统一风格的 Pastebin 阅读页（支持一键复制、自动换行切换、Raw 查看与 `.txt` 下载）
- `GET /:key?raw=1` 或 `GET /raw/:key` — 直接返回 `text/plain;charset=UTF-8` 纯文本内容（附带 `X-Content-Type-Options: nosniff`）
- `GET /:key?download=1` — 以 `<key>.txt` 附件形式下载文本文件

---

### 响应说明

- **响应头**：`Content-Type: application/json;charset=UTF-8`

#### 成功响应示例 (`200 OK`)

短链模式：
```json
{
  "status": 200,
  "type": "url",
  "key": "/demo",
  "short_url": "/demo"
}
```

Pastebin 模式：
```json
{
  "status": 200,
  "type": "paste",
  "key": "/my-note",
  "short_url": "/my-note",
  "raw_url": "/my-note?raw=1",
  "bytes": 28
}
```

#### 错误状态码说明

| 状态码 | 含义 |
| :---: | :--- |
| `400` | 请求体不是合法 JSON、文本内容为空、`url` 格式非法/指向自身域名，或自定义 `key` 格式不合法 |
| `403` | 缺少验证码或验证失败、未开启自定义短链/Pastebin 功能，或目标网址被 Safe Browsing 判定为不安全 |
| `405` | 不支持的 HTTP 请求方法（仅允许 `GET`、`HEAD`、`POST`、`OPTIONS`） |
| `409` | 自定义短码 `key` 已存在 |
| `413` | 文本 UTF-8 字节大小超出 `config.paste.max_bytes` 或 Cloudflare KV `25 MiB` 单值存储上限 |
| `500` | Cloudflare KV 存储写入失败或达到每日写入配额上限 |
