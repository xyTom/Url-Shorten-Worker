function loadUrlList() {
    // 清空列表
    let urlList = document.querySelector("#urlList")
    while (urlList.firstChild) {
        urlList.removeChild(urlList.firstChild)
    }

    // 遍历localStorage
    let len = localStorage.length
    console.log(+len)
    for (; len > 0; len--) {
        let keyShortURL = localStorage.key(len - 1)
        let valueLongURL = localStorage.getItem(keyShortURL)

        let child = document.createElement('li')
        let text = document.createTextNode(keyShortURL + " " + valueLongURL)
        child.appendChild(text)
        urlList.append(child)
    }
}