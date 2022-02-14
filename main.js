let res
function shorturl() {
  if (document.querySelector("#text").value == "") {
    alert("Url cannot be empty!")
    return
  }

  document.getElementById("searchbtn").disabled = true;
  document.getElementById("searchbtn").innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>Please wait...';
  fetch(window.location.pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: document.querySelector("#text").value })
  }).then(function (response) {
    return response.json();
  })
    .then(function (myJson) {
      res = myJson;
      document.getElementById("searchbtn").disabled = false;
      document.getElementById("searchbtn").innerHTML = ' Shorten it';
      if (res.key !== "")
        document.getElementById("result").innerHTML = window.location.host + res.key;
      $('#exampleModal').modal('show')
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
    navigator.clipboard.writeText("https://" + target.innerText);
    console.log('Page URL copied to clipboard');
  } catch (err) {
    console.error('Failed to copy: ', err);
  }

  if (attr) {
    // remove temp target
    target.parentElement.removeChild(target);
  }
}
$(function () {
  $('[data-toggle="popover"]').popover()
})
console.log("https://github.com/xyTom/Url-Shorten-Worker/")
let notice = "Notice: This service is for demonstration purposes only and the generated short links will automatically expire after 24 hours."
if (window.location.host == "5it.me") {
  document.getElementById("notice").innerHTML = notice
}
