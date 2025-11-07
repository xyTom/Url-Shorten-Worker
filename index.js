const config = {
  no_ref: "off", //Control the HTTP referrer header, if you want to create an anonymous link that will hide the HTTP Referer header, please set to "on" .
  theme:"theme/captcha",//Homepage theme, use the empty value for default theme. To use urlcool theme, please fill with "theme/urlcool" . If you need captcha feature, you need to use captcha theme.
  cors: "on",//Allow Cross-origin resource sharing for API requests.
  unique_link:true,//If it is true, the same long url will be shorten into the same short url
  custom_link:false,//Allow users to customize the short url.
  safe_browsing_api_key: "", //Enter Google Safe Browsing API Key to enable url safety check before redirect.
  
  // CAPTCHA Configuration
  captcha: {
    enabled: true, // Master switch for CAPTCHA service
    api_endpoint: "https://captcha.gurl.eu.org/api", // CAP Worker API endpoint
    require_on_create: true, // Require CAPTCHA when creating short links
    require_on_access: true, // Require CAPTCHA when accessing short links
    timeout: 5000, // API request timeout in milliseconds
    fallback_on_error: true, // Allow operations when CAPTCHA service is down
    max_retries: 2, // Maximum retry attempts for CAPTCHA API calls
  }
  }
  
  const html404 = `<!DOCTYPE html>
  <body>
    <h1>404 Not Found.</h1>
    <p>The url you visit is not found.</p>
    <a href="https://github.com/xyTom/Url-Shorten-Worker/" target="_self">Fork me on GitHub</a>
  </body>`
  
  let response_header={
    "content-type": "text/html;charset=UTF-8",
  } 
  
  if (config.cors=="on"){
    response_header={
    "content-type": "text/html;charset=UTF-8",
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods": "POST",
    }
  }
  
  async function randomString(len) {
  　　len = len || 6;
  　　let $chars = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';    /****默认去掉了容易混淆的字符oOLl,9gq,Vv,Uu,I1****/
  　　let maxPos = $chars.length;
  　　let result = '';
  　　for (let i = 0; i < len; i++) {
  　　　　result += $chars.charAt(Math.floor(Math.random() * maxPos));
  　　}
  　　return result;
  }
  
  async function sha512(url){
      url = new TextEncoder().encode(url)
  
      const url_digest = await crypto.subtle.digest(
        {
          name: "SHA-512",
        },
        url, // The data you want to hash as an ArrayBuffer
      )
      const hashArray = Array.from(new Uint8Array(url_digest)); // convert buffer to byte array
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      //console.log(hashHex)
      return hashHex
  }
  async function checkURL(URL){
      let str=URL;
      let Expression=/http(s)?:\/\/([\w-]+\.)+[\w-]+(\/[\w- .\/?%&=]*)?/;
      let objExp=new RegExp(Expression);
      if(objExp.test(str)==true){
        if (str[0] == 'h')
          return true;
        else
          return false;
      }else{
          return false;
      }
  } 
  async function save_url(URL){
      let random_key=await randomString()
      let is_exist=await LINKS.get(random_key)
      console.log(is_exist)
      if (is_exist == null)
          return await LINKS.put(random_key, URL),random_key
      else
          return save_url(URL)
  }
  async function is_url_exist(url_sha512){
    let is_exist = await LINKS.get(url_sha512)
    console.log(is_exist)
    if (is_exist == null) {
      return false
    }else{
      return is_exist
    }
  }
  async function is_url_safe(url){
  
    let raw = JSON.stringify({"client":{"clientId":"Url-Shorten-Worker","clientVersion":"1.0.7"},"threatInfo":{"threatTypes":["MALWARE","SOCIAL_ENGINEERING","POTENTIALLY_HARMFUL_APPLICATION","UNWANTED_SOFTWARE"],"platformTypes":["ANY_PLATFORM"],"threatEntryTypes":["URL"],"threatEntries":[{"url":url}]}});
  
    let requestOptions = {
      method: 'POST',
      body: raw,
      redirect: 'follow'
    };
  
    let result = await fetch("https://safebrowsing.googleapis.com/v4/threatMatches:find?key="+config.safe_browsing_api_key, requestOptions)
    result = await result.json()
    console.log(result)
    if (Object.keys(result).length === 0){
      return true
    }else{
      return false
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
    // If CAPTCHA is disabled, always return success
    if (!config.captcha.enabled) {
      return { success: true, degraded: false };
    }
  
    // Validate token format
    if (!token || typeof token !== 'string' || token.length < 10) {
      return { success: false, error: 'Invalid token format' };
    }
  
    let lastError = null;
    const maxRetries = config.captcha.max_retries || 2;
  
    // Retry mechanism for resilience
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), config.captcha.timeout);
  
        const response = await fetch(`${config.captcha.api_endpoint}/validate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Url-Shorten-Worker/1.0.7',
          },
          body: JSON.stringify({ token, keepToken }),
          signal: controller.signal,
        });
  
        clearTimeout(timeoutId);
  
        // Handle various HTTP status codes
        if (response.ok) {
          const result = await response.json();
          return { success: result.success === true, degraded: false };
        }
  
        // Handle specific error codes
        if (response.status === 400 || response.status === 410 || response.status === 404 || response.status === 409) {
          // Client error, no need to retry
          return { success: false, error: 'Invalid or expired token' };
        }
  
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error.name === 'AbortError' ? 'Timeout' : error.message;
        console.error(`CAPTCHA validation attempt ${attempt + 1} failed:`, lastError);
  
        // Exponential backoff before retry (except on last attempt)
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
        }
      }
    }
  
    // Service degradation: if fallback is enabled, allow operation
    if (config.captcha.fallback_on_error) {
      console.warn(`CAPTCHA service degraded: ${lastError}. Allowing operation due to fallback policy.`);
      return { success: true, degraded: true };
    }
  
    return { success: false, error: lastError || 'CAPTCHA service unavailable' };
  }
  
  /**
   * Checks if CAPTCHA is required for the current operation
   * @param {string} operation - 'create' or 'access'
   * @returns {boolean}
   */
  function isCaptchaRequired(operation) {
    if (!config.captcha.enabled) {
      return false;
    }
  
    switch (operation) {
      case 'create':
        return config.captcha.require_on_create;
      case 'access':
        return config.captcha.require_on_access;
      default:
        return false;
    }
  }
  
  /**
   * Extracts CAPTCHA token from request
   * @param {Request} request - The incoming request
   * @returns {Promise<string|null>}
   */
  async function extractCaptchaToken(request) {
    const contentType = request.headers.get('content-type') || '';
  
    if (contentType.includes('application/json')) {
      try {
        const body = await request.clone().json();
        return body.captcha_token || body.captchaToken || body.token || null;
      } catch {
        return null;
      }
    }
  
    // Try to extract from URL parameters
    const url = new URL(request.url);
    return url.searchParams.get('captcha_token') || url.searchParams.get('token') || null;
  }
  
  // ============ End CAPTCHA Service Integration ============
  async function handleRequest(request) {
    console.log(request)
    
    // Handle POST request - Create short link
    if (request.method === "POST") {
      let req = await request.json()
      console.log(req["url"])
      
      // Validate URL format
      if (!await checkURL(req["url"])) {
        return new Response(JSON.stringify({
          status: 500,
          error: "Invalid URL format"
        }), {
          headers: response_header,
          status: 400
        })
      }
  
      // CAPTCHA validation for link creation
      if (isCaptchaRequired('create')) {
        const captchaToken = req.captcha_token || req.captchaToken || req.token;
        
        if (!captchaToken) {
          return new Response(JSON.stringify({
            status: 403,
            error: "CAPTCHA token required",
            captcha_required: true
          }), {
            headers: response_header,
            status: 403
          })
        }
  
        const validation = await validateCaptchaToken(captchaToken, false);
        
        if (!validation.success) {
          return new Response(JSON.stringify({
            status: 403,
            error: validation.error || "CAPTCHA verification failed",
            captcha_required: true
          }), {
            headers: response_header,
            status: 403
          })
        }
  
        // Log if service is degraded
        if (validation.degraded) {
          console.warn("Request processed under CAPTCHA service degradation");
        }
      }
  
      // Process short link creation
      let stat, random_key
      if (config.unique_link) {
        let url_sha512 = await sha512(req["url"])
        let url_key = await is_url_exist(url_sha512)
        if (url_key) {
          random_key = url_key
        } else {
          stat, random_key = await save_url(req["url"])
          if (typeof(stat) == "undefined") {
            console.log(await LINKS.put(url_sha512, random_key))
          }
        }
      } else {
        stat, random_key = await save_url(req["url"])
      }
      
      console.log(stat)
      if (typeof(stat) == "undefined") {
        return new Response(JSON.stringify({
          status: 200,
          key: "/" + random_key,
          short_url: "/" + random_key
        }), {
          headers: response_header,
        })
      } else {
        return new Response(JSON.stringify({
          status: 500,
          error: "Reached KV write limitation"
        }), {
          headers: response_header,
          status: 500
        })
      }
    } else if (request.method === "OPTIONS") {  
      return new Response("", {
        headers: response_header,
      })
    }
  
    // Handle GET request - Access short link
    const requestURL = new URL(request.url)
    const path = requestURL.pathname.split("/")[1]
    const params = requestURL.search
  
    console.log(path)
    
    // Serve homepage
    if (!path) {
      const html = await fetch("https://xytom.github.io/Url-Shorten-Worker/" + config.theme + "/index.html")
      
      return new Response(await html.text(), {
        headers: {
          "content-type": "text/html;charset=UTF-8",
        },
      })
    }
  
    // Retrieve the target URL
    const value = await LINKS.get(path)
    let location
  
    if (params) {
      location = value + params
    } else {
      location = value
    }
    console.log(value)
  
    if (location) {
      // CAPTCHA validation for link access
      if (isCaptchaRequired('access')) {
        const captchaToken = await extractCaptchaToken(request)
        
        if (!captchaToken) {
          // Return CAPTCHA challenge page
          const captchaPage = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verification Required</title>
    <script src="https://captcha.gurl.eu.org/cap.min.js"></script>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; 
             display: flex; justify-content: center; align-items: center; min-height: 100vh; 
             margin: 0; background: linear-gradient(45deg, rgba(14, 46, 75, 1.000) 0.000%, rgba(14, 46, 75, 1.000) 7.692%, rgba(19, 52, 84, 1.000) 7.692%, rgba(19, 52, 84, 1.000) 15.385%, rgba(25, 58, 94, 1.000) 15.385%, rgba(25, 58, 94, 1.000) 23.077%, rgba(31, 65, 104, 1.000) 23.077%, rgba(31, 65, 104, 1.000) 30.769%, rgba(38, 72, 115, 1.000) 30.769%, rgba(38, 72, 115, 1.000) 38.462%, rgba(45, 79, 126, 1.000) 38.462%, rgba(45, 79, 126, 1.000) 46.154%, rgba(52, 86, 138, 1.000) 46.154%, rgba(52, 86, 138, 1.000) 53.846%, rgba(59, 93, 150, 1.000) 53.846%, rgba(59, 93, 150, 1.000) 61.538%, rgba(67, 101, 163, 1.000) 61.538%, rgba(67, 101, 163, 1.000) 69.231%, rgba(75, 109, 176, 1.000) 69.231%, rgba(75, 109, 176, 1.000) 76.923%, rgba(83, 117, 188, 1.000) 76.923%, rgba(83, 117, 188, 1.000) 84.615%, rgba(91, 125, 201, 1.000) 84.615%, rgba(91, 125, 201, 1.000) 92.308%, rgba(99, 134, 214, 1.000) 92.308% 100.000%) }
      .container { background: white; padding: 2rem; border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,0.1); 
                   max-width: 400px; text-align: center; }
      h1 { color: #333; margin-bottom: 1rem; font-size: 1.5rem; }
      p { color: #666; margin-bottom: 2rem; }
      #cap { margin: 2rem 0; display: flex; justify-content: center;}
      .loading { display: none; color: #667eea; margin-top: 1rem; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>🔒 Verification Required</h1>
      <p>Please complete the CAPTCHA below to access this link.</p>
      
      <cap-widget id="cap" data-cap-api-endpoint="https://captcha.gurl.eu.org/api/"></cap-widget>
      
      <div class="loading" id="loading">Verifying and redirecting...</div>
    </div>
  
    <script>
      const widget = document.querySelector("#cap");
      const loading = document.getElementById("loading");
      
      widget.addEventListener("solve", async function (e) {
        const token = e.detail.token;
        loading.style.display = "block";
        
        // Redirect with token
        window.location.href = window.location.pathname + "?captcha_token=" + encodeURIComponent(token);
      });
    </script>
  </body>
  </html>`
          
          return new Response(captchaPage, {
            headers: {
              "content-type": "text/html;charset=UTF-8",
            },
            status: 403
          })
        }
  
        const validation = await validateCaptchaToken(captchaToken, false)
        
        if (!validation.success) {
          return new Response(`
  <!DOCTYPE html>
  <html>
  <head><title>Verification Failed</title></head>
  <body>
    <h1>❌ Verification Failed</h1>
    <p>${validation.error || 'CAPTCHA verification failed'}</p>
    <a href="${requestURL.pathname}">Try again</a>
  </body>
  </html>`, {
            headers: {
              "content-type": "text/html;charset=UTF-8",
            },
            status: 403
          })
        }
  
        if (validation.degraded) {
          console.warn("Access granted under CAPTCHA service degradation")
        }
      }
  
      // Safe browsing check
      if (config.safe_browsing_api_key) {
        if (!(await is_url_safe(location))) {
          let warning_page = await fetch("https://xytom.github.io/Url-Shorten-Worker/safe-browsing.html")
          warning_page = await warning_page.text()
          warning_page = warning_page.replace(/{Replace}/gm, location)
          return new Response(warning_page, {
            headers: {
              "content-type": "text/html;charset=UTF-8",
            },
          })
        }
      }
  
      // Redirect to target URL
      if (config.no_ref == "on") {
        let no_ref = await fetch("https://xytom.github.io/Url-Shorten-Worker/no-ref.html")
        no_ref = await no_ref.text()
        no_ref = no_ref.replace(/{Replace}/gm, location)
        return new Response(no_ref, {
          headers: {
            "content-type": "text/html;charset=UTF-8",
          },
        })
      } else {
        return Response.redirect(location, 302)
      }
    }
    
    // If request not in kv, return 404
    return new Response(html404, {
      headers: {
        "content-type": "text/html;charset=UTF-8",
      },
      status: 404
    })
  }
  
  
  
  addEventListener("fetch", async event => {
    event.respondWith(handleRequest(event.request))
  })
