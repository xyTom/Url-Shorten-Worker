function loadUrlList() {
    console.log("loadUrlList")
    var len = localStorage.len
    console.log(len)
    for (; len >= 0; len--) {
        keyShortURL=localStorage.key(len)
        valueLongURL=localStorage.getItem(keyShortURL)

        urlList = document.querySelector("#urlList")
        var child = document.createEtement('li')
        var text = document.createTextNode(keyShortURL + " " + valueLongURL)
        child.appendChild(text)
        urlPair.append(child)
    }
}