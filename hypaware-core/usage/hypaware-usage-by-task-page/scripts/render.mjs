#!/usr/bin/env node
// Render digest.json (+ optional labels.json) to a self-contained HTML page. Numbers come only from the digest.
// usage: node render.mjs --digest digest.json [--labels labels.json] --out report.html
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

// groups, themes, rows and the three questions come from the usage-by-task model, shared with its text chart
import { cmp, argv, opt, D, LAB, warn, CATS, LEGACY, MAX_THEMES, byId, NOPR, prs, fresh, addSlice, groups, assigned, ruleGroups, claimed, unclaimed, THEMED, shown, tok, esc, fmt, mc, cls, bar, prtag, prlink, sortedPrs, chip, T, prOut, ccOut, pct, f1, cut, ROWS_PER_THEME, themeRows, sections, LABEL_MAX, QS, ROW_FLOOR, THEME_MAX } from "../../hypaware-usage-by-task/scripts/model.mjs";
const OUT = opt("--out", `${D.window.to}-usage-by-task.html`);
const CW = 800, HEAD = 30, ROW = 24, GAP = 10, xLab = 12, xBar = 312, barMax = 100, xl = 480, xr = 556;
const rowsFlat = []; let cy = 8; const heads = [];
for (const sec of sections) {
  if (sec.title) { heads.push({ sec, y: cy }); cy += HEAD; }
  for (const g of sec.rows) { rowsFlat.push({ g, y: cy + ROW / 2, ind: sec.title ? xLab : 0 }); cy += ROW; }
  cy += GAP;
}
const touch = [];
for (const r of rowsFlat) {
  const seen = new Map();
  for (const s of r.g.slices) for (const x of s.prs_seen ?? []) if (prs[x.pr]) seen.set(x.pr, Math.min(seen.get(x.pr) ?? Infinity, x.minutes_after_created));
  for (const p of r.g.prs) touch.push({ r, p, opened: true });
  for (const [p, m] of seen) if (!r.g.prs.has(p)) touch.push({ r, p, opened: false, min: m });
}
// Right-hand side: one dot per repository, with line thickness for how many PRs went there; the page
// script expands a repository into its PRs on click. (The per-PR branch below only runs when no
// recorded session opened a PR, so there is nothing to roll up.)
const allTouched = new Set(touch.map((t) => t.p));
const REPO = touch.some((t) => t.opened);
const links = [], nodes = [];
if (REPO) {
  const agg = new Map();
  for (const t of touch) if (t.opened) { const k = prs[t.p].repo; const e = agg.get(k) ?? agg.set(k, new Map()).get(k); e.set(t.r, (e.get(t.r) ?? 0) + 1); }
  const uniq = new Map(); for (const t of touch) if (t.opened) (uniq.get(prs[t.p].repo) ?? uniq.set(prs[t.p].repo, new Set()).get(prs[t.p].repo)).add(t.p);
  for (const [repo, m] of agg) { const w = [...m.values()].reduce((a, b) => a + b, 0), y = [...m].reduce((a, [r, c]) => a + r.y * c, 0) / w, n = uniq.get(repo).size;
    const any = Object.values(prs).find((q) => q.repo === repo);
    nodes.push({ key: repo, y, n, url: any.url.replace(/\/pull\/\d+$/, "/pulls"), label: repo, sub: `${n} PR${n > 1 ? "s" : ""}`, tip: `${repo} · ${n} PRs opened from recorded sessions`, mine: true });
    for (const [r, c] of m) links.push({ r, key: repo, opened: true, w: Math.min(9, 1 + 1.1 * Math.sqrt(c)), tip: `${r.g.label} → ${repo}: ${c} PR${c > 1 ? "s" : ""} opened` }); }
  nodes.sort((a, b) => a.y - b.y); let prev = -Infinity; for (const n of nodes) { n.y = Math.max(n.y, prev + 30, 14); prev = n.y; }
} else {
  const owner = new Map(); for (const t of touch) if (t.opened) owner.set(t.p, Math.min(owner.get(t.p) ?? Infinity, t.r.y));
  const R = [...allTouched].sort((a, b) => (owner.get(a) ?? Infinity) - (owner.get(b) ?? Infinity) || cmp(prs[a].createdAt, prs[b].createdAt));
  const span = Math.max(cy, R.length * 22 + 16);
  R.forEach((q, i) => nodes.push({ key: q, y: 8 + (span - 16) * (i + 0.5) / R.length, url: prs[q].url, label: prtag(q), sub: cut(prs[q].title, 20), tip: `${q} · ${prs[q].title}${owner.has(q) ? "" : " · no recorded session opened it"}`, mine: owner.has(q) }));
  for (const t of touch) links.push({ r: t.r, key: t.p, opened: t.opened, w: null, tip: `${t.r.g.label} → ${t.p}: ${t.opened ? "opened in this work" : `link seen ${t.min >= 120 ? Math.round(t.min / 60) + " hours" : t.min + " minutes"} after the PR was opened`}` });
}
const ny = new Map(nodes.map((n) => [n.key, n.y]));
const CH = Math.max(cy, ...nodes.map((n) => n.y + 14));
const omax = Math.max(1, ...rowsFlat.map((r) => r.g.out));
let chart = `<svg class="chart" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Output tokens by theme and piece of work, linked to the pull requests each one touched">`;
let linkSvg = "";
for (const t of [...links].sort((a, b) => a.opened - b.opened)) {
  const y1 = t.r.y, y2 = ny.get(t.key), mx = (xl + xr) / 2, d = `M${xl + 6} ${f1(y1)} C${mx} ${f1(y1)},${mx} ${f1(y2)},${xr - 6} ${f1(y2)}`;
  linkSvg += `<g class="lk ${t.opened ? "own" : "men"}"><path class="${mc(t.r.g) === "Claude Code" ? "l1" : "l2"}"${t.w ? ` style="stroke-width:${f1(t.w)}"` : ""} d="${d}"/><path class="hit" d="${d}"><title>${esc(t.tip)}</title></path></g>`;
}
if (!REPO) chart += linkSvg;
for (const h of heads) { const t = h.sec.total; chart += `<line x1="0" x2="${xl}" y1="${f1(h.y + HEAD - 6)}" y2="${f1(h.y + HEAD - 6)}" class="grid"/><text x="0" y="${f1(h.y + 16)}" class="th">${esc(cut(t.label, THEME_MAX))}</text><text x="${xl}" y="${f1(h.y + 16)}" class="tv" text-anchor="end">${tok(t.out)} · ${pct(t.out, T.tokens.output)}%<title>${fmt(t.out)} output tokens · ${fmt(t.msgs)} responses</title></text>`; }
const linked = new Set(links.map((t) => t.r));
for (const r of rowsFlat) {
  const g = r.g, w = Math.max(2, barMax * g.out / omax), tip = `${g.label} · ${fmt(g.out)} output tokens · ${fmt(g.cr)} context read · ${fmt(g.msgs)} responses${LAB && !g.auto ? " · " + g.category : ""}`;
  chart += `<g class="rw" id="row-${rowsFlat.indexOf(r)}"><rect class="hitr" x="0" y="${f1(r.y - ROW / 2)}" width="${xl}" height="${ROW}"><title>${esc(tip)}</title></rect><a href="#ev-${rowsFlat.indexOf(r)}" class="wk" data-ev="ev-${rowsFlat.indexOf(r)}"><text x="${r.ind}" y="${f1(r.y + 4)}" class="nl">${esc(cut(g.label, r.ind ? LABEL_MAX : LABEL_MAX + 2))}</text></a>` +
    `<rect class="trk" x="${xBar}" y="${f1(r.y - 6.5)}" width="${barMax}" height="13"/><rect class="${cls(g)}" x="${xBar}" y="${f1(r.y - 6.5)}" width="${f1(w)}" height="13"/><text x="${xBar + barMax + 8}" y="${f1(r.y + 4)}" class="bv">${tok(g.out)}</text>` +
    (linked.has(r) ? `<line x1="${xBar + barMax + 44}" x2="${xl - 8}" y1="${f1(r.y)}" y2="${f1(r.y)}" class="lead"/><circle class="${cls(g)}" cx="${xl}" cy="${f1(r.y)}" r="4.5"/>` : "") + `</g>`;
}
let nodeSvg = "";
for (const n of nodes) nodeSvg += `<circle class="${n.mine ? "pr" : "pr open"}" cx="${xr}" cy="${f1(n.y)}" r="${REPO ? 5.5 : 4.5}"/><a href="${REPO ? "#" : esc(n.url)}"${REPO ? ` data-repo="${esc(n.key)}"` : ""}><text x="${xr + 12}" y="${f1(n.y + 4)}" class="nl${REPO ? " rp" : ""}">${REPO ? '<tspan class="tri">▶</tspan> ' : ""}${esc(n.label)} <tspan class="tick">${esc(n.sub)}</tspan><title>${esc(n.tip)}</title></text></a>`;
chart += REPO ? `<g id="rs">${linkSvg}${nodeSvg}</g>` : nodeSvg;
// repository mode: the data the page script needs to expand a repository into its PRs inside the chart
const RS = REPO ? { xl, xr, CH, rows: rowsFlat.map((r) => ({ y: r.y, c: mc(r.g) === "Claude Code" ? "l1" : "l2", label: r.g.label })),
  repos: nodes.map((n) => ({ key: n.key, y: n.y, n: n.n, prs: Object.keys(prs).filter((q) => prs[q].repo === n.key).map((q) => ({ tag: prtag(q), title: prs[q].title, url: prs[q].url, at: prs[q].createdAt, row: rowsFlat.findIndex((x) => x.g.prs.has(q)) }))
    .sort((a, b) => (a.row < 0 ? 1e9 : rowsFlat[a.row].y) - (b.row < 0 ? 1e9 : rowsFlat[b.row].y) || cmp(a.at, b.at)) })) } : null;
chart += "</svg>";

// facts that used to be charts of their own, now one line each
const catAgg = {}; for (const g of groups) catAgg[g.category] = (catAgg[g.category] ?? 0) + g.out;
const catLine = LAB ? Object.entries(catAgg).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${pct(v, T.tokens.output)}%`).join(", ") : "";
const dayAgg = {}; for (const s of D.slices) dayAgg[s.date] = (dayAgg[s.date] ?? 0) + s.tokens.output;
const dayLine = Object.keys(dayAgg).sort().map((d) => `${d.slice(5).replace("-", "/")} ${tok(dayAgg[d])}`).join(", ");
const modelAgg = {}; for (const s of D.slices) for (const [m, o] of Object.entries(s.models)) { const k = `${m} (${s.client})`; modelAgg[k] = (modelAgg[k] ?? 0) + o; }
const modelLine = Object.entries(modelAgg).sort((a, b) => b[1] - a[1]).map(([k, o]) => `${esc(k)} ${tok(o)}`).join(", ");

// the prompts behind each piece of work: one hidden panel per chart row, opened by clicking the row's label
const uniq = (xs) => xs.filter((x, i) => x && x !== xs[i - 1]);
const panel = (r, i) => { const g = r.g; return `<div class="ev" id="ev-${i}"><p class="ev-head"><strong>${esc(g.label)}</strong><a href="#" class="ev-close" data-ev="">close</a></p>` +
  `<p class="ev-meta">${g.prs.size ? (g.prs.size > 5 ? `${g.prs.size} PRs` : sortedPrs(g).map(prlink).join(", ")) + " · " : NOPR ? "" : "No PR · "}${tok(g.out)} output tokens · ${fmt(g.msgs)} responses${LAB && !g.auto ? " · " + g.category : ""}</p>` +
  (g.prs.size > 5 ? `<ul class="prl">${sortedPrs(g).map((q) => `<li>${prlink(q)} <span class="more">${esc(prs[q].title)}</span></li>`).join("")}</ul>` : "") +
  `<ul>${[...g.slices].sort((a, b) => b.tokens.output - a.tokens.output).slice(0, 12).map((s) => { const ps = uniq([...s.prompts, s.last_prompt]); return `<li>${ps.length ? ps.map((x) => esc(x)).join('<span class="more"> → </span>') : "(no human prompt recorded)"}<span class="meta">${esc(s.date)} · ${esc(s.client)} · ${tok(s.tokens.output)} output</span></li>`; }).join("")}${g.slices.length > 12 ? `<li class="more">and ${g.slices.length - 12} smaller sessions</li>` : ""}</ul></div>`; };
// The next step the page leads to: a HypAware recommendation. Each task gets a ready-to-paste prompt that
// already carries the scope the hypaware-query skill would otherwise ask for (period, focus, sessions),
// plus the measured facts, so the session goes straight to investigating.
const panels = rowsFlat.map(panel).join("");
const qSection = QS.length ? `<h2>Questions to ask your agent next</h2><div class="rec-list">${QS.map((q, i) => `<div class="rec"><span class="num">${i + 1}</span><button class="copy" data-copy="${esc(q)}">Copy</button><p class="q">${esc(q)}</p></div>`).join("")}</div>` : "";
// the recommendation the model wrote after reading the human messages of the largest task (labels.json "recommendation")
// labels.json "recommendation" is one object or a list of them (one per question answered)
const RECS = [LAB?.recommendation ?? []].flat().filter((r) => r && r.problem && r.fix);
const recBlock = RECS.length ? `<h2>${RECS.length > 1 ? "Recommendations" : "Recommendation"}</h2>` + RECS.map((REC) => `<div class="callout"><div class="body">${REC.task ? `<p class="eyebrow">From the messages in: ${esc(REC.task)}</p>` : ""}<p><strong>Problem:</strong> ${esc(REC.problem)}</p><p><strong>Fix:</strong> ${esc(REC.fix)}</p>${(REC.evidence ?? []).length ? `<ul>${REC.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}</div></div>`).join("") : "";
const RS_SCRIPT = String.raw`(function(){var el=document.getElementById("rsdata");if(!el)return;var D=JSON.parse(el.textContent),g=document.getElementById("rs"),svg=g.ownerSVGElement,open={};
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function cut(t,n){return t.length>n?t.slice(0,n-1)+"…":t}
function link(row,y2,w,tip){var y1=D.rows[row].y,a=D.xl+6,b=D.xr-6,m=(a+b)/2,d="M"+a+" "+y1.toFixed(1)+" C"+m+" "+y1.toFixed(1)+","+m+" "+y2.toFixed(1)+","+b+" "+y2.toFixed(1);
return '<g class="lk own"><path class="'+D.rows[row].c+'" style="stroke-width:'+w.toFixed(1)+'" d="'+d+'"/><path class="hit" d="'+d+'"><title>'+esc(tip)+'</title></path></g>'}
function draw(){var prev=10,L="",N="",x=D.xr+12;
D.repos.forEach(function(r){var k=esc(r.key);
if(!open[r.key]){var y=Math.max(r.y,prev);prev=y+30;var by={};r.prs.forEach(function(q){if(q.row>=0)by[q.row]=(by[q.row]||0)+1});
Object.keys(by).forEach(function(i){L+=link(+i,y,Math.min(9,1+1.1*Math.sqrt(by[i])),D.rows[i].label+" → "+r.key+": "+by[i]+" PR"+(by[i]>1?"s":"")+" opened")});
N+='<circle class="pr" cx="'+D.xr+'" cy="'+y.toFixed(1)+'" r="5.5"/><a href="#" data-repo="'+k+'"><text x="'+x+'" y="'+(y+4).toFixed(1)+'" class="nl rp"><tspan class="tri">▶</tspan> '+k+' <tspan class="tick">'+r.n+' PR'+(r.n>1?"s":"")+'</tspan><title>Show the pull requests in '+k+'</title></text></a>';return}
var h=24+r.prs.length*20,top=Math.max(r.y-h/2,prev),none=r.prs.filter(function(q){return q.row<0}).length;prev=top+h+22;
N+='<a href="#" data-repo="'+k+'"><text x="'+(D.xr-6)+'" y="'+(top+10).toFixed(1)+'" class="nl rp"><tspan class="tri">▼</tspan> '+k+' <tspan class="tick">'+r.prs.length+' PRs'+(none?" · "+none+" no session":"")+'</tspan><title>Collapse</title></text></a>';
r.prs.forEach(function(q,i){var y=top+30+i*20;if(q.row>=0)L+=link(q.row,y,1.75,D.rows[q.row].label+" → "+q.tag+": opened in this work");
N+='<circle class="pr'+(q.row<0?" open":"")+'" cx="'+D.xr+'" cy="'+y.toFixed(1)+'" r="4.5"/><a href="'+esc(q.url)+'"><text x="'+x+'" y="'+(y+4).toFixed(1)+'" class="nl">'+esc(q.tag)+' <tspan class="tick">'+esc(cut(q.title,Math.max(6,33-q.tag.length)))+'</tspan><title>'+esc(q.tag+" · "+q.title+(q.row<0?" · no recorded session opened it":""))+'</title></text></a>'})});
g.innerHTML=L+N;var vb=svg.getAttribute("viewBox").split(" ");vb[3]=Math.max(D.CH,prev);svg.setAttribute("viewBox",vb.join(" "))}
g.addEventListener("click",function(e){var a=e.target.closest("[data-repo]");if(!a)return;e.preventDefault();var k=a.getAttribute("data-repo"),was=open[k];open={};open[k]=!was;draw()});draw()})();`;
const COPY_SCRIPT = String.raw`document.addEventListener("click",function(e){var b=e.target.closest(".copy");if(!b)return;var t=b.getAttribute("data-copy"),was=b.textContent;
function ok(){b.textContent="Copied";b.classList.add("done");setTimeout(function(){b.textContent=was;b.classList.remove("done")},1600)}
function old(){var a=document.createElement("textarea");a.value=t;a.style.position="fixed";a.style.opacity="0";document.body.appendChild(a);a.select();try{document.execCommand("copy");ok()}catch(x){}a.remove()}
if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(ok,old);else old()});`;
const SCRIPT = `document.addEventListener("click",function(e){var a=e.target.closest("[data-ev]");if(!a)return;e.preventDefault();var id=a.getAttribute("data-ev");document.querySelectorAll(".ev.on,.rw.on").forEach(function(x){x.classList.remove("on")});var p=id&&document.getElementById(id);if(p){p.classList.add("on");var r=document.getElementById("row-"+id.slice(3));if(r)r.classList.add("on");p.scrollIntoView({block:"nearest",behavior:"smooth"})}});`;

// Styling follows the HypAware report sheet (hypaware-server src/reports/renderer/assets/style.css):
// the dashboard's palette, a masthead, ruled rows instead of tiles, square bars, ink-first colour.
// The two clients take --chart-1 and --chart-2, the pair the dashboard validated together.
const CSS = `:root{color-scheme:light dark;--fg:#1b1b20;--muted:#666;--faint:#999;--bg:#fff;--border:#e2e2e8;--border-soft:#eee;--accent-ink:#5654a4;--chart-1:#706fb1;--chart-2:#1a9e74;--code-bg:#f4f4f6;--track:color-mix(in srgb,var(--fg) 8%,var(--bg));--max:860px;
--body:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--fg:#e6e6ea;--muted:#9a9ba3;--faint:#74757d;--bg:#1f1f24;--border:#2c2c33;--border-soft:#26262b;--accent-ink:#a5a4dd;--chart-1:#8583dd;--chart-2:#22a87b;--code-bg:#19191d}}
@media print{:root{--fg:#000;--bg:#fff;--accent-ink:#000}}
*{box-sizing:border-box} html{-webkit-text-size-adjust:100%}
body{margin:0 auto;max-width:var(--max);padding:1.6rem clamp(1.1rem,4vw,2.2rem) 3rem;color:var(--fg);background:var(--bg);font:15px/1.5 var(--body);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2{line-height:1.25;font-weight:650;margin:1.7rem 0 .45rem;letter-spacing:-.005em;text-wrap:balance}
h1{font-size:1.5rem;font-weight:680;margin:0 0 .5rem;padding-bottom:.45rem;border-bottom:2px solid var(--fg)}
h2{font-size:1rem;font-weight:700;padding-bottom:.28rem;border-bottom:1px solid var(--border)}
h1+h2{border:0;margin-top:.15rem;font-size:.78rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
p,ul{margin:.55rem 0} p{text-wrap:pretty} strong,b{font-weight:640}
.lede{font-size:.98rem;margin:.6rem 0 1.15rem}
a{color:var(--accent-ink);text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 40%,transparent);text-underline-offset:2px} a:hover{text-decoration-color:currentColor}
code{background:var(--code-bg);padding:.12em .32em;border-radius:3px;font-size:.85em;font-family:var(--mono)}
.masthead{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem .9rem;padding-bottom:.5rem;margin:0 0 1.1rem;border-bottom:1px solid var(--border)}
.brand{display:inline-flex;align-items:center;gap:.45rem;font-size:.8rem;font-weight:650;letter-spacing:.01em} .brand-mark{width:15px;height:15px;flex:none;fill:var(--fg)}
.doc-label{font-size:.64rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);padding-left:.9rem;border-left:1px solid var(--border);line-height:1.6}
.metric-grid{margin:.6rem 0 1rem;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.metric{display:grid;grid-template-columns:minmax(150px,22%) 5.2rem minmax(0,1fr);column-gap:1.2rem;align-items:baseline;padding:.4rem 0 .45rem;border-bottom:1px solid var(--border-soft)} .metric:last-child{border-bottom:0}
.metric .label{font-size:.78rem;font-weight:560;margin:0;line-height:1.4} .metric .value{font-size:.95rem;font-weight:700;line-height:1.4;text-align:right;font-variant-numeric:lining-nums tabular-nums} .metric .note{margin:0;font-size:.78rem;line-height:1.45;color:var(--muted)}
.figs{margin:.6rem 0 1rem;padding:.65rem 0 .2rem;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.fig{display:grid;grid-template-columns:minmax(120px,20%) minmax(0,1fr) 4.6rem;column-gap:1rem;align-items:center;padding:.4rem 0 .55rem;border-bottom:1px solid var(--border-soft)} .fig:last-child{border-bottom:0}
.fig .label{font-size:.8rem;font-weight:560;margin:0} .fig .value{font-size:.95rem;font-weight:700;text-align:right;font-variant-numeric:lining-nums tabular-nums}
.figbar{display:flex;gap:2px;height:19px} .figbar span{min-width:3px} .ink{background:color-mix(in srgb,var(--fg) 62%,var(--bg))} .off{background:var(--track)}
.fig .note{grid-column:2/-1;display:flex;flex-wrap:wrap;gap:.2rem 1rem;margin:.3rem 0 0;font-size:.72rem;color:var(--muted)} .fig .note span{display:inline-flex;align-items:center;gap:.35rem} .fig .note i{width:9px;height:9px;display:inline-block} .fig .note b{color:var(--fg);font-weight:600}
.callout{margin:.8rem 0;padding:.45rem 0 .45rem .95rem;border-left:3px solid var(--accent-ink)} .callout .body p{margin:.45rem 0;font-size:.92rem;line-height:1.5} .callout .body ul{margin:.5rem 0 .2rem;padding-left:1.2rem} .callout .body li{font-size:.8rem;color:var(--muted);margin:.25rem 0}
.eyebrow{font-size:.68rem !important;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 .3rem !important}
.lede2{font-size:.86rem;color:var(--muted);margin:.4rem 0 .2rem}
.rec{position:relative;border-bottom:1px solid var(--border-soft);padding:.55rem 0 .6rem 1.7rem} .rec:last-child{border-bottom:0} .rec .num{position:absolute;left:.1rem;top:.57rem;font-weight:640;font-size:.88rem} .rec .num::after{content:"."}
.rec h3{margin:0 0 .1rem;font-size:.92rem;font-weight:650;line-height:1.38} .rec p{margin:0;font-size:.8rem;color:var(--muted)} .rec .copy{float:right;margin:.15rem 0 0 1rem}
.copy{font:inherit;font-size:.76rem;font-weight:600;color:var(--accent-ink);background:none;border:1px solid color-mix(in srgb,var(--accent-ink) 45%,transparent);border-radius:6px;padding:.28rem .7rem;cursor:pointer} .rec:first-child .copy{color:var(--bg);background:var(--accent-ink);border-color:var(--accent-ink)} .rec:first-child .copy.done{color:var(--muted);background:none;border-color:var(--border)} .copy:hover{background:color-mix(in srgb,var(--accent-ink) 10%,transparent)} .copy.done{color:var(--muted);border-color:var(--border)}
.ev-act{margin:.5rem 0 .2rem} pre.prompt{margin:.5rem 0 .1rem;padding:.6rem .8rem;background:var(--code-bg);border:1px solid var(--border);border-radius:3px;font:0.76rem/1.5 var(--mono);color:var(--fg);white-space:pre-wrap;overflow-wrap:anywhere}
.rec{position:relative;border-bottom:1px solid var(--border-soft);padding:.6rem 0 .65rem 1.7rem} .rec:last-child{border-bottom:0} .rec .num{position:absolute;left:.1rem;top:.62rem;font-weight:640;font-size:.92rem} .rec .num::after{content:"."}
.rec .q{margin:0;font-size:.95rem;line-height:1.5;color:var(--fg)} .rec .copy{float:right;margin:.1rem 0 .2rem 1rem}
.copy{font:inherit;font-size:.74rem;font-weight:600;color:var(--accent-ink);background:none;border:1px solid color-mix(in srgb,var(--accent-ink) 45%,transparent);border-radius:6px;padding:.22rem .65rem;cursor:pointer} .copy:hover{background:color-mix(in srgb,var(--accent-ink) 10%,transparent)} .copy.done{color:var(--muted);border-color:var(--border)}
.barchart{margin:.9rem 0;padding:.65rem 0 .6rem;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.chart-title{font-size:.68rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:0 0 .4rem}
.stack-legend{display:flex;flex-wrap:wrap;gap:.35rem 1rem;margin:0 0 .6rem;font-size:.72rem;color:var(--muted)} .stack-legend span{display:inline-flex;align-items:center;gap:.4rem} .stack-legend i{width:9px;height:9px;display:inline-block}
.chart-foot,.note{margin:.5rem 0 0;font-size:.72rem;color:var(--muted);line-height:1.45}
.sw{display:inline-block;width:9px;height:9px;margin-right:.5rem} .s1{background:var(--chart-1)} .s2{background:var(--chart-2)}
.scroll{overflow-x:auto} svg.chart{width:100%;min-width:720px;height:auto;display:block}
svg .nl{fill:var(--fg);font-size:12px;font-family:inherit} svg .tick{fill:var(--muted);font-size:11px;font-family:inherit} svg .bv{fill:var(--fg);font-size:12px;font-weight:600;font-family:inherit;font-variant-numeric:lining-nums tabular-nums}
svg .th{fill:var(--fg);font-size:13px;font-weight:650;font-family:inherit} svg .tv{fill:var(--muted);font-size:12px;font-family:inherit;font-variant-numeric:lining-nums tabular-nums} svg a .nl{fill:var(--accent-ink)} svg a:hover .nl{text-decoration:underline}
svg .grid{stroke:var(--border);stroke-width:1} svg .trk{fill:var(--track)} svg rect.s1,svg circle.s1{fill:var(--chart-1)} svg rect.s2,svg circle.s2{fill:var(--chart-2)} svg .hitr{fill:transparent} svg a.wk{cursor:pointer} svg a.wk .nl{fill:var(--fg)} svg a.wk:hover .nl{text-decoration:underline} svg .rw.on .hitr{fill:var(--track)} svg .rw.on .nl{font-weight:650}
.ev{display:none;margin:.7rem 0 .2rem;padding:.45rem 0 .45rem .95rem;border-left:3px solid color-mix(in srgb,var(--fg) 55%,var(--bg))} .ev.on,.ev:target{display:block}
.ev-head{display:flex;justify-content:space-between;gap:1rem;margin:0;font-size:.92rem} .ev-close{font-size:.72rem;font-weight:400;color:var(--muted);white-space:nowrap} .ev-meta{margin:.1rem 0 0;font-size:.78rem;color:var(--muted)}
.ev ul{margin:.45rem 0 0;padding-left:1.2rem} .ev ul.prl{columns:2;column-gap:2rem;padding-bottom:.4rem;border-bottom:1px solid var(--border-soft)} .ev ul.prl li{margin:.15rem 0;break-inside:avoid} .ev ul.prl:last-child{border-bottom:0} svg a[data-repo]{cursor:pointer} svg .tri{font-size:13px;fill:var(--fg)} svg a[data-repo] .nl{fill:var(--fg)} .ev li{margin:.4rem 0;font-size:.8rem;line-height:1.5} .ev li .meta{margin-left:0}
svg .lead{stroke:var(--border);stroke-width:1}
svg .lk path{fill:none} svg .l1{stroke:var(--chart-1)} svg .l2{stroke:var(--chart-2)} svg .own path:first-child{stroke-width:1.75;opacity:.9} svg .men path:first-child{stroke-width:1.25;stroke-dasharray:3 4;opacity:.6}
svg .hit{stroke:transparent;stroke-width:12} svg .lk:hover path:first-child{opacity:1} svg .lk:hover path:first-child:not([style]){stroke-width:3} svg .rp{font-weight:650;font-size:13px}
svg circle.pr{fill:var(--fg);stroke:var(--bg);stroke-width:2} svg circle.pr.open{fill:var(--bg);stroke:var(--faint);stroke-width:1.5}
svg.key{width:26px;height:9px} .k1{stroke:var(--muted);stroke-width:1.75} .k2{stroke:var(--muted);stroke-width:1.25;stroke-dasharray:3 4}
.rec-list{margin:.6rem 0 1rem;border-top:1px solid var(--border)}
details{border-bottom:1px solid var(--border-soft);padding:.45rem 0 .5rem} summary{cursor:pointer;font-size:.92rem;font-weight:650;line-height:1.38}
.meta{display:block;font-weight:400;color:var(--muted);font-size:.78rem;margin:.1rem 0 0 1.05rem}
details ul{margin:.5rem 0 .2rem;padding-left:1.9rem} details li{margin:.4rem 0;font-size:.8rem;line-height:1.5} details li .meta{margin-left:0} .more{color:var(--muted)}
@media (max-width:620px){.fig{grid-template-columns:minmax(0,1fr) 4.6rem} .fig .label{grid-column:1/-1} .fig .note{grid-column:1/-1}}
@media print{body{max-width:none} .fig,.barchart{break-inside:avoid}}`;

// key figures as share bars: one full-width bar per figure, split into its two parts.
// Client splits take the client colours; yes/no splits are ink on the track, so colour keeps meaning "client".
const sessBy = {}; for (const x of D.slices) (sessBy[x.client] ??= new Set()).add(x.session_id);
const ccSess = sessBy["Claude Code"]?.size ?? 0, cxSess = sessBy.Codex?.size ?? 0;
const share = (label, total, parts, note) => { const sum = Math.max(1, parts.reduce((t, x) => t + x.v, 0));
  return `<div class="fig"><p class="label">${label}</p><div class="figbar">${parts.filter((x) => x.v > 0).map((x) => `<span class="${x.c}" style="flex:${x.v} 0 0" title="${esc(x.name)}: ${esc(x.t)} (${pct(x.v, sum)}%)"></span>`).join("")}</div><div class="value">${total}</div>` +
  `<p class="note">${parts.map((x) => `<span><i class="${x.c}"></i>${esc(x.name)} <b>${esc(x.t)}</b> · ${pct(x.v, sum)}%</span>`).join("")}${note ? `<span>${note}</span>` : ""}</p></div>`; };
const figures = `<div class="figs"><p class="chart-title">Key figures, each bar split into its two parts</p>` +
  share("Output tokens", tok(T.tokens.output), [{ name: "Codex", v: T.tokens.output - ccOut, t: tok(T.tokens.output - ccOut), c: "s2" }, { name: "Claude Code", v: ccOut, t: tok(ccOut), c: "s1" }]) +
  share("Sessions", T.sessions, [{ name: "Codex", v: cxSess, t: String(cxSess), c: "s2" }, { name: "Claude Code", v: ccSess, t: String(ccSess), c: "s1" }], `${fmt(T.msgs)} model responses`) +
  (NOPR ? "" : share("Output in PR work", pct(prOut, T.tokens.output) + "%", [{ name: "In work that opened a PR", v: prOut, t: tok(prOut), c: "ink" }, { name: "No PR", v: T.tokens.output - prOut, t: tok(T.tokens.output - prOut), c: "off" }]) +
  share("PRs opened", claimed.size + unclaimed.length, [{ name: "Tied to a recorded session", v: claimed.size, t: String(claimed.size), c: "ink" }, { name: "No recorded session", v: unclaimed.length, t: String(unclaimed.length), c: "off" }])) +
  share("Prompt tokens", tok(T.tokens.cache_read + T.tokens.input), [{ name: "Read from cache", v: T.tokens.cache_read, t: tok(T.tokens.cache_read), c: "ink" }, { name: "Uncached input", v: T.tokens.input, t: tok(T.tokens.input), c: "off" }]) + `</div>`;
// the biggest named task, for the lead sentence (the fold of unlabelled sessions does not count)
const TOP = shown.find((t) => !t.auto) ?? shown[0];
const MARK = `<svg class="brand-mark" viewBox="0 0 100 100" aria-hidden="true"><path d="m75.93 39.66-21.8 12.73v25.51l21.8-12.73z"/><path d="m24.07 39.66v25.5l21.8 12.73v-25.51l-19.81-11.56z"/><path d="m50 19.72-21.85 12.75 21.85 12.75 21.85-12.75z"/><path d="m50 0.5c-0.6255 0-1.251 0.1627-1.811 0.4875l-39.57 22.94c-1.113 0.6457-1.799 1.835-1.799 3.122v45.9c2.081e-4 1.287 0.6855 2.477 1.799 3.122l39.57 22.94c1.12 0.6493 2.501 0.6493 3.621 0l39.57-22.94c1.113-0.6457 1.799-1.835 1.799-3.122v-45.9c-1.98e-4 -1.287-0.6855-2.477-1.799-3.122l-39.57-22.94c-0.5599-0.3247-1.185-0.4875-1.811-0.4875zm-0.7211 10.38a4.123 4.129 0 0 1 2.796 0.4975l30.05 17.53a4.123 4.129 0 0 1 0.979 0.8279 4.123 4.129 0 0 1 0.145 0.1611 4.123 4.129 0 0 1 0.6325 1.1 4.123 4.129 0 0 1 0.05841 0.1813 4.123 4.129 0 0 1 0.2296 1.338v35.02a4.123 4.129 0 0 1-2.047 3.57l-30.05 17.53a4.123 4.129 0 0 1-0.1048 0.03827 4.123 4.129 0 0 1-1.174 0.4331 4.123 4.129 0 0 1-0.1732 0.02409 4.123 4.129 0 0 1-1.295 0.0039 4.123 4.129 0 0 1-0.1028-0.02424 4.123 4.129 0 0 1-1.253-0.4532 4.123 4.129 0 0 1-0.03424-0.01606 4.123 4.129 0 0 1-0.01209-0.0062l-30.05-17.53a4.123 4.129 0 0 1-2.047-3.57v-35.06a4.123 4.129 0 0 1 0.08661-0.4895 4.123 4.129 0 0 1 0.1067-0.6103 4.123 4.129 0 0 1 0.419-0.9427 4.123 4.129 0 0 1 0.2719-0.4754 4.123 4.129 0 0 1 1.04-0.9427 4.123 4.129 0 0 1 0.1208-0.1088l30.05-17.53a4.123 4.129 0 0 1 1.354-0.4975z"/></svg>`;
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI usage by task${opt("--name", null) ? ": " + esc(opt("--name")) : ""}, ${D.window.from} to ${D.window.to}</title><style>${CSS}</style></head><body>
<header class="masthead"><span class="brand">${MARK}Hyperparam</span><span class="doc-label">Usage report · generated ${esc(String(D.generated_at).slice(0, 10))} from HypAware data</span></header>
<h1>AI usage by task${opt("--name", null) ? ": " + esc(opt("--name")) : ""}</h1>
<h2>${D.window.from} to ${D.window.to} · Claude Code and Codex${D.org ? " · " + esc(D.org) : D.remote ? " · remote " + esc(D.remote) : " · this machine"}</h2>
<p class="lede"><strong>${tok(T.tokens.output)} output tokens across ${T.sessions} sessions${TOP ? `, ${pct(TOP.out, T.tokens.output)}% of it on ${esc(TOP.label)}` : ""}.</strong> The chart breaks that down by task${NOPR ? "" : " and shows the pull requests each task produced"}. ${LAB ? "Labels and groupings were chosen by the assistant from a digest of each session's prompts; every number comes from the recordings." : "Rows are labelled by each session's first prompt; a session is tied to a PR when the PR link appears in it within " + esc(D.attrib_window_min) + " minutes of the PR being opened."}</p>
<div class="barchart"><p class="chart-title">Output tokens by task${NOPR ? "" : `, with the ${REPO ? "repositories its pull requests went to" : "pull requests each task produced"}`}</p>
<div class="stack-legend"><span><i class="s1"></i>Claude Code</span><span><i class="s2"></i>Codex</span>${NOPR ? "" : REPO ? `<span><svg class="key" viewBox="0 0 26 9"><line x1="0" x2="26" y1="4.5" y2="4.5" class="k1" style="stroke-width:5"/></svg>thicker line = more PRs opened in that repository</span>` : `<span><svg class="key" viewBox="0 0 26 9"><line x1="0" x2="26" y1="4.5" y2="4.5" class="k1"/></svg>opened the PR</span><span><svg class="key" viewBox="0 0 26 9"><line x1="0" x2="26" y1="4.5" y2="4.5" class="k2"/></svg>PR link appeared later (read, reviewed or followed up)</span>`}</div>
<div class="scroll">${chart}</div>
${panels}
</div>
${recBlock}
${qSection}
<h2>Key figures</h2>
${figures}
${RS ? `<script type="application/json" id="rsdata">${JSON.stringify(RS).replace(/</g, "\\u003c")}</script><script>${RS_SCRIPT}</script>` : ""}<script>${SCRIPT}</script>${QS.length ? `<script>${COPY_SCRIPT}</script>` : ""}</body></html>`;
mkdirSync(dirname(OUT) || ".", { recursive: true }); writeFileSync(OUT, page);
// stdout: a short summary the caller can relay
console.log(`wrote ${OUT}`);
if (unclaimed.length) console.log(`unclaimed PRs: ${unclaimed.join(", ")}`);
