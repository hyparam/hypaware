document.addEventListener('click', function (e) {
  var btn = e.target.closest('.copy-md');
  if (!btn) return;
  e.preventDefault();
  var getText = fetch(btn.dataset.src).then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.text();
  });
  var done = function () {
    var old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(function () { btn.textContent = old; }, 1500);
  };
  var fail = function () { location.href = btn.dataset.src; };
  // Safari revokes the click's clipboard permission across an await; handing
  // ClipboardItem a promise keeps the write inside the user gesture.
  if (navigator.clipboard && window.ClipboardItem) {
    navigator.clipboard.write([new ClipboardItem({
      'text/plain': getText.then(function (t) { return new Blob([t], { type: 'text/plain' }); })
    })]).then(done, function () {
      getText.then(function (t) { return navigator.clipboard.writeText(t); }).then(done, fail);
    });
  } else if (navigator.clipboard) {
    getText.then(function (t) { return navigator.clipboard.writeText(t); }).then(done, fail);
  } else {
    fail();
  }
});
