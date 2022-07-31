function loadUrlList() {
    alert("Load url list from localStorage!")    
/*
    urlList = document.querySelector("#urlList")
    let child = document.createElement('li')
    let text = document.createTextNode("loadUrlList")
    child.appendChild(text)
    urlList.append(child)
*/
    let len = localStorage.len
    console.log(+len)
    for (; len >= 0; len--) {
        keyShortURL=localStorage.key(len)
        valueLongURL=localStorage.getItem(keyShortURL)

        urlList = document.querySelector("#urlList")
        let child = document.createElement('li')
        let text = document.createTextNode(keyShortURL + " " + valueLongURL)
        child.appendChild(text)
        urlList.append(child)
    }

}