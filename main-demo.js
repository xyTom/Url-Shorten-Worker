let res
function shorturl() {
  if (document.querySelector("#longURL").value == "") {
    alert("Url cannot be empty!")
    return
  }

  document.getElementById("searchbtn").disabled = true;
  document.getElementById("searchbtn").innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>Please wait...';
  fetch(window.location.pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: document.querySelector("#longURL").value, customShortURL: document.querySelector("#customShortURL").value, password: document.querySelector("#passwordText").value })
  }).then(function (response) {
    return response.json();
  })
    .then(function (myJson) {
      res = myJson;
      document.getElementById("searchbtn").disabled = false;
      document.getElementById("searchbtn").innerHTML = ' Shorten it';
      if (res.key !== "") {
        document.getElementById("result").innerHTML = window.location.host + res.key;
      }
      $('#exampleModal').modal('show')

      // 成功生成短链
      if (res.status == "200") {
        // let keyShortURL = window.location.host + res.key;
        let keyPhrase = res.key;
        let valueLongURL = document.querySelector("#longURL").value;
        // save to localStorage
        localStorage.setItem(keyPhrase, valueLongURL);
        // add to urlList on the page
        addUrlToList(keyPhrase, valueLongURL)
      }

    }).catch(function (err) {
      alert("Unknow error. Please retry!");
      console.log(err);
      document.getElementById("searchbtn").disabled = false;
      document.getElementById("searchbtn").innerHTML = ' Shorten it';
    })
}
function copyurl(id, attr) {
  let target = null;

  if (attr) {
    target = document.createElement('div');
    target.id = 'tempTarget';
    target.style.opacity = '0';
    if (id) {
      let curNode = document.querySelector('#' + id);
      target.innerText = curNode[attr];
    } else {
      target.innerText = attr;
    }
    document.body.appendChild(target);
  } else {
    target = document.querySelector('#' + id);
  }

  try {
    let range = document.createRange();
    range.selectNode(target);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.execCommand('copy');
    window.getSelection().removeAllRanges();
    console.log('Copy success')
  } catch (e) {
    console.log('Copy error')
  }

  if (attr) {
    // remove temp target
    target.parentElement.removeChild(target);
  }
}
function loadUrlList() {
  // 清空列表
  let urlList = document.querySelector("#urlList")
  while (urlList.firstChild) {
    urlList.removeChild(urlList.firstChild)
  }

  // 文本框中的长链接
  let longUrl = document.querySelector("#longURL").value
  console.log(longUrl)

  // 遍历localStorage
  let len = localStorage.length
  console.log(+len)
  for (; len > 0; len--) {
    let keyShortURL = localStorage.key(len - 1)
    let valueLongURL = localStorage.getItem(keyShortURL)

    // 如果长链接为空，加载所有的localStorage
    // 如果长链接不为空，加载匹配的localStorage
    if (longUrl == "" || (longUrl == valueLongURL)) {
      addUrlToList(keyShortURL, valueLongURL)
    }
  }
}

function addUrlToList(shortUrl, longUrl) {
  let urlList = document.querySelector("#urlList")
  let child = document.createElement('div')
  let text = document.createTextNode(window.location.host + shortUrl + " " + longUrl)
  child.appendChild(text)
  child.classList.add("list-group-item", "input-group", "mb-3")
  urlList.append(child)
}

function clearLocalStorage() {
  localStorage.clear()
}

$(function () {
  $('[data-toggle="popover"]').popover()
})

loadUrlList()