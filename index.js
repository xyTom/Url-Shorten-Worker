const config = {
  no_ref: "off", // Control the HTTP referrer header, if you want to create an anonymous link that will hide the HTTP Referer header, please set to "on".
  theme: "", // Homepage theme: leave "" (or "theme/captcha") for built-in dual-mode (URL + Pastebin) homepage; set e.g. "theme/urlcool" to fetch an external theme.
  cors: "on", // Allow Cross-origin resource sharing for API requests.
  unique_link: true, // If true, identical long URLs or identical pastes map to the same short key.
  custom_link: false, // Allow users to customize the short key via the "key" (or "keyPhrase") field.
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

// Cloudflare Workers KV hard limit is 25 MiB (26,214,400 bytes) per value.
const KV_VALUE_MAX_BYTES = 25 * 1024 * 1024
const PASTE_PREFIX = "paste:1\n" // 8-byte header distinguishing Pastebin entries from http(s) URLs in KV
const PASTE_PREFIX_BYTES = 8
const PASTE_INLINE_PREVIEW_CHARS = 256 * 1024 // 256 KiB inline preview cap to protect Worker RAM & browser DOM

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
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1
  }
  return str.slice(0, end)
}

function getPasteStats(content) {
  const bytes = getUtf8ByteLength(content)
  let lines = 1
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      lines++
    }
  }
  return { bytes, lines, chars: content.length }
}

function getCorsHeaders() {
  if (config.cors !== "on") {
    return {}
  }
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

function getCaptchaEndpoints() {
  let sdkUrl = "https://captcha.gurl.eu.org/cap.min.js"
  let apiAttr = "https://captcha.gurl.eu.org/api/"
  try {
    const ep = new URL(config.captcha.api_endpoint)
    sdkUrl = `${ep.origin}/cap.min.js`
    apiAttr = config.captcha.api_endpoint.replace(/\/?$/, "/")
  } catch {
    // Keep default endpoint values
  }
  return { sdkUrl, apiAttr }
}

// ============ Unified UI Design System (Aligned with theme/captcha) ============

const PAGE_ICONS = {
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>`,
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  danger: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  notFound: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  paste: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`,
}

function renderUnifiedPage({
  title,
  tone = "blue",
  iconHtml = PAGE_ICONS.shield,
  showIconBadge = true,
  heading,
  subtitle = "",
  maxWidth = "460px",
  bodyHtml = "",
  extraOverlays = "",
  extraHead = "",
  extraStyle = "",
  extraScript = "",
  showFooter = true,
}) {
  const isRedTone = tone === "red"
  const orbPrimaryLight = isRedTone ? "rgba(255, 59, 48, 0.14)" : "rgba(0, 122, 255, 0.15)"
  const orbPrimaryDark = isRedTone ? "rgba(255, 59, 48, 0.18)" : "rgba(0, 122, 255, 0.18)"

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${escapeHtml(title)}</title>
  ${extraHead}
  <style>
    :root {
      --apple-blue: #007AFF;
      --apple-blue-dark: #0051D5;
      --apple-green: #34C759;
      --apple-red: #FF3B30;
      --apple-amber: #FF9500;
      --bg-page: #f5f5f7;
      --bg-card: rgba(255, 255, 255, 0.88);
      --bg-subtle: #f5f5f7;
      --bg-elevated: #ffffff;
      --bg-secondary-btn: #e5e7eb;
      --bg-secondary-btn-hover: #d1d5db;
      --text-primary: #111827;
      --text-secondary: #86868b;
      --text-secondary-btn: #374151;
      --border-color: #e5e7eb;
      --input-border: #d1d5db;
      --card-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.08);
      --orb-primary: ${orbPrimaryLight};
      --orb-secondary: rgba(168, 85, 247, 0.10);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --bg-page: #000000;
        --bg-card: rgba(17, 24, 39, 0.88);
        --bg-subtle: rgba(255, 255, 255, 0.05);
        --bg-elevated: #1f2937;
        --bg-secondary-btn: #1f2937;
        --bg-secondary-btn-hover: #374151;
        --text-primary: #f3f4f6;
        --text-secondary: #9ca3af;
        --text-secondary-btn: #d1d5db;
        --border-color: #1f2937;
        --input-border: #374151;
        --card-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.65), 0 0 1px rgba(255, 255, 255, 0.12);
        --orb-primary: ${orbPrimaryDark};
        --orb-secondary: rgba(168, 85, 247, 0.12);
      }
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Segoe UI, Roboto, sans-serif;
      background-color: var(--bg-page);
      color: var(--text-primary);
      min-height: 100vh;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.25rem;
      position: relative;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .ambient {
      position: fixed;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      z-index: 0;
    }

    .orb {
      position: absolute;
      border-radius: 9999px;
      filter: blur(80px);
      animation: float 20s ease-in-out infinite;
    }

    .orb-1 {
      top: -250px;
      left: -250px;
      width: 500px;
      height: 500px;
      background: var(--orb-primary);
    }

    .orb-2 {
      bottom: -300px;
      right: -300px;
      width: 600px;
      height: 600px;
      background: var(--orb-secondary);
      animation-delay: -10s;
    }

    .wrapper {
      width: 100%;
      max-width: ${maxWidth};
      position: relative;
      z-index: 10;
    }

    .card {
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      box-shadow: var(--card-shadow);
      overflow: hidden;
      animation: slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .card-header {
      padding: 2rem 1.75rem 1.5rem;
      text-align: center;
      border-bottom: 1px solid var(--border-color);
    }

    .icon-badge {
      width: 52px;
      height: 52px;
      border-radius: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 1rem;
    }

    .icon-badge svg {
      width: 26px;
      height: 26px;
    }

    .tone-blue {
      background: rgba(0, 122, 255, 0.12);
      color: var(--apple-blue);
    }

    .tone-red {
      background: rgba(255, 59, 48, 0.12);
      color: var(--apple-red);
    }

    .tone-amber {
      background: rgba(255, 149, 0, 0.14);
      color: var(--apple-amber);
    }

    .card-title {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.025em;
      line-height: 1.25;
      margin-bottom: 0.45rem;
    }

    .card-subtitle {
      font-size: 0.875rem;
      line-height: 1.55;
      color: var(--text-secondary);
    }

    .card-body {
      padding: 1.5rem 1.75rem 1.75rem;
    }

    .link-pill-wrap {
      display: flex;
      justify-content: center;
      margin-bottom: 1.15rem;
    }

    .link-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      max-width: 100%;
      padding: 0.35rem 0.75rem;
      background: var(--bg-subtle);
      border: 1px solid var(--border-color);
      border-radius: 9999px;
      font-size: 0.75rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: var(--text-secondary);
    }

    .link-pill svg {
      width: 13px;
      height: 13px;
      flex-shrink: 0;
      color: var(--apple-blue);
    }

    .link-pill span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .captcha-stage {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 88px;
      padding: 1.15rem 0.75rem;
      background: var(--bg-subtle);
      border: 1px solid var(--border-color);
      border-radius: 12px;
    }

    .notice {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.55rem;
      padding: 0.75rem 1rem;
      border-radius: 10px;
      font-size: 0.875rem;
      font-weight: 500;
      line-height: 1.45;
      text-align: center;
    }

    .notice-error {
      background: rgba(255, 59, 48, 0.10);
      border: 1px solid rgba(255, 59, 48, 0.22);
      color: var(--apple-red);
      animation: shake 0.45s ease;
    }

    .notice-success {
      background: rgba(52, 199, 89, 0.12);
      border: 1px solid rgba(52, 199, 89, 0.24);
      color: var(--apple-green);
      animation: fadeIn 0.25s ease;
    }

    .notice-info {
      background: rgba(0, 122, 255, 0.10);
      border: 1px solid rgba(0, 122, 255, 0.20);
      color: var(--apple-blue);
      animation: fadeIn 0.25s ease;
    }

    .hidden {
      display: none !important;
    }

    .mt-4 {
      margin-top: 1rem;
    }

    .url-box {
      width: 100%;
      height: 46px;
      padding: 0 0.9rem;
      font-size: 0.85rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: var(--bg-subtle);
      color: var(--text-primary);
      border: 1.5px solid var(--border-color);
      border-radius: 10px;
      outline: none;
      margin-bottom: 1rem;
    }

    .helper-text {
      font-size: 0.84rem;
      line-height: 1.6;
      color: var(--text-secondary);
      text-align: center;
    }

    .actions {
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
      margin-top: 1.35rem;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      width: 100%;
      height: 46px;
      padding: 0 1.25rem;
      font-size: 0.9375rem;
      font-weight: 600;
      font-family: inherit;
      text-decoration: none;
      border-radius: 10px;
      border: none;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: none !important;
    }

    .btn-primary {
      background: var(--apple-blue);
      color: #ffffff;
    }

    .btn-primary:hover:not(:disabled) {
      background: var(--apple-blue-dark);
      transform: translateY(-1px);
      box-shadow: 0 8px 20px -4px rgba(0, 122, 255, 0.4);
    }

    .btn-primary:active:not(:disabled) {
      transform: translateY(0) scale(0.98);
    }

    .btn-success {
      background: var(--apple-green) !important;
      color: #ffffff !important;
    }

    .btn-secondary {
      background: var(--bg-secondary-btn);
      color: var(--text-secondary-btn);
    }

    .btn-secondary:hover:not(:disabled) {
      background: var(--bg-secondary-btn-hover);
    }

    .btn-secondary:active:not(:disabled) {
      transform: scale(0.98);
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 9999px;
      animation: spin 0.65s linear infinite;
      flex-shrink: 0;
    }

    .spinner-lg {
      width: 26px;
      height: 26px;
      border-width: 2.5px;
    }

    .card-footer {
      padding: 1.1rem 1.75rem;
      text-align: center;
      border-top: 1px solid var(--border-color);
    }

    .footer-link {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.4rem 0.75rem;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--apple-blue);
      text-decoration: none;
      border-radius: 8px;
      transition: background-color 0.2s ease;
    }

    .footer-link:hover {
      background: rgba(0, 122, 255, 0.07);
    }

    .footer-arrow {
      transition: transform 0.2s ease;
    }

    .footer-link:hover .footer-arrow {
      transform: translateX(3px);
    }

    @keyframes float {
      0%, 100% { transform: translate(0, 0) rotate(0deg); }
      33% { transform: translate(30px, -30px) rotate(120deg); }
      66% { transform: translate(-20px, 20px) rotate(240deg); }
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(28px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes scaleUp {
      from { opacity: 0; transform: scale(0.94); }
      to { opacity: 1; transform: scale(1); }
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-6px); }
      75% { transform: translateX(6px); }
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    @media (max-width: 640px) {
      .card-header { padding: 1.65rem 1.25rem 1.25rem; }
      .card-body { padding: 1.25rem 1.25rem 1.5rem; }
      .card-title { font-size: 1.3rem; }
      cap-widget { transform: scale(0.92); transform-origin: center center; }
    }

    @media (max-width: 390px) {
      cap-widget { transform: scale(0.84); transform-origin: center center; }
    }

    @media (prefers-reduced-motion: reduce) {
      .orb, .card, .notice-error, .notice-success, .notice-info {
        animation: none !important;
      }
    }
    ${extraStyle}
  </style>
</head>
<body>
  <div class="ambient" aria-hidden="true">
    <div class="orb orb-1"></div>
    <div class="orb orb-2"></div>
  </div>

  <main class="wrapper">
    <div class="card">
      <header class="card-header">
        ${showIconBadge ? `<div class="icon-badge tone-${escapeHtml(tone)}">${iconHtml}</div>` : ""}
        <h1 class="card-title">${escapeHtml(heading)}</h1>
        ${subtitle ? `<p class="card-subtitle">${escapeHtml(subtitle)}</p>` : ""}
      </header>

      <div class="card-body">
        ${bodyHtml}
      </div>

      ${showFooter ? `<footer class="card-footer">
        <a href="https://github.com/xyTom/Url-Shorten-Worker/" target="_blank" rel="noopener" class="footer-link">
          <span>View Source Code</span>
          <span class="footer-arrow">→</span>
        </a>
      </footer>` : ""}
    </div>
  </main>
  ${extraOverlays}
  ${extraScript}
</body>
</html>`
}

function renderNotFoundPage() {
  return renderUnifiedPage({
    title: "404 Not Found - URL Shortener",
    tone: "blue",
    iconHtml: PAGE_ICONS.notFound,
    heading: "404 Not Found",
    subtitle: "The link or paste you visited does not exist or may have expired.",
    bodyHtml: `
      <p class="helper-text">Please double-check the short URL or return to the homepage to create a new one.</p>
      <div class="actions">
        <a href="/" class="btn btn-primary">Go to Homepage</a>
      </div>`,
  })
}

const html404 = renderNotFoundPage()

function renderHomepage() {
  const pasteEnabled = Boolean(config.paste && config.paste.enabled)
  const customLinkEnabled = Boolean(config.custom_link)
  const captchaRequired = isCaptchaRequired("create")
  const maxPasteBytes = getEffectiveMaxPasteBytes()
  const maxPasteFormatted = formatBytes(maxPasteBytes)
  const { sdkUrl, apiAttr } = getCaptchaEndpoints()

  const extraStyle = `
    .segmented {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      padding: 4px;
      background: var(--bg-subtle);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      margin-bottom: 1.4rem;
    }

    .seg-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.45rem;
      height: 38px;
      border: none;
      border-radius: 9px;
      background: transparent;
      color: var(--text-secondary);
      font-family: inherit;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .seg-btn svg {
      width: 16px;
      height: 16px;
    }

    .seg-btn.active {
      background: var(--bg-elevated);
      color: var(--text-primary);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    }

    .field-group {
      margin-bottom: 1.15rem;
    }

    .field-label-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      margin-bottom: 0.55rem;
    }

    .field-label {
      display: block;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
    }

    .paste-meta-tools {
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
    }

    .file-btn {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--apple-blue);
      font-family: inherit;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.2rem 0.55rem;
      border-radius: 6px;
      cursor: pointer;
      transition: background-color 0.15s ease;
    }

    .file-btn:hover {
      background: rgba(0, 122, 255, 0.08);
    }

    .byte-counter {
      font-size: 0.75rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: var(--text-secondary);
    }

    .byte-counter.warn {
      color: var(--apple-amber);
    }

    .byte-counter.over {
      color: var(--apple-red);
      font-weight: 600;
    }

    .input-control, .textarea-control {
      width: 100%;
      background: var(--bg-subtle);
      color: var(--text-primary);
      border: 1.5px solid var(--input-border);
      border-radius: 10px;
      outline: none;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .input-control {
      height: 48px;
      padding: 0 0.95rem;
      font-size: 1rem;
      font-family: inherit;
    }

    .textarea-control {
      min-height: 196px;
      max-height: 55vh;
      resize: vertical;
      padding: 0.85rem 0.95rem;
      font-size: 0.875rem;
      line-height: 1.55;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    .input-control:focus, .textarea-control:focus {
      border-color: var(--apple-blue);
      box-shadow: 0 0 0 4px rgba(0, 122, 255, 0.12);
    }

    .input-error {
      border-color: var(--apple-red) !important;
    }

    .custom-key-wrap {
      display: flex;
      align-items: center;
      background: var(--bg-subtle);
      border: 1.5px solid var(--input-border);
      border-radius: 10px;
      overflow: hidden;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .custom-key-wrap:focus-within {
      border-color: var(--apple-blue);
      box-shadow: 0 0 0 4px rgba(0, 122, 255, 0.12);
    }

    .custom-key-prefix {
      padding: 0 0.75rem 0 0.9rem;
      font-size: 0.875rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: var(--text-secondary);
      user-select: none;
      border-right: 1px solid var(--border-color);
      height: 46px;
      display: inline-flex;
      align-items: center;
    }

    .custom-key-input {
      flex: 1;
      height: 46px;
      padding: 0 0.85rem;
      border: none;
      background: transparent;
      color: var(--text-primary);
      font-size: 0.925rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      outline: none;
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.25rem;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      animation: fadeIn 0.2s ease;
    }

    .modal-card {
      width: 100%;
      max-width: 440px;
      background: var(--bg-card);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      box-shadow: var(--card-shadow);
      overflow: hidden;
      animation: scaleUp 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1.1rem 1.4rem;
      border-bottom: 1px solid var(--border-color);
    }

    .modal-title {
      font-size: 1.05rem;
      font-weight: 600;
    }

    .close-btn {
      width: 30px;
      height: 30px;
      border-radius: 9999px;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: 1.35rem;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.15s ease;
    }

    .close-btn:hover {
      background: var(--bg-subtle);
      color: var(--text-primary);
    }

    .modal-body {
      padding: 1.4rem;
    }

    .result-box {
      padding: 0.9rem 1rem;
      background: var(--bg-subtle);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      text-align: center;
      word-break: break-all;
      font-weight: 600;
      font-size: 0.95rem;
      color: var(--apple-blue);
    }

    .modal-actions {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      padding: 1.1rem 1.4rem 1.35rem;
      border-top: 1px solid var(--border-color);
    }

    .modal-row {
      display: flex;
      gap: 0.6rem;
    }
  `

  const bodyHtml = `
    ${pasteEnabled ? `
    <div class="segmented" role="tablist" aria-label="Mode selector">
      <button type="button" id="tabUrl" class="seg-btn active" role="tab" aria-selected="true">
        ${PAGE_ICONS.link}
        <span>Shorten URL</span>
      </button>
      <button type="button" id="tabPaste" class="seg-btn" role="tab" aria-selected="false">
        ${PAGE_ICONS.paste}
        <span>Pastebin</span>
      </button>
    </div>` : ""}

    <form id="createForm" novalidate>
      <div id="panelUrl" class="field-group">
        <div class="field-label-row">
          <label for="urlInput" class="field-label">Destination URL</label>
        </div>
        <input
          type="url"
          id="urlInput"
          class="input-control"
          placeholder="https://example.com/"
          autocomplete="off"
          spellcheck="false"
        >
      </div>

      ${pasteEnabled ? `
      <div id="panelPaste" class="field-group hidden">
        <div class="field-label-row">
          <label for="pasteInput" class="field-label">Paste Content</label>
          <div class="paste-meta-tools">
            <input type="file" id="filePicker" class="hidden" accept="text/*,.txt,.md,.json,.js,.ts,.py,.sh,.yaml,.yml,.toml,.xml,.csv,.log,.sql,.html,.css,.conf,.ini">
            <button type="button" id="loadFileBtn" class="file-btn">Load File</button>
            <span id="byteCounter" class="byte-counter">0 B / ${escapeHtml(maxPasteFormatted)}</span>
          </div>
        </div>
        <textarea
          id="pasteInput"
          class="textarea-control"
          placeholder="Paste plain text, code snippets, logs, or notes here..."
          spellcheck="false"
        ></textarea>
      </div>` : ""}

      ${customLinkEnabled ? `
      <div class="field-group">
        <div class="field-label-row">
          <label for="customKeyInput" class="field-label">Custom Short Key (Optional)</label>
        </div>
        <div class="custom-key-wrap">
          <span class="custom-key-prefix">/</span>
          <input
            type="text"
            id="customKeyInput"
            class="custom-key-input"
            placeholder="my-custom-key"
            maxlength="64"
            autocomplete="off"
            spellcheck="false"
          >
        </div>
      </div>` : ""}

      <button type="submit" id="submitBtn" class="btn btn-primary">
        Shorten URL
      </button>

      <div id="formNotice" class="notice hidden mt-4" role="alert" aria-live="polite"></div>
    </form>
  `

  const extraOverlays = `
    ${captchaRequired ? `
    <div id="captchaModal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="captchaModalTitle">
      <div class="modal-card">
        <div class="modal-header">
          <h2 id="captchaModalTitle" class="modal-title">Security Verification</h2>
          <button type="button" class="close-btn" id="closeCaptchaModal" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <p class="helper-text" style="margin-bottom: 1.1rem;">Please complete the CAPTCHA below to continue.</p>
          <div class="captcha-stage">
            <cap-widget id="capWidget" data-cap-api-endpoint="${escapeHtml(apiAttr)}"></cap-widget>
          </div>
        </div>
      </div>
    </div>` : ""}

    <div id="resultModal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="resultModalTitle">
      <div class="modal-card">
        <div class="modal-header">
          <h2 id="resultModalTitle" class="modal-title">Short Link Ready</h2>
          <button type="button" class="close-btn" id="closeResultModal" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <div id="resultUrl" class="result-box"></div>
        </div>
        <div class="modal-actions">
          <button type="button" id="copyBtn" class="btn btn-primary">Copy Link</button>
          <div class="modal-row">
            <a id="openLinkBtn" href="#" target="_blank" rel="noopener" class="btn btn-secondary">Open Link ↗</a>
            <button type="button" id="copyRawBtn" class="btn btn-secondary hidden">Copy Raw URL</button>
          </div>
        </div>
      </div>
    </div>
  `

  const extraScript = `<script>
    (function () {
      var PASTE_ENABLED = ${pasteEnabled ? "true" : "false"};
      var CAPTCHA_REQUIRED = ${captchaRequired ? "true" : "false"};
      var MAX_PASTE_BYTES = ${maxPasteBytes};
      var MAX_PASTE_LABEL = ${serializeForScript(maxPasteFormatted)};

      var state = {
        mode: "url",
        isProcessing: false,
        captchaToken: null,
        pendingSubmit: false,
        generatedUrl: "",
        generatedRawUrl: ""
      };

      var tabUrl = document.getElementById("tabUrl");
      var tabPaste = document.getElementById("tabPaste");
      var panelUrl = document.getElementById("panelUrl");
      var panelPaste = document.getElementById("panelPaste");
      var form = document.getElementById("createForm");
      var urlInput = document.getElementById("urlInput");
      var pasteInput = document.getElementById("pasteInput");
      var filePicker = document.getElementById("filePicker");
      var loadFileBtn = document.getElementById("loadFileBtn");
      var byteCounter = document.getElementById("byteCounter");
      var customKeyInput = document.getElementById("customKeyInput");
      var submitBtn = document.getElementById("submitBtn");
      var formNotice = document.getElementById("formNotice");
      var captchaModal = document.getElementById("captchaModal");
      var closeCaptchaModal = document.getElementById("closeCaptchaModal");
      var capWidget = document.getElementById("capWidget");
      var resultModal = document.getElementById("resultModal");
      var resultModalTitle = document.getElementById("resultModalTitle");
      var closeResultModal = document.getElementById("closeResultModal");
      var resultUrlEl = document.getElementById("resultUrl");
      var copyBtn = document.getElementById("copyBtn");
      var openLinkBtn = document.getElementById("openLinkBtn");
      var copyRawBtn = document.getElementById("copyRawBtn");

      function formatSize(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + " KiB";
        return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
      }

      function getBlobBytes(str) {
        return new Blob([str]).size;
      }

      function showNotice(msg, type) {
        formNotice.className = "notice mt-4 notice-" + (type || "error");
        formNotice.textContent = msg;
      }

      function clearNotice() {
        formNotice.className = "notice hidden mt-4";
        formNotice.textContent = "";
      }

      function setLoading(loading) {
        submitBtn.disabled = loading;
        if (loading) {
          var label = state.mode === "paste" ? "Saving Paste..." : "Generating...";
          submitBtn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>' + label + '</span>';
        } else {
          submitBtn.textContent = state.mode === "paste" ? "Create Paste" : "Shorten URL";
        }
      }

      function switchMode(mode) {
        if (!PASTE_ENABLED) return;
        state.mode = mode;
        clearNotice();
        if (mode === "paste") {
          tabUrl.classList.remove("active");
          tabUrl.setAttribute("aria-selected", "false");
          tabPaste.classList.add("active");
          tabPaste.setAttribute("aria-selected", "true");
          panelUrl.classList.add("hidden");
          panelPaste.classList.remove("hidden");
          submitBtn.textContent = "Create Paste";
          pasteInput.focus();
        } else {
          tabPaste.classList.remove("active");
          tabPaste.setAttribute("aria-selected", "false");
          tabUrl.classList.add("active");
          tabUrl.setAttribute("aria-selected", "true");
          panelPaste.classList.add("hidden");
          panelUrl.classList.remove("hidden");
          submitBtn.textContent = "Shorten URL";
          urlInput.focus();
        }
      }

      function isValidHttpUrl(val) {
        try {
          var u = new URL(val);
          if (u.protocol !== "http:" && u.protocol !== "https:") return false;
          if (u.hostname.indexOf(".") === -1 || u.hostname.startsWith(".") || u.hostname.endsWith(".")) return false;
          return true;
        } catch (e) {
          return false;
        }
      }

      function updateByteCounter() {
        if (!pasteInput || !byteCounter) return 0;
        var bytes = getBlobBytes(pasteInput.value);
        byteCounter.textContent = formatSize(bytes) + " / " + MAX_PASTE_LABEL;
        byteCounter.classList.remove("warn", "over");
        pasteInput.classList.remove("input-error");
        if (bytes > MAX_PASTE_BYTES) {
          byteCounter.classList.add("over");
          pasteInput.classList.add("input-error");
        } else if (bytes > MAX_PASTE_BYTES * 0.85) {
          byteCounter.classList.add("warn");
        }
        return bytes;
      }

      function openModal(el) {
        if (!el) return;
        el.classList.remove("hidden");
        document.body.style.overflow = "hidden";
      }

      function closeModal(el) {
        if (!el) return;
        el.classList.add("hidden");
        document.body.style.overflow = "";
      }

      function resetCaptcha() {
        state.captchaToken = null;
        if (capWidget && typeof capWidget.reset === "function") {
          try { capWidget.reset(); } catch (e) {}
        }
      }

      async function copyText(text, buttonEl, defaultLabel) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
          } else {
            var ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
          }
          buttonEl.textContent = "✓ Copied";
          buttonEl.classList.add("btn-success");
          setTimeout(function () {
            buttonEl.textContent = defaultLabel;
            buttonEl.classList.remove("btn-success");
          }, 1800);
        } catch (e) {
          showNotice("Failed to copy to clipboard", "error");
        }
      }

      async function submitCreation() {
        if (state.isProcessing) return;
        state.isProcessing = true;
        setLoading(true);
        clearNotice();

        var customKey = customKeyInput ? customKeyInput.value.trim() : "";

        try {
          var response;
          if (state.mode === "paste") {
            // Send raw text/plain to avoid JSON escaping bloat on multi-megabyte pastes
            var headers = { "Content-Type": "text/plain;charset=UTF-8" };
            if (state.captchaToken) headers["X-Captcha-Token"] = state.captchaToken;
            if (customKey) headers["X-Custom-Key"] = customKey;
            response = await fetch(window.location.origin + "/", {
              method: "POST",
              headers: headers,
              body: pasteInput.value
            });
          } else {
            var payload = { url: urlInput.value.trim() };
            if (state.captchaToken) payload.captcha_token = state.captchaToken;
            if (customKey) payload.key = customKey;
            response = await fetch(window.location.origin + "/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
          }

          var data = await response.json();
          if (response.ok && data.status === 200) {
            state.generatedUrl = window.location.origin + data.key;
            state.generatedRawUrl = data.raw_url ? (window.location.origin + data.raw_url) : "";
            resultUrlEl.textContent = state.generatedUrl;
            openLinkBtn.href = state.generatedUrl;

            if (state.mode === "paste") {
              resultModalTitle.textContent = "Paste Created";
              pasteInput.value = "";
              updateByteCounter();
              if (copyRawBtn && state.generatedRawUrl) {
                copyRawBtn.classList.remove("hidden");
              }
            } else {
              resultModalTitle.textContent = "Short URL Created";
              urlInput.value = "";
              if (copyRawBtn) copyRawBtn.classList.add("hidden");
            }
            if (customKeyInput) customKeyInput.value = "";
            resetCaptcha();
            openModal(resultModal);
          } else {
            showNotice(data.error || "Failed to create link", "error");
            if (data.captcha_required) {
              resetCaptcha();
            }
          }
        } catch (err) {
          showNotice("Network error: " + err.message, "error");
          resetCaptcha();
        } finally {
          state.isProcessing = false;
          setLoading(false);
        }
      }

      if (tabUrl && tabPaste) {
        tabUrl.addEventListener("click", function () { switchMode("url"); });
        tabPaste.addEventListener("click", function () { switchMode("paste"); });
      }

      if (urlInput) {
        urlInput.addEventListener("input", function () {
          var v = urlInput.value.trim();
          if (v && !isValidHttpUrl(v)) {
            urlInput.classList.add("input-error");
          } else {
            urlInput.classList.remove("input-error");
          }
        });
      }

      if (pasteInput) {
        pasteInput.addEventListener("input", updateByteCounter);
      }

      if (loadFileBtn && filePicker) {
        loadFileBtn.addEventListener("click", function () { filePicker.click(); });
        filePicker.addEventListener("change", function () {
          var file = filePicker.files && filePicker.files[0];
          if (!file) return;
          if (file.size > MAX_PASTE_BYTES) {
            showNotice("Selected file (" + formatSize(file.size) + ") exceeds the " + MAX_PASTE_LABEL + " limit.", "error");
            filePicker.value = "";
            return;
          }
          var reader = new FileReader();
          reader.onload = function () {
            pasteInput.value = String(reader.result || "");
            updateByteCounter();
            clearNotice();
            filePicker.value = "";
          };
          reader.onerror = function () {
            showNotice("Failed to read file.", "error");
            filePicker.value = "";
          };
          reader.readAsText(file);
        });
      }

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (state.isProcessing) return;
        clearNotice();

        if (state.mode === "paste") {
          if (!pasteInput.value || !pasteInput.value.trim()) {
            showNotice("Please enter or load some text content.", "error");
            pasteInput.focus();
            return;
          }
          var bytes = updateByteCounter();
          if (bytes > MAX_PASTE_BYTES) {
            showNotice("Paste size (" + formatSize(bytes) + ") exceeds the maximum limit of " + MAX_PASTE_LABEL + ".", "error");
            pasteInput.focus();
            return;
          }
        } else {
          var urlVal = urlInput.value.trim();
          if (!urlVal) {
            showNotice("Please enter a URL to shorten.", "error");
            urlInput.focus();
            return;
          }
          if (!isValidHttpUrl(urlVal)) {
            urlInput.classList.add("input-error");
            showNotice("Please enter a valid URL starting with http:// or https://", "error");
            urlInput.focus();
            return;
          }
          try {
            if (new URL(urlVal).hostname.toLowerCase() === window.location.hostname.toLowerCase()) {
              urlInput.classList.add("input-error");
              showNotice("Cannot shorten URLs pointing to the current domain.", "error");
              urlInput.focus();
              return;
            }
          } catch (err) {}
        }

        if (customKeyInput && customKeyInput.value.trim()) {
          var customVal = customKeyInput.value.trim();
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(customVal) || customVal.toLowerCase() === "raw") {
            showNotice("Custom key can only use 1-64 letters, numbers, '-' or '_' (excluding reserved 'raw').", "error");
            customKeyInput.focus();
            return;
          }
        }

        if (CAPTCHA_REQUIRED && !state.captchaToken) {
          if (window.__capHomeSdkError) {
            showNotice("Failed to load CAPTCHA widget. Please check your connection or reload the page.", "error");
            return;
          }
          state.pendingSubmit = true;
          openModal(captchaModal);
          return;
        }

        submitCreation();
      });

      if (capWidget) {
        capWidget.addEventListener("solve", function (e) {
          state.captchaToken = e && e.detail ? e.detail.token : null;
          closeModal(captchaModal);
          if (state.pendingSubmit && state.captchaToken) {
            state.pendingSubmit = false;
            submitCreation();
          }
        });
        capWidget.addEventListener("error", function () {
          showNotice("CAPTCHA verification failed. Please try again.", "error");
        });
      }

      if (closeCaptchaModal) {
        closeCaptchaModal.addEventListener("click", function () {
          state.pendingSubmit = false;
          closeModal(captchaModal);
          resetCaptcha();
        });
      }

      if (captchaModal) {
        captchaModal.addEventListener("click", function (e) {
          if (e.target === captchaModal) {
            state.pendingSubmit = false;
            closeModal(captchaModal);
            resetCaptcha();
          }
        });
      }

      if (closeResultModal) {
        closeResultModal.addEventListener("click", function () {
          closeModal(resultModal);
        });
      }

      if (resultModal) {
        resultModal.addEventListener("click", function (e) {
          if (e.target === resultModal) {
            closeModal(resultModal);
          }
        });
      }

      if (copyBtn) {
        copyBtn.addEventListener("click", function () {
          if (state.generatedUrl) copyText(state.generatedUrl, copyBtn, "Copy Link");
        });
      }

      if (copyRawBtn) {
        copyRawBtn.addEventListener("click", function () {
          if (state.generatedRawUrl) copyText(state.generatedRawUrl, copyRawBtn, "Copy Raw URL");
        });
      }

      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
          state.pendingSubmit = false;
          closeModal(captchaModal);
          closeModal(resultModal);
        }
      });
    })();
  </script>`

  return renderUnifiedPage({
    title: pasteEnabled ? "URL Shortener & Pastebin" : "URL Shortener - Fast & Secure",
    tone: "blue",
    showIconBadge: false,
    heading: pasteEnabled ? "Shorten URLs & Share Text" : "Shorten your URLs",
    subtitle: pasteEnabled
      ? "Fast, secure URL shortener and instant Pastebin powered by Cloudflare Workers"
      : "Fast, Secure, and Reliable URL Shortening Service",
    maxWidth: "580px",
    extraHead: captchaRequired ? `<script src="${escapeHtml(sdkUrl)}" defer onerror="window.__capHomeSdkError=true"></script>` : "",
    extraStyle,
    bodyHtml,
    extraOverlays,
    extraScript,
  })
}

function renderPasteViewPage(key, content) {
  const stats = getPasteStats(content)
  // When access CAPTCHA is off, cap inline HTML preview at 256 KiB and allow on-demand fetch via ?raw=1
  const canFetchRawInPlace = !isCaptchaRequired("access")
  const previewLimit = canFetchRawInPlace ? PASTE_INLINE_PREVIEW_CHARS : 2 * 1024 * 1024
  const isTruncated = content.length > previewLimit
  const previewContent = isTruncated ? sliceUtf16Safe(content, previewLimit) : content

  const rawHref = `/${encodeURIComponent(key)}?raw=1`
  const downloadHref = `/${encodeURIComponent(key)}?download=1`
  const subtitle = `${formatBytes(stats.bytes)} · ${stats.lines.toLocaleString()} ${stats.lines === 1 ? "line" : "lines"} · ${stats.chars.toLocaleString()} chars`

  const extraStyle = `
    .paste-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.6rem;
      margin-bottom: 1rem;
    }

    .toolbar-group {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.45rem;
    }

    .tool-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.35rem;
      height: 36px;
      padding: 0 0.85rem;
      font-size: 0.8125rem;
      font-weight: 600;
      font-family: inherit;
      text-decoration: none;
      border-radius: 8px;
      border: 1px solid var(--border-color);
      background: var(--bg-subtle);
      color: var(--text-primary);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .tool-btn:hover {
      background: var(--bg-secondary-btn);
    }

    .tool-btn-primary {
      background: var(--apple-blue);
      border-color: var(--apple-blue);
      color: #ffffff;
    }

    .tool-btn-primary:hover {
      background: var(--apple-blue-dark);
      border-color: var(--apple-blue-dark);
    }

    .tool-btn.active {
      border-color: var(--apple-blue);
      color: var(--apple-blue);
      background: rgba(0, 122, 255, 0.08);
    }

    .truncate-banner {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.7rem 0.95rem;
      margin-bottom: 0.9rem;
      border-radius: 10px;
      background: rgba(0, 122, 255, 0.10);
      border: 1px solid rgba(0, 122, 255, 0.22);
      color: var(--apple-blue);
      font-size: 0.8125rem;
      font-weight: 500;
    }

    .paste-container {
      background: var(--bg-subtle);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      overflow: hidden;
    }

    .paste-pre {
      margin: 0;
      padding: 1.1rem 1.25rem;
      max-height: 65vh;
      overflow: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.845rem;
      line-height: 1.6;
      tab-size: 4;
      color: var(--text-primary);
      white-space: pre;
      user-select: text;
    }

    .paste-pre.wrap-lines {
      white-space: pre-wrap;
      word-break: break-word;
    }
  `

  const bodyHtml = `
    <div class="paste-toolbar">
      <div class="toolbar-group">
        <button type="button" id="copyPasteBtn" class="tool-btn tool-btn-primary">Copy Text</button>
        <button type="button" id="wrapToggleBtn" class="tool-btn active">Wrap Lines</button>
      </div>
      <div class="toolbar-group">
        <a href="${escapeHtml(rawHref)}" target="_blank" rel="noopener" class="tool-btn">Raw</a>
        <a href="${escapeHtml(downloadHref)}" class="tool-btn">Download .txt</a>
        <a href="/" class="tool-btn">+ New</a>
      </div>
    </div>

    ${isTruncated ? `
    <div id="truncateBanner" class="truncate-banner">
      <span>Showing first ${escapeHtml(formatBytes(getUtf8ByteLength(previewContent)))} preview of ${escapeHtml(formatBytes(stats.bytes))} paste.</span>
      ${canFetchRawInPlace
        ? `<button type="button" id="loadFullBtn" class="tool-btn">Load Full Paste</button>`
        : `<a href="${escapeHtml(downloadHref)}" class="tool-btn">Download Full Paste</a>`}
    </div>` : ""}

    <div class="paste-container">
      <pre id="pastePre" class="paste-pre wrap-lines">${escapeHtml(previewContent)}</pre>
    </div>
  `

  const extraScript = `<script>
    (function () {
      var IS_TRUNCATED = ${isTruncated ? "true" : "false"};
      var CAN_FETCH_RAW = ${canFetchRawInPlace ? "true" : "false"};
      var RAW_URL = ${serializeForScript(rawHref)};
      var fullLoadedText = null;

      var copyBtn = document.getElementById("copyPasteBtn");
      var wrapBtn = document.getElementById("wrapToggleBtn");
      var loadFullBtn = document.getElementById("loadFullBtn");
      var truncateBanner = document.getElementById("truncateBanner");
      var preEl = document.getElementById("pastePre");

      async function fetchFullText() {
        if (fullLoadedText !== null) return fullLoadedText;
        if (!IS_TRUNCATED) return preEl.textContent;
        if (!CAN_FETCH_RAW) return preEl.textContent;
        var res = await fetch(RAW_URL);
        if (!res.ok) throw new Error("HTTP " + res.status);
        fullLoadedText = await res.text();
        return fullLoadedText;
      }

      if (wrapBtn && preEl) {
        wrapBtn.addEventListener("click", function () {
          var wrapped = preEl.classList.toggle("wrap-lines");
          wrapBtn.classList.toggle("active", wrapped);
        });
      }

      if (loadFullBtn && preEl) {
        loadFullBtn.addEventListener("click", async function () {
          loadFullBtn.disabled = true;
          loadFullBtn.textContent = "Loading...";
          try {
            var text = await fetchFullText();
            preEl.textContent = text;
            IS_TRUNCATED = false;
            if (truncateBanner) truncateBanner.classList.add("hidden");
          } catch (e) {
            loadFullBtn.disabled = false;
            loadFullBtn.textContent = "Retry Load";
          }
        });
      }

      if (copyBtn && preEl) {
        copyBtn.addEventListener("click", async function () {
          var originalLabel = copyBtn.textContent;
          try {
            var textToCopy = await fetchFullText();
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(textToCopy);
            } else {
              var ta = document.createElement("textarea");
              ta.value = textToCopy;
              ta.style.position = "fixed";
              ta.style.opacity = "0";
              document.body.appendChild(ta);
              ta.select();
              document.execCommand("copy");
              document.body.removeChild(ta);
            }
            copyBtn.textContent = "✓ Copied";
            copyBtn.classList.add("btn-success");
            setTimeout(function () {
              copyBtn.textContent = originalLabel;
              copyBtn.classList.remove("btn-success");
            }, 1800);
          } catch (e) {
            copyBtn.textContent = "Copy Failed";
            setTimeout(function () { copyBtn.textContent = originalLabel; }, 1800);
          }
        });
      }
    })();
  </script>`

  return renderUnifiedPage({
    title: `Paste /${key} - Pastebin`,
    tone: "blue",
    iconHtml: PAGE_ICONS.paste,
    heading: `Paste /${key}`,
    subtitle,
    maxWidth: "820px",
    extraHead: `<meta name="referrer" content="no-referrer">`,
    extraStyle,
    bodyHtml,
    extraScript,
  })
}

function getSafeBrowsingApiKey() {
  if (typeof SAFE_BROWSING_API_KEY === "string" && SAFE_BROWSING_API_KEY.trim()) {
    return SAFE_BROWSING_API_KEY.trim()
  }
  return typeof config.safe_browsing_api_key === "string"
    ? config.safe_browsing_api_key.trim()
    : ""
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
  const hashArray = Array.from(new Uint8Array(digest))
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("")
}

function validateTargetUrl(rawUrl, currentHostname = "") {
  if (typeof rawUrl !== "string") {
    return { valid: false, error: "Invalid URL format" }
  }

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
  const hasValidTtl = Number.isFinite(rawTtl) && rawTtl >= MIN_TTL
  return hasValidTtl ? { expirationTtl: Math.floor(rawTtl) } : {}
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
    const is_exist = await LINKS.get(random_key)
    if (is_exist === null) {
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
  if (!apiKey) {
    return true
  }

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

/**
 * Validates CAPTCHA token with retry and fallback mechanism
 * @param {string} token - The CAPTCHA token to validate
 * @param {boolean} keepToken - Whether to keep the token for reuse
 * @returns {Promise<{success: boolean, error?: string, degraded?: boolean}>}
 */
async function validateCaptchaToken(token, keepToken = false) {
  if (!config.captcha.enabled) {
    return { success: true, degraded: false }
  }

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

/**
 * Checks if CAPTCHA is required for the current operation
 * @param {string} operation - 'create' or 'access'
 * @returns {boolean}
 */
function isCaptchaRequired(operation) {
  if (!config.captcha.enabled) {
    return false
  }

  switch (operation) {
    case "create":
      return Boolean(config.captcha.require_on_create)
    case "access":
      return Boolean(config.captcha.require_on_access)
    default:
      return false
  }
}

/**
 * Extracts CAPTCHA token from request
 * @param {Request} request - The incoming request
 * @returns {Promise<string|null>}
 */
async function extractCaptchaToken(request) {
  const headerToken = request.headers.get("x-captcha-token")
  if (headerToken) {
    return headerToken
  }

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

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return null
  }

  const stripGenericToken =
    isCaptchaRequired("access") && !requestURL.searchParams.has("captcha_token")

  for (const [key, val] of requestURL.searchParams.entries()) {
    if (key === "captcha_token" || (stripGenericToken && key === "token")) {
      continue
    }
    target.searchParams.append(key, val)
  }

  return target.toString()
}

function renderGatewayErrorPage(detail) {
  return renderUnifiedPage({
    title: "502 Service Unavailable - URL Shortener",
    tone: "amber",
    iconHtml: PAGE_ICONS.danger,
    heading: "502 Service Unavailable",
    subtitle: detail || "The homepage theme is temporarily unavailable.",
    bodyHtml: `
      <p class="helper-text">Please refresh the page in a few moments.</p>
      <div class="actions">
        <a href="/" class="btn btn-primary">Retry</a>
      </div>`,
  })
}

function renderCaptchaChallengePage(requestURL = null) {
  const { sdkUrl, apiAttr } = getCaptchaEndpoints()
  const shortLinkLabel = requestURL ? `${requestURL.host}${requestURL.pathname}` : ""

  return renderUnifiedPage({
    title: "Security Verification - URL Shortener",
    tone: "blue",
    iconHtml: PAGE_ICONS.shield,
    heading: "Security Verification",
    subtitle: "Please complete the CAPTCHA below to continue to your destination.",
    maxWidth: "460px",
    extraHead: `<script src="${escapeHtml(sdkUrl)}" defer onerror="window.__capSdkError=true;window.__capLoadFailed&&window.__capLoadFailed()"></script>`,
    bodyHtml: `
      ${shortLinkLabel ? `<div class="link-pill-wrap">
        <div class="link-pill" title="Requested short link">
          ${PAGE_ICONS.link}
          <span>${escapeHtml(shortLinkLabel)}</span>
        </div>
      </div>` : ""}

      <div class="captcha-stage">
        <cap-widget id="cap" data-cap-api-endpoint="${escapeHtml(apiAttr)}"></cap-widget>
      </div>

      <div id="statusNotice" class="notice hidden mt-4" role="status" aria-live="polite"></div>

      <div id="reloadActions" class="actions hidden">
        <button type="button" id="retryCapBtn" class="btn btn-secondary">Retry Challenge</button>
      </div>`,
    extraScript: `<script>
      (function () {
        var widget = document.getElementById("cap");
        var notice = document.getElementById("statusNotice");
        var reloadActions = document.getElementById("reloadActions");
        var retryBtn = document.getElementById("retryCapBtn");

        function setNotice(type, htmlContent) {
          if (!notice) return;
          notice.className = "notice mt-4 notice-" + type;
          notice.innerHTML = htmlContent;
        }

        window.__capLoadFailed = function () {
          setNotice("error", "<span>Failed to load verification widget. Please check your connection.</span>");
          if (reloadActions) reloadActions.classList.remove("hidden");
        };

        if (window.__capSdkError) {
          window.__capLoadFailed();
        }

        if (retryBtn) {
          retryBtn.addEventListener("click", function () {
            if (!window.__capSdkError && widget && typeof widget.reset === "function") {
              try {
                widget.reset();
                if (notice) notice.className = "notice hidden mt-4";
                if (reloadActions) reloadActions.classList.add("hidden");
                return;
              } catch (e) {}
            }
            window.location.reload();
          });
        }

        if (widget) {
          widget.addEventListener("solve", function (e) {
            var token = e && e.detail ? e.detail.token : "";
            if (!token) return;
            setNotice("success", '<span class="spinner" aria-hidden="true"></span><span>Verified! Redirecting to destination...</span>');
            if (reloadActions) reloadActions.classList.add("hidden");
            var nextUrl = new URL(window.location.href);
            nextUrl.searchParams.set("captcha_token", token);
            window.location.href = nextUrl.toString();
          });

          widget.addEventListener("error", function () {
            setNotice("error", "<span>CAPTCHA verification failed. Please try again.</span>");
            if (reloadActions) reloadActions.classList.remove("hidden");
          });

          widget.addEventListener("reset", function () {
            if (notice) notice.className = "notice hidden mt-4";
            if (reloadActions) reloadActions.classList.add("hidden");
          });
        }
      })();
    </script>`,
  })
}

function renderCaptchaFailurePage(errorMsg, requestURL) {
  const retryUrl = new URL(requestURL.toString())
  retryUrl.searchParams.delete("captcha_token")
  retryUrl.searchParams.delete("token")
  const retryHref = escapeHtml(retryUrl.pathname + retryUrl.search)
  const safeError = escapeHtml(errorMsg || "CAPTCHA verification failed")

  return renderUnifiedPage({
    title: "Verification Failed - URL Shortener",
    tone: "red",
    iconHtml: PAGE_ICONS.error,
    heading: "Verification Failed",
    subtitle: "We couldn't validate your security verification token.",
    maxWidth: "460px",
    bodyHtml: `
      <div class="notice notice-error" role="alert">
        <span>${safeError}</span>
      </div>
      <div class="actions">
        <a href="${retryHref}" class="btn btn-primary">Try Verification Again</a>
        <a href="/" class="btn btn-secondary">Back to Homepage</a>
      </div>`,
  })
}

function renderSafeBrowsingWarningPage(location) {
  const escapedUrl = escapeHtml(location)
  return renderUnifiedPage({
    title: "Security Warning - Unsafe URL Detected",
    tone: "red",
    iconHtml: PAGE_ICONS.danger,
    heading: "Warning: Unsafe URL Detected",
    subtitle: "The link you are trying to visit has been flagged as potentially harmful.",
    maxWidth: "520px",
    extraHead: `<meta name="referrer" content="no-referrer">`,
    bodyHtml: `
      <input type="text" class="url-box" value="${escapedUrl}" readonly aria-label="Target URL">
      <p class="helper-text">For your protection, automatic redirection has been blocked. We strongly recommend closing this page. If you understand the risks and still need to proceed, copy the URL above into your browser manually.</p>
      <div class="actions">
        <a href="/" class="btn btn-primary">Return to Safety</a>
      </div>`,
  })
}

function renderNoRefPage(location) {
  const escapedUrl = escapeHtml(location)
  const serializedUrl = serializeForScript(location)
  return renderUnifiedPage({
    title: "Redirecting...",
    tone: "blue",
    iconHtml: `<span class="spinner spinner-lg" aria-hidden="true"></span>`,
    heading: "Redirecting...",
    subtitle: "Taking you to your destination securely.",
    maxWidth: "420px",
    showFooter: false,
    extraHead: `<meta name="referrer" content="no-referrer">\n  <noscript><meta http-equiv="refresh" content="0; url=${escapedUrl}"></noscript>`,
    bodyHtml: `
      <div class="actions" style="margin-top: 0.25rem;">
        <a href="${escapedUrl}" rel="noreferrer noopener" class="btn btn-secondary">Continue to Destination</a>
      </div>`,
    extraScript: `<script>
      (function () {
        var target = new URL(${serializedUrl});
        if (window.location.hash && !target.hash) {
          target.hash = window.location.hash;
        }
        window.location.replace(target.toString());
      })();
    </script>`,
  })
}

async function handleRequest(request, event = null) {
  const requestURL = new URL(request.url)

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(),
    })
  }

  // Handle POST request - Create short link or Pastebin entry
  if (request.method === "POST") {
    const contentType = (request.headers.get("content-type") || "").toLowerCase()
    const isPlainTextBody = contentType.startsWith("text/plain")
    const maxPasteBytes = getEffectiveMaxPasteBytes()

    // Early Content-Length check to reject oversized uploads before buffering body in memory
    const contentLengthHeader = request.headers.get("content-length")
    if (contentLengthHeader !== null) {
      const declaredLength = Number(contentLengthHeader)
      if (Number.isFinite(declaredLength) && declaredLength >= 0) {
        if (isPlainTextBody && declaredLength > maxPasteBytes) {
          return jsonResponse({
            status: 413,
            error: `Paste size (${formatBytes(declaredLength)}) exceeds the maximum limit of ${formatBytes(maxPasteBytes)}`,
            max_bytes: maxPasteBytes,
            actual_bytes: declaredLength,
          }, 413)
        }
        const maxJsonBodyBytes = Math.min(maxPasteBytes * 2 + 64 * 1024, 36 * 1024 * 1024)
        if (!isPlainTextBody && declaredLength > maxJsonBodyBytes) {
          return jsonResponse({
            status: 413,
            error: `Request payload (${formatBytes(declaredLength)}) exceeds maximum allowed size`,
            max_bytes: maxPasteBytes,
          }, 413)
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
        return jsonResponse({
          status: 400,
          error: "Failed to read text request body",
        }, 400)
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
        return jsonResponse({
          status: 400,
          error: "Invalid JSON request body",
        }, 400)
      }

      if (!req || typeof req !== "object") {
        return jsonResponse({
          status: 400,
          error: "Invalid request payload",
        }, 400)
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
      req = null // Allow V8 to reclaim outer JSON object wrapper on large pastes
    }

    let kvValue = null
    let pasteBytes = 0

    if (mode === "paste") {
      if (!config.paste || !config.paste.enabled) {
        return jsonResponse({
          status: 403,
          error: "Pastebin feature is disabled",
        }, 403)
      }

      if (typeof pasteText !== "string" || pasteText.length === 0 || !/\S/.test(pasteText)) {
        return jsonResponse({
          status: 400,
          error: "Paste content cannot be empty",
        }, 400)
      }

      pasteBytes = getUtf8ByteLength(pasteText)
      if (pasteBytes > maxPasteBytes || pasteBytes + PASTE_PREFIX_BYTES > KV_VALUE_MAX_BYTES) {
        return jsonResponse({
          status: 413,
          error: `Paste size (${formatBytes(pasteBytes)}) exceeds the maximum limit of ${formatBytes(maxPasteBytes)}`,
          max_bytes: maxPasteBytes,
          actual_bytes: pasteBytes,
        }, 413)
      }

      kvValue = PASTE_PREFIX + pasteText
      pasteText = null
    } else {
      const urlCheck = validateTargetUrl(rawUrl, requestURL.hostname)
      if (!urlCheck.valid) {
        return jsonResponse({
          status: 400,
          error: urlCheck.error,
        }, 400)
      }
      kvValue = urlCheck.normalizedUrl
    }

    // Validate optional custom key early before external API calls
    const hasCustomKey =
      rawCustomKey !== undefined && rawCustomKey !== null && String(rawCustomKey).trim() !== ""
    let customKey = null

    if (hasCustomKey) {
      if (!config.custom_link) {
        return jsonResponse({
          status: 403,
          error: "Custom short link is disabled",
        }, 403)
      }
      customKey = String(rawCustomKey).trim()
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(customKey) || customKey.toLowerCase() === "raw") {
        return jsonResponse({
          status: 400,
          error: "Invalid custom key format (use 1-64 alphanumeric characters, '-' or '_', excluding reserved 'raw')",
        }, 400)
      }
    }

    // CAPTCHA validation for link/paste creation
    if (isCaptchaRequired("create")) {
      if (!captchaToken) {
        return jsonResponse({
          status: 403,
          error: "CAPTCHA token required",
          captcha_required: true,
        }, 403)
      }

      const validation = await validateCaptchaToken(captchaToken, false)

      if (!validation.success) {
        return jsonResponse({
          status: 403,
          error: validation.error || "CAPTCHA verification failed",
          captcha_required: true,
        }, 403)
      }

      if (validation.degraded) {
        console.warn("Request processed under CAPTCHA service degradation")
      }
    }

    // Safe Browsing check during URL link creation
    if (mode === "url" && getSafeBrowsingApiKey()) {
      const safe = await is_url_safe(kvValue, event)
      if (!safe) {
        return jsonResponse({
          status: 403,
          error: "Unsafe URL blocked by Safe Browsing",
        }, 403)
      }
    }

    // Store in KV with proper error handling
    try {
      let random_key = null

      if (customKey) {
        const existingCustom = await LINKS.get(customKey)
        if (existingCustom !== null) {
          return jsonResponse({
            status: 409,
            error: "Custom short key already exists",
          }, 409)
        }
        await LINKS.put(customKey, kvValue, getKvPutOptions())
        random_key = customKey
      } else if (config.unique_link) {
        const valueHash = await sha512(kvValue)
        const existingKey = await is_url_exist(valueHash)
        if (existingKey) {
          // Ensure mapped short key still exists in KV (guards against expired/deleted keys)
          const existingTarget = await LINKS.get(existingKey)
          if (existingTarget !== null) {
            random_key = existingKey
          }
        }
        if (!random_key) {
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
        }, 200)
      }

      return jsonResponse({
        status: 200,
        type: "url",
        key: "/" + random_key,
        short_url: "/" + random_key,
      }, 200)
    } catch (err) {
      console.error("Failed to store entry in KV:", err.message)
      return jsonResponse({
        status: 500,
        error: "Reached KV write limitation or storage error",
      }, 500)
    }
  }

  // Reject unsupported HTTP methods
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({
      status: 405,
      error: "Method Not Allowed",
    }, 405, {
      "Allow": "GET, HEAD, POST, OPTIONS",
    })
  }

  // Serve homepage
  if (requestURL.pathname === "/") {
    const normalizedTheme = (config.theme || "").trim().replace(/^\/+|\/+$/g, "")
    const useBuiltinHomepage =
      !normalizedTheme || normalizedTheme === "theme/captcha" || normalizedTheme === "builtin"

    if (useBuiltinHomepage) {
      return htmlResponse(
        renderHomepage(),
        200,
        { "Cache-Control": "public, max-age=300" },
        request.method
      )
    }

    const homepageUrl = `https://xytom.github.io/Url-Shorten-Worker/${normalizedTheme}/index.html`

    try {
      const htmlRes = await fetch(homepageUrl, {
        cf: {
          cacheTtl: 3600,
          cacheEverything: true,
        },
      })

      if (!htmlRes.ok) {
        return htmlResponse(
          renderGatewayErrorPage("Failed to load homepage theme."),
          502,
          {},
          request.method
        )
      }

      return htmlResponse(
        await htmlRes.text(),
        200,
        { "Cache-Control": "public, max-age=600" },
        request.method
      )
    } catch (err) {
      console.error("Homepage fetch error:", err.message)
      return htmlResponse(
        renderGatewayErrorPage("Homepage temporarily unavailable."),
        502,
        {},
        request.method
      )
    }
  }

  // Short-circuit common browser/crawler static paths to avoid wasted KV reads
  if (requestURL.pathname === "/favicon.ico") {
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "public, max-age=86400" },
    })
  }
  if (requestURL.pathname === "/robots.txt") {
    return new Response(request.method === "HEAD" ? null : "User-agent: *\nDisallow:\n", {
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

  if (!path) {
    return htmlResponse(html404, 404, {}, request.method)
  }

  // Retrieve entry from KV with edge read cache
  const value = await LINKS.get(path, getKvReadOptions())
  if (!value) {
    return htmlResponse(html404, 404, {}, request.method)
  }

  const isPasteEntry = value.startsWith(PASTE_PREFIX)

  // `/raw/:key` is exclusively for Pastebin entries
  if (isRawPath && !isPasteEntry) {
    return htmlResponse(html404, 404, {}, request.method)
  }

  // For URL entries, validate redirect URL before running access checks
  const location = isPasteEntry ? null : buildRedirectUrl(value, requestURL)
  if (!isPasteEntry && !location) {
    return htmlResponse(html404, 404, {}, request.method)
  }

  // CAPTCHA validation for link/paste access
  if (isCaptchaRequired("access")) {
    const captchaToken = await extractCaptchaToken(request)

    if (!captchaToken) {
      return htmlResponse(
        renderCaptchaChallengePage(requestURL),
        403,
        { "Cache-Control": "private, no-store" },
        request.method
      )
    }

    const validation = await validateCaptchaToken(captchaToken, false)

    if (!validation.success) {
      return htmlResponse(
        renderCaptchaFailurePage(validation.error, requestURL),
        403,
        { "Cache-Control": "private, no-store" },
        request.method
      )
    }

    if (validation.degraded) {
      console.warn("Access granted under CAPTCHA service degradation")
    }
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
      const disposition = isDownload
        ? `attachment; filename="${safeFilename}.txt"`
        : `inline; filename="${safeFilename}.txt"`

      return new Response(request.method === "HEAD" ? null : pasteContent, {
        status: 200,
        headers: {
          "content-type": "text/plain;charset=UTF-8",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Disposition": disposition,
          "Cache-Control": cacheControl,
          ...getCorsHeaders(),
        },
      })
    }

    return htmlResponse(
      renderPasteViewPage(path, pasteContent),
      200,
      {
        "Cache-Control": cacheControl,
        "Referrer-Policy": "no-referrer",
      },
      request.method
    )
  }

  // Safe Browsing check for URL entries (keyed on stored target URL to prevent query-param cache busting)
  if (getSafeBrowsingApiKey()) {
    if (!(await is_url_safe(value, event))) {
      return htmlResponse(
        renderSafeBrowsingWarningPage(location),
        403,
        { "Referrer-Policy": "no-referrer" },
        request.method
      )
    }
  }

  // Redirect to target URL
  if (config.no_ref === "on") {
    return htmlResponse(
      renderNoRefPage(location),
      200,
      {
        "Referrer-Policy": "no-referrer",
        "Cache-Control": cacheControl,
      },
      request.method
    )
  }

  return new Response(null, {
    status: 302,
    headers: {
      "Location": location,
      "Cache-Control": cacheControl,
    },
  })
}

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request, event))
})
