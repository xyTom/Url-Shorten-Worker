# CAPTCHA Integration Documentation

## 📋 Overview

This project has integrated the CAP Worker CAPTCHA service to provide enterprise-grade bot protection and abuse prevention. The system implements graceful degradation strategies to ensure core business operations remain unaffected when the CAPTCHA service encounters issues.

## ⚙️ Configuration

### Environment Variables

Configure CAPTCHA-related parameters in the `config` object in `index.js`:

```javascript
captcha: {
  enabled: true,              // Master switch: enable/disable CAPTCHA service
  api_endpoint: "https://captcha.gurl.eu.org/api",  // CAP Worker API endpoint
  require_on_create: true,    // Require CAPTCHA when creating short links (default: true)
  require_on_access: false,   // Require CAPTCHA when accessing short links (default: false)
  timeout: 5000,              // API request timeout in milliseconds
  fallback_on_error: true,    // Allow operations when CAPTCHA service is down (service degradation)
  max_retries: 2,             // Maximum retry attempts for API calls
}
```

### Configuration Scenarios

#### Scenario 1: Default Configuration (Recommended)
```javascript
captcha: {
  enabled: true,
  require_on_create: true,   // CAPTCHA required for creation
  require_on_access: false,  // No CAPTCHA for access
  fallback_on_error: true,   // Allow operations on service failure
}
```
**Use case**: Most scenarios, prevent short link creation abuse

#### Scenario 2: Strict Mode
```javascript
captcha: {
  enabled: true,
  require_on_create: true,   // CAPTCHA required for creation
  require_on_access: true,   // CAPTCHA required for access
  fallback_on_error: false,  // Block operations on service failure
}
```
**Use case**: High-security requirements, complete protection

#### Scenario 3: Access Protection Only
```javascript
captcha: {
  enabled: true,
  require_on_create: false,  // No CAPTCHA for creation
  require_on_access: true,   // CAPTCHA required for access
  fallback_on_error: true,
}
```
**Use case**: Prevent malicious access and crawlers

#### Scenario 4: Completely Disabled
```javascript
captcha: {
  enabled: false,  // Completely disable CAPTCHA functionality
}
```

## 🔧 API Usage Guide

### Create Short Link (with CAPTCHA)

**Frontend Example**:

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://captcha.gurl.eu.org/cap.min.js"></script>
</head>
<body>
  <input type="url" id="longUrl" placeholder="Enter long URL">
  <button onclick="createShortLink()">Create Short Link</button>
  
  <cap-widget 
    id="cap" 
    data-cap-api-endpoint="https://captcha.gurl.eu.org/api/">
  </cap-widget>

  <div id="result"></div>

  <script>
    const widget = document.querySelector("#cap");
    let captchaToken = null;

    // Listen for CAPTCHA completion event
    widget.addEventListener("solve", function(e) {
      captchaToken = e.detail.token;
      console.log("CAPTCHA completed");
    });

    async function createShortLink() {
      const longUrl = document.getElementById('longUrl').value;
      
      if (!captchaToken) {
        alert('Please complete the CAPTCHA first');
        return;
      }

      try {
        const response = await fetch('https://your-worker.workers.dev/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: longUrl,
            captcha_token: captchaToken  // Pass CAPTCHA token
          })
        });

        const result = await response.json();
        
        if (result.status === 200) {
          document.getElementById('result').innerHTML = 
            `Short link: <a href="${result.key}">${result.key}</a>`;
          captchaToken = null; // Reset token
        } else {
          alert('Creation failed: ' + result.error);
          if (result.captcha_required) {
            // Need to reverify
            captchaToken = null;
          }
        }
      } catch (error) {
        alert('Request failed: ' + error.message);
      }
    }
  </script>
</body>
</html>
```

**Backend/Server-side Example (Node.js)**:

```javascript
const fetch = require('node-fetch');

async function createShortLink(longUrl, captchaToken) {
  const response = await fetch('https://your-worker.workers.dev/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: longUrl,
      captcha_token: captchaToken
    })
  });

  const result = await response.json();
  
  if (result.status === 200) {
    console.log('Short link created successfully:', result.key);
    return result.key;
  } else {
    throw new Error(result.error || 'Creation failed');
  }
}
```

**cURL Example**:

```bash
curl -X POST https://your-worker.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/very/long/url",
    "captcha_token": "785975238a3c4f0c1b0c39ed75e6e4cc152436cc0d94363de6"
  }'
```

### API Response Format

**Success Response**:
```json
{
  "status": 200,
  "key": "/abc123",
  "short_url": "/abc123"
}
```

**CAPTCHA Error Response**:
```json
{
  "status": 403,
  "error": "CAPTCHA token required",
  "captcha_required": true
}
```

**CAPTCHA Verification Failed**:
```json
{
  "status": 403,
  "error": "Invalid or expired token",
  "captcha_required": true
}
```

## 🛡️ Service Degradation Strategy

The system implements multi-layer service degradation mechanisms to ensure high availability:

### 1. Retry Mechanism
- Automatically retry failed CAPTCHA API calls
- Exponential backoff strategy (100ms → 200ms → 400ms)
- Configurable maximum retry count (default: 2)

### 2. Timeout Protection
- Default 5-second timeout
- Prevents slow CAPTCHA service from affecting user experience

### 3. Graceful Degradation
When `fallback_on_error: true`:
- Allow operations to continue when CAPTCHA service is completely unavailable
- Log warnings for monitoring and troubleshooting
- Ensure core business is not affected

### 4. Error Classification Handling
- **Client errors (400, 401, 403, 404, 409, 410)**: No retry, return error immediately
- **Server errors (500, 502, 503)**: Retry then degrade
- **Network errors**: Retry then degrade

## 📊 Monitoring and Logging

The system logs the following key events:

```javascript
// CAPTCHA validation failure
console.error('CAPTCHA validation attempt 1 failed: Timeout')

// Service degradation
console.warn('CAPTCHA service degraded: HTTP 503. Allowing operation due to fallback policy.')

// Processing request under degradation
console.warn('Request processed under CAPTCHA service degradation')
console.warn('Access granted under CAPTCHA service degradation')
```

Recommended for production environment:
1. Monitor the frequency of degradation events
2. Set alert thresholds
3. Regularly check CAPTCHA service health status

## 🔒 Security Best Practices

### 1. Token Security
- One-time token usage (default `keepToken: false`)
- Tokens have expiration time
- Server-side validation, cannot be forged on frontend

### 2. Configuration Recommendations
```javascript
// Recommended production configuration
captcha: {
  enabled: true,
  require_on_create: true,      // Must enable
  require_on_access: false,     // Depends on traffic
  timeout: 5000,                // Moderate
  fallback_on_error: true,      // Recommended
  max_retries: 2,               // 2-3 times sufficient
}
```

### 3. Rate Limiting
Recommend combining with Cloudflare Workers rate limiting:
- Limit creation frequency per IP
- Limit access frequency per IP
- Multi-layer protection with CAPTCHA

## 🚀 Performance Optimization

### 1. Caching Strategy
- CAPTCHA tokens are one-time use, no caching needed
- Short link data uses KV storage, automatically globally distributed

### 2. Concurrent Processing
- CAPTCHA validation executes asynchronously
- Does not block other requests

### 3. Resource Loading
```html
<!-- Preload CAPTCHA SDK -->
<link rel="preload" href="https://captcha.gurl.eu.org/cap.min.js" as="script">
```

## 🧪 Testing Guide

### Test CAPTCHA Integration

```javascript
// Test script
async function testCaptcha() {
  // 1. Get CAPTCHA challenge
  const challenge = await fetch('https://captcha.gurl.eu.org/api/challenge', {
    method: 'POST'
  });
  const challengeData = await challenge.json();
  console.log('Challenge:', challengeData);

  // 2. Simulate user answer (actually needs user interaction)
  const solutions = [1, 3, 7]; // Example answer

  // 3. Submit answer
  const redeem = await fetch('https://captcha.gurl.eu.org/api/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: challengeData.token,
      solutions: solutions
    })
  });
  const redeemData = await redeem.json();
  console.log('Redeem:', redeemData);

  // 4. Use token to create short link
  const create = await fetch('https://your-worker.workers.dev/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://example.com',
      captcha_token: redeemData.token
    })
  });
  const createData = await create.json();
  console.log('Create:', createData);
}
```

### Test Degradation Strategy

```javascript
// Simulate CAPTCHA service failure
captcha: {
  enabled: true,
  api_endpoint: "https://invalid-endpoint.example.com/api", // Invalid endpoint
  fallback_on_error: true, // Should allow operation
}

// Should successfully create short link and log degradation
```

## 📝 Troubleshooting

### Issue 1: CAPTCHA Always Fails
**Check**:
- Confirm `captcha.enabled = true`
- Confirm API endpoint is correct
- Check if token is correctly passed
- Check browser console for errors

### Issue 2: Service Frequently Degrades
**Check**:
- Is CAPTCHA service stable?
- Is network latency too high?
- Consider increasing `timeout` value
- Consider increasing `max_retries` value

### Issue 3: Access Page Requires CAPTCHA
**Solution**:
```javascript
// If you don't want CAPTCHA on access
captcha: {
  require_on_access: false  // Change to false
}
```

## 🔄 Migration Guide

### Upgrade from Non-CAPTCHA Version

1. **Update code**: Replace `index.js` file
2. **Configure CAPTCHA**: Set `captcha` configuration
3. **Update frontend**: Add CAPTCHA component
4. **Test**: Ensure existing functionality works
5. **Monitor**: Observe degradation events

### Rollback Plan

```javascript
// Completely disable CAPTCHA, restore original behavior
captcha: {
  enabled: false
}
```

## 📞 Technical Support

- **CAPTCHA Service Documentation**: Refer to CAP Worker official documentation
- **Issue Feedback**: Submit GitHub Issue
- **Community Discussion**: Join community forum

---

**Version**: 2.0.0  
**Last Updated**: 2025-11-06
