function loadUrlList() {
    alert("Load url list from localStorage!")    
/*
    let urlList = document.querySelector("#urlList")
    let child = document.createElement('li')
    let text = document.createTextNode("loadUrlList")
    child.appendChild(text)
    urlList.append(child)
*/
    let len = localStorage.length
    console.log(+len)
    for (; len >= 0; len--) {
        let keyShortURL=localStorage.key(len)
        let valueLongURL=localStorage.getItem(keyShortURL)

        let urlList = document.querySelector("#urlList")
        let child = document.createElement('li')
        let text = document.createTextNode(keyShortURL + " " + valueLongURL)
        child.appendChild(text)
        urlList.append(child)
    }

}