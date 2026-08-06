#!/usr/bin/env bash
# @ref LLP 0193#mechanics-as-code [implements]: the renderer is repo-owned code, not
# prose in a skill, so the skill can call a known-good version instead of describing one
#
# Build the HypAware report site: every top-level <slug>.md (+ optional <slug>/ section
# dir) becomes a self-contained html/<slug>/ folder. html/ is wiped and rebuilt each run.
# The top-level index.html landing page is NOT generated here: see the
# hypaware-report-to-html skill, which regenerates it from the built report set.
# LLP 0194 T4 moves that generation in here, where it is deterministic.
#
# CANONICAL COPY. This file is the source of truth; the copy in a user's reports tree
# is installed from here. It is still the shell original: LLP 0194 T3 ports it to Node
# (src/core/reports/render.js) to drop the BSD-only `sed -i ''` and `sips` calls below,
# which fail on Linux. Do not add features here that T3 would have to port twice.
set -euo pipefail
cd "$(dirname "$0")"

command -v pandoc >/dev/null 2>&1 || { echo "error: pandoc not found (brew install pandoc)" >&2; exit 1; }
[ -f assets/style.css ] || { echo "error: assets/style.css missing at repo root" >&2; exit 1; }

page_title() { # first "# " heading, else the fallback in $2
  local t
  t=$(grep -m1 '^# ' "$1" 2>/dev/null | sed 's/^# *//') || true
  printf '%s' "${t:-$2}"
}

masthead() { # $1 = nav html for the right-hand slot, $2 = doc label
  printf '<header class="masthead">\n<span class="brand"><span class="brand-mark"></span>Hyperparam</span>\n<span class="doc-label">%s</span>\n<nav class="topnav">%s</nav>\n</header>\n\n' "$2" "$1"
}

doc_label() { # $1 = slug; says the page is a generated static report, not the HypAware app
  case "$1" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-*) printf 'Internal report · generated %s from HypAware data' "${1:0:10}" ;;
    *) printf 'Internal report · generated from HypAware data' ;;
  esac
}

# Rewrite .md hrefs in a BUILT page for the flattened html/<slug>/ layout. Operating on
# the emitted HTML catches Markdown-origin links and raw-HTML component links (rec
# cards, callouts) in one uniform pass. $1 = file, $2 = slug, $3 = "index" | "section".
rewrite_hrefs() {
  local file="$1" slug="$2" kind="$3"
  if [ "$kind" = index ]; then
    # own section: <slug>/x.md -> x.html ; other report's section: o/y.md -> ../o/y.html
    # sibling one-pager: o.md -> ../o/index.html
    sed -E -i '' \
      -e "s|href=\"$slug/([^\":#]+)\.md(#[^\"]*)?\"|href=\"\1.html\2\"|g" \
      -e "s|href=\"([^\"/:#]+)/([^\"/:#]+)\.md(#[^\"]*)?\"|href=\"../\1/\2.html\3\"|g" \
      -e "s|href=\"([^\"/:#]+)\.md(#[^\"]*)?\"|href=\"../\1/index.html\2\"|g" \
      "$file"
  else
    # back to own one-pager: ../<slug>.md -> index.html ; other one-pager: ../o.md ->
    # ../o/index.html ; other report's section: ../o/y.md -> ../o/y.html ; sibling
    # section: y.md -> y.html
    sed -E -i '' \
      -e "s|href=\"\.\./$slug\.md(#[^\"]*)?\"|href=\"index.html\1\"|g" \
      -e "s|href=\"\.\./([^\"/:#]+)\.md(#[^\"]*)?\"|href=\"../\1/index.html\2\"|g" \
      -e "s|href=\"\.\./([^\"/:#]+)/([^\"/:#]+)\.md(#[^\"]*)?\"|href=\"../\1/\2.html\3\"|g" \
      -e "s|href=\"([^\"/:#]+)\.md(#[^\"]*)?\"|href=\"\1.html\2\"|g" \
      "$file"
  fi
}

# favicon <link>s + copy-button script injected into every page's <head>; regenerate if
# missing. PNG fallback matters: Safari doesn't render SVG favicons.
[ -f assets/head.html ] || printf '<link rel="icon" type="image/svg+xml" href="assets/favicon.svg">\n<link rel="icon" type="image/png" sizes="64x64" href="assets/favicon.png">\n<script defer src="assets/copy-md.js"></script>\n' > assets/head.html
[ -f assets/favicon.svg ] || { echo "error: assets/favicon.svg missing at repo root" >&2; exit 1; }
[ -f assets/favicon.png ] || sips -s format png -z 64 64 assets/favicon.svg --out assets/favicon.png >/dev/null

# "Copy … as Markdown" masthead action: copies the page's Markdown source (kept as a
# sibling .md of each built page; full.md = one-pager + all sections) to the clipboard,
# for pasting into an agent. Uses data-src, NOT href: rewrite_hrefs and the leftover-.md
# check must not see these links. Falls back to opening the raw .md where fetch or the
# clipboard is unavailable (e.g. file://).
[ -f assets/copy-md.js ] || cat > assets/copy-md.js <<'EOF'
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
EOF

rm -rf html
mkdir -p html
touch html/.nojekyll

count=0
for src in *.md; do
  [ -e "$src" ] || continue
  case "$src" in README.md) continue ;; esac
  slug="${src%.md}"
  out="html/$slug"
  mkdir -p "$out/assets"
  cp assets/style.css "$out/assets/style.css"
  cp assets/favicon.svg "$out/assets/favicon.svg"
  cp assets/favicon.png "$out/assets/favicon.png"
  cp assets/copy-md.js "$out/assets/copy-md.js"
  touch "$out/.nojekyll"

  # raw Markdown next to the built pages: index.md (this page) and full.md (one-pager +
  # every section, in file order): what the masthead copy buttons serve
  cp "$src" "$out/index.md"
  {
    cat "$src"
    if [ -d "$slug" ]; then
      for sec in "$slug"/*.md; do
        [ -e "$sec" ] || continue
        printf '\n\n---\n\n'
        cat "$sec"
      done
    fi
  } > "$out/full.md"

  {
    masthead '<a href="../../index.html">&#8592; All reports</a> <a href="#" class="copy-md" data-src="full.md">Copy report as Markdown</a>' "$(doc_label "$slug")"
    cat "$src"
  } | pandoc -f gfm -t html5 -s \
    --css assets/style.css \
    -H assets/head.html \
    --metadata pagetitle="$(page_title "$src" "$slug")" \
    -o "$out/index.html"
  rewrite_hrefs "$out/index.html" "$slug" index

  if [ -d "$slug" ]; then
    for sec in "$slug"/*.md; do
      [ -e "$sec" ] || continue
      base="$(basename "$sec" .md)"
      cp "$sec" "$out/$base.md"
      {
        masthead "<a href=\"index.html\">&#8592; Back to the report</a> <a href=\"#\" class=\"copy-md\" data-src=\"$base.md\">Copy page as Markdown</a>" "$(doc_label "$slug")"
        cat "$sec"
      } | pandoc -f gfm -t html5 -s \
        --css assets/style.css \
        -H assets/head.html \
        --metadata pagetitle="$(page_title "$sec" "$base")" \
        -o "$out/$base.html"
      rewrite_hrefs "$out/$base.html" "$slug" section
    done
  fi
  count=$((count + 1))
done

echo "Built html/ : $count report(s) into html/<slug>/ (index + sections + assets)"
