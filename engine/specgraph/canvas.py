"""画布：把契约模型渲染成一张可下钻的图。

画布只是视图——它读 `spec.md` / `graph.toml`，自己不存任何真相，也不提供
「按调用链布局」「按时序排列」这类会暗示别的语义的操作。连线永远从某条
需求项出发，落到某条提供项上。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .checks import Report
from .model import Project, SEC_CONSTRAINTS, SEC_EXPOSES, SEC_NEEDS, type_family, type_label


def _item_dict(item) -> dict:
    return {
        "id": item.id,
        "title": item.title,
        "fields": dict(item.fields),
        "body": item.body.strip(),
    }


def snapshot(project: Project, rep: Report) -> dict:
    """把模型整理成画布需要的纯数据（可 JSON 序列化）。"""
    issues_by_node: dict[str, list[dict]] = {}
    for i in rep.issues:
        issues_by_node.setdefault(i.node or "", []).append({
            "level": i.level, "code": i.code, "message": i.message,
            "fix": i.fix, "section": i.section, "item": i.item,
            "file": _rel(project, i.file), "line": i.line,
        })

    nodes: list[dict] = []
    root_is_module = "." in project.specs
    for rel, spec in sorted(project.specs.items()):
        if rel == ".":
            parent = ""
        elif "/" in rel:
            parent = rel.rsplit("/", 1)[0]
        else:
            parent = "." if root_is_module else ""
        nodes.append({
            "id": rel,
            "name": spec.name or (project.root.name if rel == "." else rel.rsplit("/", 1)[-1]),
            "kind": spec.kind,
            "class": spec.class_name,
            "type": spec.node_type,
            "type_label": type_label(spec.node_type) if spec.node_type else "",
            "type_family": type_family(spec.node_type) if spec.node_type else "",
            "parent": parent,
            "external": False,
            "spec": str((project.root / rel / "spec.md") if rel != "." else project.root / "spec.md"),
            "exposes": [_item_dict(x) for x in spec.exposes()],
            "needs": [_item_dict(x) for x in spec.needs()],
            "constraints": [_item_dict(x) for x in spec.constraints()],
            "mapping": [
                {"parent": m.parent_item, "child": m.child_rel, "child_item": m.child_item,
                 "child_abs": (m.child_rel if rel in ("", ".") else f"{rel}/{m.child_rel}") if m.child_rel else ""}
                for m in spec.mapping
            ],
            "issues": issues_by_node.pop(rel, []),
        })

    ext_specs: dict[str, str] = {}
    for r in getattr(project, "refs", []):
        ext_specs[r.target] = str((project.root / r.target).resolve() / "spec.md")

    for rel, spec in sorted(project.externals.items()):
        nodes.append({
            "id": rel,
            "name": spec.name or rel.rsplit("/", 1)[-1],
            "kind": spec.kind,
            "class": spec.class_name,
            "type": spec.node_type,
            "type_label": type_label(spec.node_type) if spec.node_type else "",
            "type_family": type_family(spec.node_type) if spec.node_type else "",
            "parent": "",
            "external": True,
            "spec": ext_specs.get(rel, ""),
            "exposes": [_item_dict(x) for x in spec.exposes()],
            "needs": [_item_dict(x) for x in spec.needs()],
            "constraints": [_item_dict(x) for x in spec.constraints()],
            "mapping": [],
            "issues": [],
        })

    links = [
        {
            "from": l.src, "to": l.dst,
            "satisfies": [{"need": s.need, "expose": s.expose} for s in l.satisfies],
        }
        for l in project.links
    ]

    return {
        "root": project.root.name,
        "root_path": str(project.root),
        "generated_at": datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M"),
        "stats": dict(rep.stats),
        "ok": rep.ok,
        "nodes": nodes,
        "links": links,
        "issues": [
            {
                "level": i.level, "code": i.code, "message": i.message, "fix": i.fix,
                "node": i.node, "section": i.section, "item": i.item,
                "file": _rel(project, i.file), "line": i.line,
            }
            for i in rep.issues
        ],
        "orphan_issues": issues_by_node.get("", []),
    }


def _rel(project: Project, path: str) -> str:
    if not path:
        return ""
    try:
        return str(Path(path).resolve().relative_to(project.root.resolve())).replace("\\", "/")
    except ValueError:
        return path


def render_html(data: dict) -> str:
    blob = json.dumps(data, ensure_ascii=False, indent=1).replace("<", "\\u003c")
    return TEMPLATE.replace("{{DATA}}", blob).replace("{{ROOT}}", data["root"])


def write(project: Project, rep: Report, outdir: Path) -> Path:
    outdir.mkdir(parents=True, exist_ok=True)
    path = outdir / "index.html"
    path.write_text(render_html(snapshot(project, rep)), encoding="utf-8")
    return path


TEMPLATE = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>规格图谱 · {{ROOT}}</title>
<style>
  :root{
    --bg:#f5f6f8; --card:#fff; --ink:#1f2937; --muted:#6b7280;
    --line:#cbd5e1; --expose:#2563eb; --need:#b45309; --warn:#b45309; --err:#dc2626;
    --ok:#059669; --tab:#e8edf5;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{
    background:var(--bg); color:var(--ink); font:14px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;
    display:flex; flex-direction:column;
  }
  header{
    display:flex; align-items:center; gap:18px; padding:12px 20px; background:#fff;
    border-bottom:1px solid #e5e7eb; position:sticky; top:0; z-index:20;
  }
  header h1{font-size:15px; margin:0; font-weight:600; letter-spacing:.3px}
  header h1 small{color:var(--muted); font-weight:400; margin-left:8px}
  .crumb{display:flex; align-items:center; gap:6px; flex:1; flex-wrap:wrap}
  .crumb button{
    border:0; background:transparent; color:var(--expose); cursor:pointer; font:inherit; padding:2px 4px;
    border-radius:4px;
  }
  .crumb button:hover{background:#eef2ff}
  .crumb .sep{color:#cbd5e1}
  .stats{color:var(--muted); font-size:12.5px; white-space:nowrap}
  .stats b{color:var(--ink); font-weight:600}
  .hint{margin-left:auto; color:var(--muted); font-size:12.5px; white-space:nowrap}

  #banner{padding:0 20px}
  #banner .box{
    margin:12px 0 0; padding:10px 14px; border-radius:8px; font-size:13px;
    background:#fef2f2; color:#991b1b; border:1px solid #fecaca;
  }
  #banner .box.ok{background:#ecfdf5; color:#065f46; border-color:#a7f3d0}

  main{flex:1; display:flex; min-height:0}
  #stage{position:relative; flex:1; overflow:auto; padding:28px 24px 60px}
  #nodes{
    position:relative; z-index:2; display:grid; gap:28px;
    grid-template-columns:repeat(auto-fill, minmax(320px, 320px));
    justify-content:center; align-content:start; min-height:100%;
  }
  #edges{position:absolute; inset:0; z-index:1; pointer-events:none; overflow:visible}
  #edges path.hit{pointer-events:stroke}

  .card{
    background:var(--card); border:1px solid #e5e7eb; border-radius:10px;
    box-shadow:0 1px 2px rgba(16,24,40,.06), 0 8px 20px -16px rgba(16,24,40,.4);
    position:relative; padding-top:12px; cursor:default; transition:box-shadow .15s, transform .15s;
  }
  .card::before{ /* 文件夹标签 */
    content:""; position:absolute; left:14px; top:-1px; width:76px; height:12px;
    background:var(--tab); border:1px solid #e5e7eb; border-bottom:0;
    border-radius:8px 8px 0 0;
  }
  .card:hover{box-shadow:0 2px 4px rgba(16,24,40,.08), 0 16px 32px -20px rgba(16,24,40,.5)}
  .card.sel{outline:2px solid #93c5fd; outline-offset:2px}
  .card .head{display:flex; align-items:baseline; gap:8px; padding:6px 14px 10px; border-bottom:1px dashed #eef1f5}
  .card .name{font-weight:600; font-size:14.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  .kind{font-size:11px; padding:1px 6px; border-radius:99px; background:#eef2ff; color:#3730a3; white-space:nowrap}
  .kind.cls{background:#f5f3ff; color:#6d28d9}
  .kind.ext{background:#f1f5f9; color:#475569}
  .card .body{display:grid; grid-template-columns:1fr 1fr; gap:0}
  .card .col{padding:10px 12px 12px; min-width:0}
  .card .col + .col{border-left:1px solid #f1f5f9}
  .col h4{margin:0 0 6px; font-size:11px; letter-spacing:.8px; text-transform:uppercase; color:var(--muted); font-weight:600}
  .col.ex h4{color:var(--expose)} .col.nd h4{color:var(--need)}
  .item{
    display:flex; gap:6px; align-items:flex-start; padding:3px 6px; margin:0 -6px;
    border-radius:6px; cursor:pointer; font-size:12.5px; line-height:1.45;
  }
  .item:hover{background:#f8fafc}
  .item .id{font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--muted); padding-top:1px}
  .item .t{flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  .item.miss .t{color:#b91c1c}
  .item.miss::after{content:"缺口"; font-size:10px; color:#b91c1c; border:1px solid #fecaca; border-radius:4px; padding:0 3px}
  .item.flash{background:#eff6ff}
  .empty{color:#9ca3af; font-size:12.5px; padding:2px 0}
  .foot{display:flex; gap:10px; align-items:center; padding:6px 14px 8px; border-top:1px solid #f8fafc; color:var(--muted); font-size:11.5px}
  .foot .dot{width:6px; height:6px; border-radius:99px; background:var(--ok); display:inline-block}
  .foot .dot.bad{background:var(--err)}
  .foot .drill{margin-left:auto; color:var(--expose); opacity:.85}
  .foot .doc{color:var(--expose); text-decoration:none; border-bottom:1px dotted #93c5fd}
  .foot .doc:hover{color:#1d4ed8}
  .card.external{opacity:.85; border-style:dashed}
  .card.external::before{background:#f8fafc}

  aside{
    width:360px; border-left:1px solid #e5e7eb; background:#fff; overflow:auto; padding:18px 20px 40px;
  }
  aside h3{margin:0 0 4px; font-size:15px}
  aside .sub{color:var(--muted); font-size:12px; margin-bottom:14px}
  aside h4{margin:18px 0 6px; font-size:12px; letter-spacing:.6px; text-transform:uppercase; color:var(--muted)}
  aside .row{border-top:1px solid #f1f5f9; padding:8px 0}
  aside .row .k{font-weight:600; font-size:13px}
  aside .row .v{color:#374151; font-size:12.5px; white-space:pre-wrap}
  aside .iss{border-left:3px solid var(--err); padding:4px 0 4px 10px; margin:8px 0; font-size:12.5px}
  aside .iss.warn{border-color:var(--warn)}
  aside .code{font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--muted)}
  aside .fix{color:#4b5563; margin-top:3px}
  .tool{
    border:1px solid #dbe2ea; background:#fff; color:#334155; font:inherit; font-size:12.5px;
    padding:4px 10px; border-radius:7px; cursor:pointer; white-space:nowrap;
  }
  .tool:hover{background:#f8fafc; border-color:#c7d2e0}
  .tool.on{background:#eef2ff; border-color:#c7d2fe; color:#3730a3}
  .tool b{font-variant-numeric:tabular-nums}
  .tool .bad{color:var(--err)}

  #isspanel{
    position:fixed; top:0; right:0; bottom:0; width:430px; background:#fff; z-index:40;
    border-left:1px solid #e5e7eb; box-shadow:-18px 0 40px -30px rgba(16,24,40,.6);
    display:none; flex-direction:column;
  }
  #isspanel.open{display:flex}
  #isspanel .ph{display:flex; align-items:center; gap:10px; padding:14px 18px; border-bottom:1px solid #eef1f5}
  #isspanel .ph h3{margin:0; font-size:14px}
  #isspanel .ph .x{margin-left:auto; border:0; background:transparent; font-size:18px; cursor:pointer; color:#94a3b8}
  #isspanel .pl{overflow:auto; padding:8px 14px 40px}
  #isspanel .grp{margin:12px 0 4px; font-size:11.5px; letter-spacing:.6px; color:var(--muted); text-transform:uppercase}
  #isspanel .one{
    border-left:3px solid var(--err); background:#fff; padding:6px 10px; margin:6px 0; cursor:pointer;
    border-radius:0 6px 6px 0; font-size:12.5px;
  }
  #isspanel .one:hover{background:#f8fafc}
  #isspanel .one.warn{border-color:var(--warn)}
  #isspanel .one .code{font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--muted)}
  #isspanel .one .fix{color:#4b5563; margin-top:2px}
  #isspanel .one .at{color:#94a3b8; font-size:11px; margin-top:2px}
  .card.dim{opacity:.42}

  .edge{fill:none; stroke:#94a3b8; stroke-width:1.6}
  .edge.hot{stroke:#2563eb; stroke-width:2.4}
  .edge.hit{stroke:transparent; stroke-width:14; cursor:pointer}
  .dot-e{fill:#fff; stroke:#94a3b8; stroke-width:1.4}
  .dot-e.hot{stroke:#2563eb}
</style>
</head>
<body>
<header>
  <h1>规格图谱<small id="rootname"></small></h1>
  <div class="crumb" id="crumb"></div>
  <div class="stats" id="stats"></div>
  <button class="tool" id="btn-gaps" title="只留下有问题的节点">只看缺口</button>
  <button class="tool" id="btn-iss" title="列出全部校验问题">问题 <b id="isscount">0</b></button>
  <div class="hint">双击文件夹进入下一层 · 点条目看详情</div>
</header>
<div id="banner"></div>
<main>
  <div id="stage">
    <svg id="edges" xmlns="http://www.w3.org/2000/svg"></svg>
    <div id="nodes"></div>
  </div>
  <aside><div id="side"></div></aside>
</main>
<div id="isspanel">
  <div class="ph"><h3>全部问题</h3><button class="x" id="iss-close" title="关闭">×</button></div>
  <div class="pl" id="islist"></div>
</div>

<script id="data" type="application/json">{{DATA}}</script>
<script>
"use strict";
const DATA = JSON.parse(document.getElementById("data").textContent);
const NODE = new Map(DATA.nodes.map(n => [n.id, n]));
const stage = document.getElementById("stage");
const nodesBox = document.getElementById("nodes");
const svg = document.getElementById("edges");
const side = document.getElementById("side");
let trail = [""];          // 面包屑："" 是虚拟顶层
let selected = null;
let onlyGaps = false;      // 只看缺口：把没问题的卡片压暗，不删（删了连线就断了）

const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fileUrl = p => "file:///" + String(p).replace(/\\/g, "/");
const kidsOf = id => DATA.nodes.filter(n => n.parent === id);

function issuesOf(id){
  return (DATA.issues || []).filter(i => i.node === id);
}
function hasProblem(n){
  return issuesOf(n.id).length > 0 || unmet(n).size > 0;
}
function pathOf(id){
  const chain = [];
  let cur = id;
  while (cur){
    chain.unshift(cur);
    const node = NODE.get(cur);
    cur = node ? (node.parent || "") : "";
  }
  chain.unshift("");
  return chain;
}
function jumpTo(nodeId, focus){
  if (!NODE.get(nodeId)) return;
  trail = pathOf(nodeId);
  selected = nodeId;
  render();
  if (focus){
    renderSide(NODE.get(nodeId), focus);
    const row = nodesBox.querySelector('.item[data-node="' + CSS.escape(nodeId) + '"][data-kind="' +
      focus.kind + '"][data-item="' + CSS.escape(focus.item) + '"]');
    if (row){ row.classList.add("flash"); row.scrollIntoView({block: "center", behavior: "smooth"}); }
  }
}
function unmet(n){
  const s = new Set();
  (DATA.issues || []).forEach(i => { if (i.node === n.id && i.code === "NEED_UNSATISFIED" && i.item) s.add(i.item); });
  return s;
}
function pageTitle(){ return trail[trail.length - 1]; }

function renderBanner(){
  const box = document.getElementById("banner");
  const errs = (DATA.issues || []).filter(i => i.level === "error").length;
  const warns = (DATA.issues || []).filter(i => i.level === "warning").length;
  if (DATA.ok){
    box.innerHTML = '<div class="box ok">✓ 这张图通过校验。画布只是视图，真相在 spec.md 与 graph.toml。</div>';
  } else {
    box.innerHTML = '<div class="box">✗ 这张图有 ' + errs + ' 个错误、' + warns + ' 个提醒。' +
      '画布不会替你修，请先改契约；下面标「缺口」的是没被满足的需求项。</div>';
  }
}

function renderCrumb(){
  const box = document.getElementById("crumb");
  box.innerHTML = "";
  trail.forEach((id, i) => {
    if (i) { const s = document.createElement("span"); s.className = "sep"; s.textContent = "›"; box.appendChild(s); }
    const b = document.createElement("button");
    b.textContent = id === "" ? DATA.root : (NODE.get(id) ? NODE.get(id).name : id);
    b.onclick = () => { trail = trail.slice(0, i + 1); selected = null; render(); };
    box.appendChild(b);
  });
}

function renderStats(){
  const s = DATA.stats || {};
  document.getElementById("rootname").textContent = "· " + DATA.root;
  document.getElementById("stats").innerHTML =
    '<b>' + (s.modules ?? 0) + '</b> 模块 · <b>' + (s.exposes ?? 0) + '</b> 提供 · <b>' +
    (s.needs ?? 0) + '</b> 需求 · <b>' + (s.links ?? 0) + '</b> 连线';
}

function itemRow(node, kind, it){
  const owned = kind === "need" && unmet(node).has(it.id);
  return '<div class="item' + (owned ? " miss" : "") + '" data-node="' + esc(node.id) +
    '" data-kind="' + kind + '" data-item="' + esc(it.id) + '">' +
    '<span class="id">' + esc(it.id) + '</span><span class="t" title="' + esc(it.title) + '">' +
    esc(it.title) + '</span></div>';
}

function renderNodes(){
  const list = kidsOf(pageTitle());
  nodesBox.innerHTML = "";
  if (!list.length){
    nodesBox.innerHTML = '<div class="empty" style="grid-column:1/-1;text-align:center;padding:60px 0">' +
      '这一层没有节点。双击上方路径返回，或在文件夹里新建 spec.md。</div>';
    return;
  }
  list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "zh") : a.kind === "class" ? 1 : -1));
  for (const n of list){
    const card = document.createElement("div");
    card.className = "card" + (n.external ? " external" : "") + (selected === n.id ? " sel" : "") +
      (onlyGaps && !hasProblem(n) ? " dim" : "");
    card.dataset.node = n.id;
    const ex = n.exposes.length
      ? n.exposes.map(it => itemRow(n, "expose", it)).join("")
      : '<div class="empty">（无）</div>';
    const nd = n.needs.length
      ? n.needs.map(it => itemRow(n, "need", it)).join("")
      : '<div class="empty">（无）</div>';
    const kids = n.external ? 0 : kidsOf(n.id).length;
    const kindLabel = n.kind === "class" ? "类级" : (n.external ? "外部引用" : "模块");
    card.innerHTML =
      '<div class="head"><span class="name" title="' + esc(n.id) + '">' + esc(n.name) + '</span>' +
      '<span class="kind' + (n.kind === "class" ? " cls" : n.external ? " ext" : "") + '">' +
      esc(kindLabel) + (n.class ? " · " + esc(n.class) : "") + '</span></div>' +
      '<div class="body">' +
        '<div class="col ex"><h4>提供</h4>' + ex + '</div>' +
        '<div class="col nd"><h4>需要</h4>' + nd + '</div>' +
      '</div>' +
      '<div class="foot"><span class="dot' + (issuesOf(n.id).some(i => i.level === "error") ? " bad" : "") +
        '"></span><span>' + n.constraints.length + ' 条约束</span>' +
        (n.spec ? '<a class="doc" href="' + esc(fileUrl(n.spec)) + '" target="_blank" rel="noreferrer"' +
          ' onclick="event.stopPropagation()" title="' + esc(n.spec) + '">契约 spec.md ↗</a>' : '') +
        (kids ? '<span class="drill">双击展开 ' + kids + ' 个子节点 ↳</span>' : '') + '</div>';

    card.addEventListener("click", e => {
      const row = e.target.closest(".item");
      selected = n.id;
      document.querySelectorAll(".card.sel").forEach(c => c.classList.remove("sel"));
      card.classList.add("sel");
      renderSide(n, row ? {kind: row.dataset.kind, item: row.dataset.item} : null);
    });
    card.addEventListener("dblclick", () => {
      if (n.external || !kidsOf(n.id).length) return;
      trail.push(n.id); selected = null; render();
    });
    nodesBox.appendChild(card);
  }
}

function sideItem(node, kind, id){
  const arr = kind === "need" ? node.needs : node.exposes;
  return arr.find(x => x.id === id) || null;
}

function partnersOf(node, kind, id){
  const out = [];
  for (const l of DATA.links){
    for (const s of l.satisfies || []){
      if (kind === "need" && l.from === node.id && s.need === id) out.push({dir: "out", link: l, expose: s.expose});
      if (kind === "expose" && l.to === node.id && s.expose === id) out.push({dir: "in", link: l, need: s.need});
    }
  }
  return out;
}

function renderSide(node, focus){
  selected = node ? node.id : null;
  if (!node){ side.innerHTML = '<div class="empty" style="margin-top:30px">点左边的节点看它的完整契约。</div>'; return; }
  const parts = ['<h3>' + esc(node.name) + '</h3>',
    '<div class="sub">' + esc(node.id) + (node.kind === "class" ? " · 类级节点" : "") + (node.external ? " · 外部引用" : "") + '</div>',
    (node.spec ? '<div class="sub" style="margin-top:-8px"><a href="' + esc(fileUrl(node.spec)) +
      '" target="_blank" rel="noreferrer" style="color:#2563eb">打开契约原文 ↗</a>' +
      '<div class="code" style="margin-top:2px">' + esc(node.spec) + '</div></div>' : '')];

  const renderList = (title, arr, kind) => {
    parts.push('<h4>' + title + '</h4>');
    if (!arr.length) { parts.push('<div class="empty">（无）</div>'); return; }
    for (const it of arr){
      const isFocus = focus && focus.kind === kind && focus.item === it.id;
      parts.push('<div class="row"' + (isFocus ? ' style="background:#f8fafc"' : '') + '>' +
        '<div class="k">' + esc(it.id) + ' ' + esc(it.title) + '</div>');
      for (const [k, v] of Object.entries(it.fields || {})) {
        parts.push('<div class="v"><span class="code">' + esc(k) + '</span> ' + esc(v) + '</div>');
      }
      if (it.body) parts.push('<div class="v">' + esc(it.body) + '</div>');
      const ps = partnersOf(node, kind, it.id);
      for (const p of ps){
        const other = p.dir === "out"
          ? (NODE.get(p.link.to) ? NODE.get(p.link.to).name : p.link.to) + " 的 " + p.expose
          : (NODE.get(p.link.from) ? NODE.get(p.link.from).name : p.link.from) + " 的 " + p.need;
        parts.push('<div class="v" style="color:#4b5563">' + (p.dir === "out" ? "由 " : "被 ") + esc(other) +
          (p.dir === "out" ? " 满足" : " 使用") + '</div>');
      }
      if (kind === "need" && !ps.length) parts.push('<div class="v" style="color:#b91c1c">没有任何提供方 —— 图不合法</div>');
      parts.push('</div>');
    }
  };

  renderList("提供", node.exposes, "expose");
  renderList("需要", node.needs, "need");
  renderList("约束", node.constraints, "constraint");

  if (node.mapping && node.mapping.length){
    parts.push('<h4>内部承接</h4>');
    for (const m of node.mapping){
      parts.push('<div class="row"><div class="k">' + esc(m.parent) + ' → ' +
        (m.child ? esc(m.child) + "：" + esc(m.child_item) : "自实现") + '</div></div>');
    }
  }

  const iss = issuesOf(node.id);
  if (iss.length){
    parts.push('<h4>这个节点的问题</h4>');
    for (const i of iss){
      parts.push('<div class="iss' + (i.level === "warning" ? " warn" : "") + '">' +
        '<div class="code">' + esc(i.code) + (i.item ? " · " + esc(i.item) : "") + '</div>' +
        '<div>' + esc(i.message) + '</div>' +
        '<div class="fix">↳ ' + esc(i.fix) + '</div></div>');
    }
  }
  side.innerHTML = parts.join("");
}

function drawEdges(){
  const ids = new Set(kidsOf(pageTitle()).map(n => n.id));
  const base = stage.getBoundingClientRect();
  const ox = stage.scrollLeft, oy = stage.scrollTop;
  const w = Math.max(stage.scrollWidth, stage.clientWidth);
  const h = Math.max(stage.scrollHeight, stage.clientHeight);
  svg.setAttribute("width", w); svg.setAttribute("height", h);
  svg.setAttribute("viewBox", "0 0 " + w + " " + h);
  svg.innerHTML = "";

  const anchor = (id, kind, item, side) => {
    const el = nodesBox.querySelector('.item[data-node="' + CSS.escape(id) + '"][data-kind="' + kind +
      '"][data-item="' + CSS.escape(item) + '"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {x: (side === "right" ? r.right : r.left) - base.left + ox,
            y: r.top + r.height / 2 - base.top + oy};
  };

  for (const l of DATA.links){
    for (const s of l.satisfies || []){
      const a = anchor(l.from, "need", s.need, "right");
      const b = anchor(l.to, "expose", s.expose, "left");
      if (!a || !b) continue;
      const dx = Math.max(28, Math.abs(b.x - a.x) * 0.4);
      const d = "M " + a.x + " " + a.y + " C " + (a.x + dx) + " " + a.y + ", " +
                (b.x - dx) + " " + b.y + ", " + b.x + " " + b.y;
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.dataset.from = l.from; g.dataset.to = l.to;
      g.dataset.need = s.need; g.dataset.expose = s.expose;
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hit.setAttribute("d", d); hit.setAttribute("class", "edge hit");
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", d); p.setAttribute("class", "edge");
      const c1 = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c1.setAttribute("cx", a.x); c1.setAttribute("cy", a.y); c1.setAttribute("r", 2.6); c1.setAttribute("class", "dot-e");
      const c2 = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c2.setAttribute("cx", b.x); c2.setAttribute("cy", b.y); c2.setAttribute("r", 2.6); c2.setAttribute("class", "dot-e");
      g.append(hit, p, c1, c2);
      hit.addEventListener("click", ev => {
        ev.stopPropagation();
        const from = NODE.get(l.from), to = NODE.get(l.to);
        if (from){ selected = from.id; renderSide(from, {kind: "need", item: s.need}); }
        document.querySelectorAll(".edge").forEach(e => e.classList.remove("hot"));
        p.classList.add("hot");
      });
      svg.appendChild(g);
    }
  }
}

const SEC_KIND = { "提供": "expose", "需要": "need", "约束": "constraint" };

function renderIssuePanel(){
  const box = document.getElementById("islist");
  const all = DATA.issues || [];
  const errs = all.filter(i => i.level === "error").length;
  const cnt = document.getElementById("isscount");
  cnt.textContent = String(all.length);
  cnt.className = errs ? "bad" : "";
  document.getElementById("btn-iss").classList.toggle("on", document.getElementById("isspanel").classList.contains("open"));

  if (!all.length){
    box.innerHTML = '<div class="empty" style="margin-top:20px">没有校验问题。</div>';
    return;
  }
  const html = [];
  const groups = new Map();
  for (const i of all){
    const key = i.node || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  for (const [nodeId, items] of groups){
    const node = NODE.get(nodeId);
    html.push('<div class="grp">' + (node ? esc(node.name) + ' · ' + esc(nodeId) : "图级（不属于某个节点）") + '</div>');
    for (const i of items){
      const kind = SEC_KIND[i.section] || null;
      html.push('<div class="one' + (i.level === "warning" ? " warn" : "") + '" data-node="' + esc(nodeId) +
        '" data-kind="' + (kind || "") + '" data-item="' + esc(i.item || "") + '">' +
        '<div class="code">' + esc(i.level === "warning" ? "⚠ " : "✗ ") + esc(i.code) +
        (i.item ? " · " + esc(i.item) : "") + '</div>' +
        '<div>' + esc(i.message) + '</div>' +
        '<div class="fix">↳ ' + esc(i.fix) + '</div>' +
        (i.file ? '<div class="at">@ ' + esc(i.file) + (i.line ? ":" + i.line : "") + '</div>' : '') +
        '</div>');
    }
  }
  box.innerHTML = html.join("");
  box.querySelectorAll(".one").forEach(el => {
    el.addEventListener("click", () => {
      const nid = el.dataset.node, kind = el.dataset.kind, item = el.dataset.item;
      document.getElementById("isspanel").classList.remove("open");
      renderIssuePanel();
      if (!nid){ trail = [""]; selected = null; render(); return; }
      jumpTo(nid, kind && item ? {kind, item} : null);
    });
  });
}

function wireTools(){
  const btnGaps = document.getElementById("btn-gaps");
  btnGaps.classList.toggle("on", onlyGaps);
  btnGaps.addEventListener("click", () => {
    onlyGaps = !onlyGaps;
    btnGaps.classList.toggle("on", onlyGaps);
    render();
  });
  const panel = document.getElementById("isspanel");
  document.getElementById("btn-iss").addEventListener("click", () => {
    panel.classList.toggle("open"); renderIssuePanel();
  });
  document.getElementById("iss-close").addEventListener("click", () => {
    panel.classList.remove("open"); renderIssuePanel();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape"){ panel.classList.remove("open"); renderIssuePanel(); }
  });
}

let raf = 0;
function scheduleEdges(){ cancelAnimationFrame(raf); raf = requestAnimationFrame(drawEdges); }

function render(){
  renderCrumb(); renderStats(); renderBanner(); renderNodes();
  renderSide(selected ? NODE.get(selected) : null);
  scheduleEdges();
}

window.addEventListener("resize", scheduleEdges);
stage.addEventListener("scroll", () => { /* 边跟着滚动走，位置基于舞台坐标，无需重画 */ });
new ResizeObserver(scheduleEdges).observe(nodesBox);
wireTools();
renderIssuePanel();
render();
</script>
</body>
</html>
"""