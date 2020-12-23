const html404 = `<!DOCTYPE html>
<body>
  <h1>404 Not Found.</h1>
  <p>The url you visit is not found.</p>
</body>`


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
async function checkURL(URL){
    let str=URL;
    let Expression=/http(s)?:\/\/([\w-]+\.)+[\w-]+(\/[\w- .\/?%&=]*)?/;
    let objExp=new RegExp(Expression);
    return objExp.test(str) && str[0] === 'h';
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
async function handleRequest(request) {
  console.log(request)
  if (request.method === "POST") {
    let req=await request.json()
    console.log(req["url"])
    if(!await checkURL(req["url"]))
    return new Response(`{"status":500,"key":": Error: Url illegal."}`)
    let stat,random_key=await save_url(req["url"])
    console.log(stat)
    if (typeof(stat) == "undefined")
      return new Response(`{"status":200,"key":"/`+random_key+`"}`)
    else
      return new Response(`{"status":200,"key":": Error:Reach the KV write limitation."}`)
  }

  const requestURL = new URL(request.url)
  const path = requestURL.pathname.split("/")[1]
  console.log(path)
  if(!path){

    const html= await fetch("https://xytom.github.io/Url-Shorten-Worker/")
    
    return new Response(await html.text(), {
    headers: {
      "content-type": "text/html;charset=UTF-8",
    },
  })
  }
  const value = await LINKS.get(path)
  console.log(value)
  

  const location = value
  if (location) {
    return Response.redirect(location, 302)
    
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
