const config = {
no_ref: "off", //Control the HTTP referrer header, if you want to create an anonymous link that will hide the HTTP Referer header, please set to "on" .
theme:"",//Homepage theme, use the empty value for default theme. To use urlcool theme, please fill with "theme/urlcool" .
cors: "on",//Allow Cross-origin resource sharing for API requests.
unique_link:true,//If it is true, the same long url will be shorten into the same short url
custom_link:false,//Allow users to customize the short url.
safe_browsing_api_key: "" //Enter Google Safe Browsing API Key to enable url safety check before redirect.
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
　　for (i = 0; i < len; i++) {
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
        save_url(URL)
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

  result = await fetch("https://safebrowsing.googleapis.com/v4/threatMatches:find?key="+config.safe_browsing_api_key, requestOptions)
  result = await result.json()
  console.log(result)
  if (Object.keys(result).length === 0){
    return true
  }else{
    return false
  }
}
async function handleRequest(request) {
  console.log(request)
  if (request.method === "POST") {
    let req=await request.json()
    console.log(req["url"])
    if(!await checkURL(req["url"])){
    return new Response(`{"status":500,"key":": Error: Url illegal."}`, {
      headers: response_header,
    })}
    let stat,random_key
    if (config.unique_link){
      let url_sha512 = await sha512(req["url"])
      let url_key = await is_url_exist(url_sha512)
      if(url_key){
        random_key = url_key
      }else{
        stat,random_key=await save_url(req["url"])
        if (typeof(stat) == "undefined"){
          console.log(await LINKS.put(url_sha512,random_key))
        }
      }
    }else{
      stat,random_key=await save_url(req["url"])
    }
    console.log(stat)
    if (typeof(stat) == "undefined"){
      return new Response(`{"status":200,"key":"/`+random_key+`"}`, {
      headers: response_header,
    })
    }else{
      return new Response(`{"status":200,"key":": Error:Reach the KV write limitation."}`, {
      headers: response_header,
    })}
  }else if(request.method === "OPTIONS"){  
      return new Response(``, {
      headers: response_header,
    })

  }

  const requestURL = new URL(request.url)
  const path = requestURL.pathname.split("/")[1]
  const params = requestURL.search;

  console.log(path)
  if(!path){

    const html= await fetch("https://xytom.github.io/Url-Shorten-Worker/"+config.theme+"/index.html")
    
    return new Response(await html.text(), {
    headers: {
      "content-type": "text/html;charset=UTF-8",
    },
  })
  }

  const value = await LINKS.get(path);
  let location ;

  if(params) {
    location = value + params
  } else {
      location = value
  }
  console.log(value)
  

  if (location) {
    if (config.safe_browsing_api_key){
      if(!(await is_url_safe(location))){
        let warning_page = await fetch("https://xytom.github.io/Url-Shorten-Worker/safe-browsing.html")
        warning_page =await warning_page.text()
        warning_page = warning_page.replace(/{Replace}/gm, location)
        return new Response(warning_page, {
          headers: {
            "content-type": "text/html;charset=UTF-8",
          },
        })
      }
    }
    if (config.no_ref=="on"){
      let no_ref= await fetch("https://xytom.github.io/Url-Shorten-Worker/no-ref.html")
      no_ref=await no_ref.text()
      no_ref=no_ref.replace(/{Replace}/gm, location)
      return new Response(no_ref, {
      headers: {
        "content-type": "text/html;charset=UTF-8",
      },
    })
    }else{
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
