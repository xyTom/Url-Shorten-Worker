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

    if (res.status == "200") {
      keyShortURL=window.location.host + res.key;
      valueLongURL=document.querySelector("#longURL").value;
      // save to localStrorage
      localStorage.setItem(keyShortURL, valueLongURL);
      // add to urlList
      urlList = document.querySelector("#urlList")
      var child = document.createEtement('li')
      var text = document.createTextNode(keyShortURL + " " + valueLongURL)
      child.appendChild(text)
      urlPair.append(child)
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
$(function () {
  $('[data-toggle="popover"]').popover()
})

