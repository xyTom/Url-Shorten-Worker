const config = {
  no_ref: "off", // Control the HTTP referrer header, if you want to create an anonymous link that will hide the HTTP Referer header, please set to "on".
  theme: "theme/captcha", // Homepage theme, use "" for default theme, "theme/urlcool" for urlcool theme, or "theme/captcha" for CAPTCHA & Pastebin UI.
  cors: "on", // Allow Cross-origin resource sharing for API requests.
  unique_link: true, // If true, identical long URLs or identical pastes map to the same short key.
  custom_link: false, // Allow users to customize the short key via "key" (or "keyPhrase").
  safe_browsing_api_key: "", // Enter Google Safe Browsing API Key (or configure Worker Secret `SAFE_BROWSING_API_KEY`) to enable URL safety check.
  expiration_ttl: 0, // Short link / paste expiration time in seconds (minimum 60 when enabled). 86400 = 24 hours. Set to 0 for no expiration.

  // Pastebin (Text Sharing) Configuration
  paste: {
    enabled: true, // Enable storing and viewing plain text pastes
    max_bytes: 10 * 1024 * 1024, // Max UTF-8 byte size per paste (default: 10 MiB; Cloudflare KV hard value limit is 25 MiB = 26,214,400 bytes)
  },

  // CAPTCHA Configuration
  captcha: {
    enabled: true, // Master switch for CAPTCHA service
    api_endpoint: "https://captcha.gurl.eu.org/api", // CAP Worker API endpoint
    require_on_create: true, // Require CAPTCHA when creating short links or pastes
    require_on_access: false, // Require CAPTCHA when accessing short links or pastes
    timeout: 5000, // API request timeout in milliseconds
    fallback_on_error: true, // Allow operations when CAPTCHA service is down
    max_retries: 2, // Maximum retry attempts for CAPTCHA API calls
  },
}

const ASSET_BASE_URL = "https://xytom.github.io/Url-Shorten-Worker"
const KV_VALUE_MAX_BYTES = 25 * 1024 * 1024 // 25 MiB Cloudflare KV hard limit
const PASTE_PREFIX = "paste:1\n" // 8-byte header distinguishing Pastebin entries from http(s) URLs in KV
const PASTE_PREFIX_BYTES = 8
const PASTE_INLINE_PREVIEW_CHARS = 256 * 1024 // 256 KiB inline preview cap to protect Worker memory

const html404 = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 Not Found</title>
</head>
<body>
  <h1>404 Not Found.</h1>
  <p>The url you visit is not found.</p>
  <a href="https://github.com/xyTom/Url-Shorten-Worker/" target="_self">Fork me on GitHub</a>
</body>
</html>`

function getCorsHeaders() {
  if (config.cors !== "on") return {}
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Captcha-Token, X-Custom-Key",
    "Access-Control-Max-Age": "86400",
  }
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      ...getCorsHeaders(),
      ...extraHeaders,
    },
  })
}

function jsonError(status, error, extra = {}, extraHeaders = {}) {
  return jsonResponse({ status, error, ...extra }, status, extraHeaders)
}

function htmlResponse(html, status = 200, extraHeaders = {}, method = "GET") {
  return new Response(method === "HEAD" ? null : html, {
    status,
    headers: {
      "content-type": "text/html;charset=UTF-8",
      ...extraHeaders,
    },
  })
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function serializeForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

function encodeUrlForTemplate(url) {
  return url.replace(/['"<>\\]/g, ch => "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))
}

async function fetchStaticHtml(relativePath) {
  const cleanPath = relativePath.replace(/^\/+/, "")
  try {
    const res = await fetch(`${ASSET_BASE_URL}/${cleanPath}`, {
      cf: { cacheTtl: 3600, cacheEverything: true },
    })
    return res.ok ? await res.text() : null
  } catch (err) {
    console.error(`Failed to fetch static page ${cleanPath}:`, err.message)
    return null
  }
}

function injectPageData(html, globalVarName, data) {
  const scriptTag = `<script>window.${globalVarName}=${serializeForScript(data)};</script>`
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, match => `${scriptTag}\n${match}`)
  }
  return scriptTag + html
}

function getEffectiveMaxPasteBytes() {
  const kvSafeLimit = KV_VALUE_MAX_BYTES - PASTE_PREFIX_BYTES
  const configured = Number(config.paste && config.paste.max_bytes)
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.floor(configured), kvSafeLimit)
  }
  return Math.min(10 * 1024 * 1024, kvSafeLimit)
}

function getUtf8ByteLength(str) {
  let bytes = 0
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < str.length) {
        const next = str.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4
          i++
          continue
        }
      }
      bytes += 3
    } else {
      bytes += 3
    }
  }
  return bytes
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function sliceUtf16Safe(str, maxUnits) {
  if (str.length <= maxUnits) return str
  let end = maxUnits
  const code = str.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return str.slice(0, end)
}

function getSafeBrowsingApiKey() {
  if (typeof SAFE_BROWSING_API_KEY === "string" && SAFE_BROWSING_API_KEY.trim()) {
    return SAFE_BROWSING_API_KEY.trim()
  }
  return typeof config.safe_browsing_api_key === "string" ? config.safe_browsing_api_key.trim() : ""
}

async function randomString(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678" /* 默认去掉了容易混淆的字符oOLl,9gq,Vv,Uu,I1 */
  const charsLen = chars.length
  const maxValidByte = 256 - (256 % charsLen)
  let result = ""

  while (result.length < len) {
    const randomBytes = new Uint8Array((len - result.length) * 2)
    crypto.getRandomValues(randomBytes)
    for (let i = 0; i < randomBytes.length && result.length < len; i++) {
      if (randomBytes[i] < maxValidByte) {
        result += chars.charAt(randomBytes[i] % charsLen)
      }
    }
  }
  return result
}

async function sha512(input) {
  const encoded = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest({ name: "SHA-512" }, encoded)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("")
}

function validateTargetUrl(rawUrl, currentHostname = "") {
  if (typeof rawUrl !== "string") return { valid: false, error: "Invalid URL format" }

  const trimmed = rawUrl.trim()
  if (!trimmed || trimmed.length > 4096 || /[\u0000-\u001F\u007F]/.test(trimmed)) {
    return { valid: false, error: "Invalid URL format" }
  }

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return { valid: false, error: "Invalid URL format" }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, error: "Invalid URL format: only http and https are allowed" }
  }

  const hostname = parsed.hostname.toLowerCase()
  if (!hostname || !hostname.includes(".") || hostname.startsWith(".") || hostname.endsWith(".")) {
    return { valid: false, error: "Invalid URL format" }
  }

  if (currentHostname && hostname === currentHostname.toLowerCase()) {
    return { valid: false, error: "Cannot shorten URLs pointing to the current domain" }
  }

  return { valid: true, normalizedUrl: parsed.toString() }
}

async function checkURL(URL, currentHostname = "") {
  return validateTargetUrl(URL, currentHostname).valid
}

function getKvPutOptions() {
  const MIN_TTL = 60
  const rawTtl = Number(config.expiration_ttl)
  return Number.isFinite(rawTtl) && rawTtl >= MIN_TTL ? { expirationTtl: Math.floor(rawTtl) } : {}
}

function getKvReadOptions() {
  const MIN_CACHE_TTL = 60
  const DEFAULT_CACHE_TTL = 300
  const rawTtl = Number(config.expiration_ttl)
  if (Number.isFinite(rawTtl) && rawTtl >= MIN_CACHE_TTL) {
    return { cacheTtl: Math.min(Math.floor(rawTtl), DEFAULT_CACHE_TTL) }
  }
  return { cacheTtl: DEFAULT_CACHE_TTL }
}

async function save_url(value, valueHash = null) {
  const MAX_RETRIES = 5
  const kvOptions = getKvPutOptions()

  for (let i = 0; i < MAX_RETRIES; i++) {
    const random_key = await randomString()
    if ((await LINKS.get(random_key)) === null) {
      if (valueHash) {
        await Promise.all([
          LINKS.put(random_key, value, kvOptions),
          LINKS.put(valueHash, random_key, kvOptions),
        ])
      } else {
        await LINKS.put(random_key, value, kvOptions)
      }
      return random_key
    }
  }
  throw new Error("Failed to allocate a unique short key")
}

async function is_url_exist(hashHex) {
  const is_exist = await LINKS.get(hashHex)
  return is_exist === null ? false : is_exist
}

async function is_url_safe(url, event = null) {
  const apiKey = getSafeBrowsingApiKey()
  if (!apiKey) return true

  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null
  const cacheKey = "https://safe-browsing.local/" + (await sha512(url))

  if (cache) {
    try {
      const cached = await cache.match(cacheKey)
      if (cached) {
        const cachedData = await cached.json()
        return cachedData.safe === true
      }
    } catch (err) {
      console.warn("Safe Browsing cache read failed:", err.message)
    }
  }

  const raw = JSON.stringify({
    client: { clientId: "Url-Shorten-Worker", clientVersion: "1.1.0" },
    threatInfo: {
      threatTypes: [
        "MALWARE",
        "SOCIAL_ENGINEERING",
        "POTENTIALLY_HARMFUL_APPLICATION",
        "UNWANTED_SOFTWARE",
      ],
      platformTypes: ["ANY_PLATFORM"],
      threatEntryTypes: ["URL"],
      threatEntries: [{ url }],
    },
  })

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch(
      "https://safebrowsing.googleapis.com/v4/threatMatches:find?key=" + encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
        redirect: "follow",
        signal: controller.signal,
      }
    )
    clearTimeout(timeoutId)

    if (!response.ok) {
      console.error(`Safe Browsing API returned HTTP ${response.status}`)
      return true
    }

    const result = await response.json()
    const isSafe = !(Array.isArray(result.matches) && result.matches.length > 0)

    if (cache) {
      const cacheRes = new Response(JSON.stringify({ safe: isSafe }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
        },
      })
      const putPromise = cache.put(cacheKey, cacheRes).catch(err => {
        console.warn("Safe Browsing cache write failed:", err.message)
      })
      if (event && typeof event.waitUntil === "function") {
        event.waitUntil(putPromise)
      } else {
        await putPromise
      }
    }
    return isSafe
  } catch (err) {
    clearTimeout(timeoutId)
    console.error("Safe Browsing check error:", err.name === "AbortError" ? "Timeout" : err.message)
    return true
  }
}

// ============ CAPTCHA Service Integration ============

async function validateCaptchaToken(token, keepToken = false) {
  if (!config.captcha.enabled) return { success: true, degraded: false }
  if (!token || typeof token !== "string" || token.length < 10) {
    return { success: false, error: "Invalid token format" }
  }

  let lastError = null
  const maxRetries = config.captcha.max_retries ?? 2
  const apiEndpoint = config.captcha.api_endpoint.replace(/\/+$/, "")

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let timeoutId = null
    try {
      const controller = new AbortController()
      timeoutId = setTimeout(() => controller.abort(), config.captcha.timeout)

      const response = await fetch(`${apiEndpoint}/validate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Url-Shorten-Worker/1.1.0",
        },
        body: JSON.stringify({ token, keepToken }),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (response.ok) {
        const result = await response.json()
        return { success: result.success === true, degraded: false }
      }
      if ([400, 401, 403, 404, 409, 410].includes(response.status)) {
        return { success: false, error: "Invalid or expired token" }
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId)
      lastError = error.name === "AbortError" ? "Timeout" : error.message
      console.error(`CAPTCHA validation attempt ${attempt + 1} failed:`, lastError)
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100))
      }
    }
  }

  if (config.captcha.fallback_on_error) {
    console.warn(`CAPTCHA service degraded: ${lastError}. Allowing operation due to fallback policy.`)
    return { success: true, degraded: true }
  }
  return { success: false, error: lastError || "CAPTCHA service unavailable" }
}

function isCaptchaRequired(operation) {
  if (!config.captcha.enabled) return false
  if (operation === "create") return Boolean(config.captcha.require_on_create)
  if (operation === "access") return Boolean(config.captcha.require_on_access)
  return false
}

async function extractCaptchaToken(request) {
  const headerToken = request.headers.get("x-captcha-token")
  if (headerToken) return headerToken

  const contentType = request.headers.get("content-type") || ""
  if (request.method === "POST" && contentType.includes("application/json")) {
    try {
      const body = await request.clone().json()
      return body.captcha_token || body.captchaToken || body.token || null
    } catch {
      return null
    }
  }

  const url = new URL(request.url)
  return url.searchParams.get("captcha_token") || url.searchParams.get("token") || null
}

// ============ End CAPTCHA Service Integration ============

function buildRedirectUrl(storedUrl, requestURL) {
  let target
  try {
    target = new URL(storedUrl)
  } catch {
    return null
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null

  const stripGenericToken =
    isCaptchaRequired("access") && !requestURL.searchParams.has("captcha_token")

  for (const [key, val] of requestURL.searchParams.entries()) {
    if (key === "captcha_token" || (stripGenericToken && key === "token")) continue
    target.searchParams.append(key, val)
  }
  return target.toString()
}

async function renderCaptchaPage(requestURL, errorMsg = null) {
  let sdkUrl = "https://captcha.gurl.eu.org/cap.min.js"
  let apiEndpoint = "https://captcha.gurl.eu.org/api/"
  try {
    const ep = new URL(config.captcha.api_endpoint)
    sdkUrl = `${ep.origin}/cap.min.js`
    apiEndpoint = config.captcha.api_endpoint.replace(/\/?$/, "/")
  } catch {
    // Keep default endpoint values
  }

  const retryUrl = new URL(requestURL.toString())
  retryUrl.searchParams.delete("captcha_token")
  retryUrl.searchParams.delete("token")
  const retryHref = retryUrl.pathname + retryUrl.search

  const context = {
    mode: errorMsg ? "failed" : "challenge",
    error: errorMsg || "",
    retryHref,
    shortLink: `${requestURL.host}${requestURL.pathname}`,
    sdkUrl,
    apiEndpoint,
  }

  const tpl = await fetchStaticHtml("captcha.html")
  if (tpl) return injectPageData(tpl, "__CAPTCHA_CONTEXT__", context)

  if (errorMsg) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Verification Failed</title></head><body><h1>Verification Failed</h1><p>${escapeHtml(errorMsg)}</p><a href="${escapeHtml(retryHref)}">Try again</a></body></html>`
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Verification Required</title><script src="${escapeHtml(sdkUrl)}"></script></head><body><h1>Verification Required</h1><cap-widget id="cap" data-cap-api-endpoint="${escapeHtml(apiEndpoint)}"></cap-widget><script>document.getElementById("cap").addEventListener("solve",function(e){var u=new URL(location.href);u.searchParams.set("captcha_token",e.detail.token);location.href=u.toString();});</script></body></html>`
}

async function renderPastePage(key, content) {
  const canFetchRaw = !isCaptchaRequired("access")
  const previewLimit = canFetchRaw ? PASTE_INLINE_PREVIEW_CHARS : 2 * 1024 * 1024
  const truncated = content.length > previewLimit
  const preview = truncated ? sliceUtf16Safe(content, previewLimit) : content

  let lines = 1
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lines++
  }

  const pasteData = {
    key,
    bytes: getUtf8ByteLength(content),
    lines,
    chars: content.length,
    truncated,
    canFetchRaw,
    rawUrl: `/${encodeURIComponent(key)}?raw=1`,
    downloadUrl: `/${encodeURIComponent(key)}?download=1`,
    preview,
  }

  const tpl = await fetchStaticHtml("paste.html")
  if (tpl) return injectPageData(tpl, "__PASTE_DATA__", pasteData)

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Paste /${escapeHtml(key)}</title></head><body><pre>${escapeHtml(preview)}</pre></body></html>`
}

async function handleCreateRequest(request, requestURL, event) {
  const contentType = (request.headers.get("content-type") || "").toLowerCase()
  const isPlainTextBody = contentType.startsWith("text/plain")
  const maxPasteBytes = getEffectiveMaxPasteBytes()

  // Reject oversized uploads via Content-Length before buffering body
  const contentLengthHeader = request.headers.get("content-length")
  if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader)
    if (Number.isFinite(declaredLength) && declaredLength >= 0) {
      if (isPlainTextBody && declaredLength > maxPasteBytes) {
        return jsonError(413, `Paste size (${formatBytes(declaredLength)}) exceeds the maximum limit of ${formatBytes(maxPasteBytes)}`, {
          max_bytes: maxPasteBytes,
          actual_bytes: declaredLength,
        })
      }
      const maxJsonBodyBytes = Math.min(maxPasteBytes * 2 + 64 * 1024, 36 * 1024 * 1024)
      if (!isPlainTextBody && declaredLength > maxJsonBodyBytes) {
        return jsonError(413, `Request payload (${formatBytes(declaredLength)}) exceeds maximum allowed size`, {
          max_bytes: maxPasteBytes,
        })
      }
    }
  }

  let mode = "url"
  let rawUrl = undefined
  let pasteText = undefined
  let captchaToken = null
  let rawCustomKey = undefined

  if (isPlainTextBody) {
    mode = "paste"
    try {
      pasteText = await request.text()
    } catch {
      return jsonError(400, "Failed to read text request body")
    }
    captchaToken =
      request.headers.get("x-captcha-token") ||
      requestURL.searchParams.get("captcha_token") ||
      requestURL.searchParams.get("token") ||
      null
    rawCustomKey =
      request.headers.get("x-custom-key") ??
      requestURL.searchParams.get("key") ??
      requestURL.searchParams.get("keyPhrase") ??
      requestURL.searchParams.get("custom_key")
  } else {
    let req
    try {
      req = await request.json()
    } catch {
      return jsonError(400, "Invalid JSON request body")
    }
    if (!req || typeof req !== "object") {
      return jsonError(400, "Invalid request payload")
    }

    if (req.type === "paste") {
      mode = "paste"
      pasteText = req.text ?? req.content
    } else if (req.type === "url") {
      mode = "url"
      rawUrl = req.url
    } else if (req.url !== undefined && req.url !== null && req.text === undefined && req.content === undefined) {
      mode = "url"
      rawUrl = req.url
    } else if (req.text !== undefined || req.content !== undefined) {
      mode = "paste"
      pasteText = req.text ?? req.content
    } else {
      mode = "url"
      rawUrl = req.url
    }

    captchaToken =
      req.captcha_token ||
      req.captchaToken ||
      req.token ||
      request.headers.get("x-captcha-token") ||
      null
    rawCustomKey = req.key ?? req.keyPhrase ?? req.custom_key
    req = null
  }

  let kvValue = null
  let pasteBytes = 0

  if (mode === "paste") {
    if (!config.paste || !config.paste.enabled) {
      return jsonError(403, "Pastebin feature is disabled")
    }
    if (typeof pasteText !== "string" || pasteText.length === 0 || !/\S/.test(pasteText)) {
      return jsonError(400, "Paste content cannot be empty")
    }
    pasteBytes = getUtf8ByteLength(pasteText)
    if (pasteBytes > maxPasteBytes || pasteBytes + PASTE_PREFIX_BYTES > KV_VALUE_MAX_BYTES) {
      return jsonError(413, `Paste size (${formatBytes(pasteBytes)}) exceeds the maximum limit of ${formatBytes(maxPasteBytes)}`, {
        max_bytes: maxPasteBytes,
        actual_bytes: pasteBytes,
      })
    }
    kvValue = PASTE_PREFIX + pasteText
    pasteText = null
  } else {
    const urlCheck = validateTargetUrl(rawUrl, requestURL.hostname)
    if (!urlCheck.valid) return jsonError(400, urlCheck.error)
    kvValue = urlCheck.normalizedUrl
  }

  // Validate optional custom key before external API calls
  const hasCustomKey =
    rawCustomKey !== undefined && rawCustomKey !== null && String(rawCustomKey).trim() !== ""
  let customKey = null

  if (hasCustomKey) {
    if (!config.custom_link) return jsonError(403, "Custom short link is disabled")
    customKey = String(rawCustomKey).trim()
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(customKey) || customKey.toLowerCase() === "raw") {
      return jsonError(400, "Invalid custom key format (use 1-64 alphanumeric characters, '-' or '_', excluding reserved 'raw')")
    }
  }

  // CAPTCHA validation
  if (isCaptchaRequired("create")) {
    if (!captchaToken) {
      return jsonError(403, "CAPTCHA token required", { captcha_required: true })
    }
    const validation = await validateCaptchaToken(captchaToken, false)
    if (!validation.success) {
      return jsonError(403, validation.error || "CAPTCHA verification failed", { captcha_required: true })
    }
    if (validation.degraded) {
      console.warn("Request processed under CAPTCHA service degradation")
    }
  }

  // Safe Browsing check for URLs
  if (mode === "url" && getSafeBrowsingApiKey()) {
    if (!(await is_url_safe(kvValue, event))) {
      return jsonError(403, "Unsafe URL blocked by Safe Browsing")
    }
  }

  // Persist to Cloudflare KV
  try {
    let random_key = null

    if (customKey) {
      if ((await LINKS.get(customKey)) !== null) {
        return jsonError(409, "Custom short key already exists")
      }
      await LINKS.put(customKey, kvValue, getKvPutOptions())
      random_key = customKey
    } else if (config.unique_link) {
      const valueHash = await sha512(kvValue)
      const existingKey = await is_url_exist(valueHash)
      if (existingKey && (await LINKS.get(existingKey)) !== null) {
        random_key = existingKey
      } else {
        random_key = await save_url(kvValue, valueHash)
      }
    } else {
      random_key = await save_url(kvValue)
    }

    if (mode === "paste") {
      return jsonResponse({
        status: 200,
        type: "paste",
        key: "/" + random_key,
        short_url: "/" + random_key,
        raw_url: "/" + random_key + "?raw=1",
        bytes: pasteBytes,
      })
    }

    return jsonResponse({
      status: 200,
      type: "url",
      key: "/" + random_key,
      short_url: "/" + random_key,
    })
  } catch (err) {
    console.error("Failed to store entry in KV:", err.message)
    return jsonError(500, "Reached KV write limitation or storage error")
  }
}

async function handleAccessRequest(request, requestURL, event) {
  const method = request.method

  // Serve homepage from gh-pages with runtime config injection
  if (requestURL.pathname === "/") {
    const themeSegment = config.theme ? config.theme.replace(/^\/+|\/+$/g, "") + "/" : ""
    let html = await fetchStaticHtml(`${themeSegment}index.html`)
    if (!html) {
      return htmlResponse(
        "<!DOCTYPE html><body><h1>502 Bad Gateway</h1><p>Failed to load homepage theme.</p></body>",
        502,
        {},
        method
      )
    }
    html = injectPageData(html, "__WORKER_CONFIG__", {
      paste_enabled: Boolean(config.paste && config.paste.enabled),
      paste_max_bytes: getEffectiveMaxPasteBytes(),
      custom_link: Boolean(config.custom_link),
      captcha_required: isCaptchaRequired("create"),
      captcha_api_endpoint: config.captcha.api_endpoint,
    })
    return htmlResponse(html, 200, { "Cache-Control": "public, max-age=600" }, method)
  }

  // Short-circuit common static paths to avoid wasted KV reads
  if (requestURL.pathname === "/favicon.ico") {
    return new Response(null, { status: 204, headers: { "Cache-Control": "public, max-age=86400" } })
  }
  if (requestURL.pathname === "/robots.txt") {
    return new Response(method === "HEAD" ? null : "User-agent: *\nDisallow:\n", {
      status: 200,
      headers: {
        "content-type": "text/plain;charset=UTF-8",
        "Cache-Control": "public, max-age=86400",
      },
    })
  }

  // Match `/raw/:key` or `/:key`
  let isRawPath = false
  let path = null

  const rawMatch = requestURL.pathname.match(/^\/raw\/([A-Za-z0-9_-]{1,64})$/)
  if (rawMatch) {
    isRawPath = true
    path = rawMatch[1]
  } else {
    const keyMatch = requestURL.pathname.match(/^\/([A-Za-z0-9_-]{1,64})$/)
    if (keyMatch && keyMatch[1].toLowerCase() !== "raw") {
      path = keyMatch[1]
    }
  }
  if (!path) return htmlResponse(html404, 404, {}, method)

  const value = await LINKS.get(path, getKvReadOptions())
  if (!value) return htmlResponse(html404, 404, {}, method)

  const isPasteEntry = value.startsWith(PASTE_PREFIX)
  if (isRawPath && !isPasteEntry) return htmlResponse(html404, 404, {}, method)

  const location = isPasteEntry ? null : buildRedirectUrl(value, requestURL)
  if (!isPasteEntry && !location) return htmlResponse(html404, 404, {}, method)

  // CAPTCHA validation on access
  if (isCaptchaRequired("access")) {
    const captchaToken = await extractCaptchaToken(request)
    if (!captchaToken) {
      return htmlResponse(await renderCaptchaPage(requestURL, null), 403, { "Cache-Control": "private, no-store" }, method)
    }
    const validation = await validateCaptchaToken(captchaToken, false)
    if (!validation.success) {
      return htmlResponse(
        await renderCaptchaPage(requestURL, validation.error || "CAPTCHA verification failed"),
        403,
        { "Cache-Control": "private, no-store" },
        method
      )
    }
    if (validation.degraded) console.warn("Access granted under CAPTCHA service degradation")
  }

  const cacheControl = isCaptchaRequired("access") ? "private, no-store" : "public, max-age=60"

  // Serve Pastebin entry (Reader UI or Raw / Download text)
  if (isPasteEntry) {
    const pasteContent = value.slice(PASTE_PREFIX.length)
    const rawParam = requestURL.searchParams.get("raw")
    const downloadParam = requestURL.searchParams.get("download")
    const isDownload = downloadParam === "1" || downloadParam === "true"
    const isRaw =
      isRawPath ||
      isDownload ||
      rawParam === "1" ||
      rawParam === "true" ||
      requestURL.searchParams.get("format") === "raw"

    if (isRaw) {
      const safeFilename = path.replace(/[^A-Za-z0-9_-]/g, "") || "paste"
      return new Response(method === "HEAD" ? null : pasteContent, {
        status: 200,
        headers: {
          "content-type": "text/plain;charset=UTF-8",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Disposition": `${isDownload ? "attachment" : "inline"}; filename="${safeFilename}.txt"`,
          "Cache-Control": cacheControl,
          ...getCorsHeaders(),
        },
      })
    }

    return htmlResponse(
      await renderPastePage(path, pasteContent),
      200,
      { "Cache-Control": cacheControl, "Referrer-Policy": "no-referrer" },
      method
    )
  }

  // Safe Browsing check for URL entries
  if (getSafeBrowsingApiKey() && !(await is_url_safe(value, event))) {
    const safeUrl = encodeUrlForTemplate(location)
    let warningPage = await fetchStaticHtml("safe-browsing.html")
    warningPage = warningPage
      ? warningPage.replace(/\{Replace\}/gm, () => escapeHtml(safeUrl))
      : `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Warning: Unsafe URL Detected</title></head><body><h1>Warning: Unsafe URL Detected</h1><p>${escapeHtml(location)}</p></body></html>`
    return htmlResponse(warningPage, 403, { "Referrer-Policy": "no-referrer" }, method)
  }

  // Redirect to target URL
  if (config.no_ref === "on") {
    const safeUrl = encodeUrlForTemplate(location)
    let noRefPage = await fetchStaticHtml("no-ref.html")
    noRefPage = noRefPage
      ? injectPageData(noRefPage.replace(/\{Replace\}/gm, () => safeUrl), "__REDIRECT_URL__", location)
      : `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="referrer" content="no-referrer"><noscript><meta http-equiv="refresh" content="0; url=${escapeHtml(safeUrl)}"></noscript></head><body><script>location.replace(${serializeForScript(location)});</script></body></html>`
    return htmlResponse(
      noRefPage,
      200,
      { "Referrer-Policy": "no-referrer", "Cache-Control": cacheControl },
      method
    )
  }

  return new Response(null, {
    status: 302,
    headers: { "Location": location, "Cache-Control": cacheControl },
  })
}

async function handleRequest(request, event = null) {
  const requestURL = new URL(request.url)

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders() })
  }
  if (request.method === "POST") {
    return handleCreateRequest(request, requestURL, event)
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return handleAccessRequest(request, requestURL, event)
  }
  return jsonError(405, "Method Not Allowed", {}, { "Allow": "GET, HEAD, POST, OPTIONS" })
}

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request, event))
})
