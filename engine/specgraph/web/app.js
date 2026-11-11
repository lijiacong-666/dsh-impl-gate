"use strict";

// 画布前端：所有坐标都在「世界坐标」里，缩放/平移只改变外层 transform。
// 唯一真相仍是 spec.md 与 graph.toml；这里拖出来的东西都会立刻发回后端落盘。

const $ = s => document.querySelector(s);
const stage = $("#stage");
const world = $("#world");
const cardsBox = $("#cards");
const svg = $("#edges");
const side = $("#side");

let S = null;                       // 后端快照
let POS = {};                       // id -> {x, y}（全局坐标，按项目记）
let VIEW = { zoom: 1, x: 0, y: 0 };
let VIEWS = {};                     // 每一层各记自己的视野：level -> {zoom,x,y}
let LEVEL = "";                     // 当前在谁的页面上："" = 项目页
let trail = [];                     // 面包屑：[[id, name], ...]
let selNode = null;
let selLink = null;
let onlyGaps = false;
let mode = null;                    // pan | move | link
let drag = null;                    // 当前拖拽上下文
let saveTimer = 0;
let SEL = new Set();                // 框选/多选中的节点 id
// 本地已改、还没落盘的东西。服务端快照回来时以本地为准，否则每次写操作都会把
// 你刚拖到的位置、刚滚到的视野覆盖回去（这就是「跳」的根因）。
let DIRTY = new Set();              // 位置改过的节点 id
let DIRTY_VIEWS = new Set();        // 视野改过的层级
let SIDE_LOCK = false;              // 右侧正开着编辑表单：别让重绘把它冲掉
let BUSY = false;                   // 有写请求在飞：按钮先别重复触发

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------ 后端

async function api(path, body) {
  const res = await fetch("/api/" + path, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "操作失败");
  return data;
}

function toast(text, bad) {
  const el = $("#toast");
  el.textContent = text;
  el.className = bad ? "bad" : "";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2600);
}

// ------------------------------------------------------------------ 状态

// keepView=true：这是一次「写操作的回执」，视野以我屏幕上现在的为准，不许回滚。
// 默认就保持视野：只有首次打开（boot）与切层时例外，否则增删一次就跳一次。
function applyState(next, opts = {}) {
  const keepView = opts.keepView !== false;
  S = next;
  // 位置：服务端给的是旧的，本地改过的那些以本地为准
  POS = SGLogic.mergePositions(next.pos, POS, [...DIRTY]);
  // 视野：同理，本地动过的层以本地为准
  VIEWS = SGLogic.mergeViews(next.views, VIEWS, [...DIRTY_VIEWS]);
  const firstLook = !VIEWS[LEVEL];
  if (!keepView) {
    if (VIEWS[LEVEL]) VIEW = Object.assign({ zoom: 1, x: 0, y: 0 }, VIEWS[LEVEL]);
    else if (next.view) VIEW = Object.assign({ zoom: 1, x: 0, y: 0 }, next.view);
  }
  const placed = autoPlace();
  // 回执里也把当前视野记到这一层，免得下次切层回来时「没记过」又去重新取景
  if (keepView) VIEWS[LEVEL] = Object.assign({}, VIEW);
  render();
  if (keepView) return;
  // 只有「第一次看这一层」或「记住的视野已经看不见一半以上的模块」才重新取景。
  const vis = visibleNodes();
  if (SGLogic.shouldFit({ firstLook, placed, onScreen: onScreenCount(vis), total: vis.length })) {
    focusOnViewport();
  }
}

// 新建/放进来的节点如果落在屏幕外，把它平移到能看见的地方（不改缩放）
function ensureVisible(id) {
  const p = POS[id];
  if (!p) return;
  const r = stage.getBoundingClientRect();
  const next = SGLogic.centerOn(p, VIEW, { width: r.width, height: r.height });
  if (!next) return;
  VIEW = next;
  DIRTY_VIEWS.add(LEVEL);
  render();
  scheduleSave();
}

// 这一层有多少个模块的中心点此刻落在可见区域内
function onScreenCount(vis) {
  const r = stage.getBoundingClientRect();
  return vis.filter(k => {
    const p = POS[k.id] || { x: 0, y: 0 };
    const cx = (p.x + 161) * VIEW.zoom + VIEW.x;
    const cy = (p.y + 70) * VIEW.zoom + VIEW.y;
    return cx > 0 && cx < r.width && cy > 0 && cy < r.height;
  }).length;
}

function autoPlace() {
  const fresh = {};
  for (const n of S.nodes) {
    if (POS[n.id]) continue;
    const sib = S.nodes.filter(m => (m.parent || "") === (n.parent || ""));
    const i = Math.max(0, sib.indexOf(n));
    const pp = POS[n.parent || ""] || { x: 90, y: 20 };
    POS[n.id] = { x: pp.x + (i % 3) * 372, y: pp.y + 300 + Math.floor(i / 3) * 330 };
    fresh[n.id] = POS[n.id];
  }
  if (Object.keys(fresh).length) api("move", { pos: fresh }).catch(() => {});
  return Object.keys(fresh).length;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

// 立刻把位置与视野写盘（防抖到期、关窗前都走这里）
function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
  VIEWS[LEVEL] = Object.assign({}, VIEW);
  DIRTY_VIEWS.add(LEVEL);
  return api("move", { pos: POS, view: VIEW, level: LEVEL })
    .then(() => { DIRTY.clear(); DIRTY_VIEWS.clear(); })
    .catch(e => toast(e.message, true));
}

const issuesOf = id => (S.issues || []).filter(i => i.node === id);
const nodeById = id => S.nodes.find(n => n.id === id);
const rootNode = () => S.nodes.find(n => n.id === ".");
const kidsOf = id => S.nodes.filter(n => (n.parent || "") === id);

// 项目页 = 项目根（如果有）+ 顶层模块；进到某个模块后，只摆它自己的子模块。
function visibleNodes() {
  if (LEVEL === "") {
    const hasRoot = !!rootNode();
    return S.nodes.filter(n => {
      const p = n.parent || "";
      return p === "" || (hasRoot && p === ".");
    });
  }
  return kidsOf(LEVEL);
}

// 在项目页新建时，新模块挂到项目根下面（有根的图里）
const createParent = () => LEVEL || (rootNode() ? "." : "");
const parentId = (name) => {
  const p = createParent();
  return p && p !== "." ? p + "/" + name : name;
};
function unmetOf(n) {
  const s = new Set();
  (S.issues || []).forEach(i => {
    if (i.node === n.id && i.code === "NEED_UNSATISFIED" && i.item) s.add(i.item);
  });
  return s;
}
const hasProblem = n => issuesOf(n.id).length > 0 || unmetOf(n).size > 0;

// ------------------------------------------------------------------ 渲染

function render() {
  world.style.transform = `translate(${VIEW.x}px, ${VIEW.y}px) scale(${VIEW.zoom})`;
  // 语义缩放：拉远时只留模块名与数量，拉近才露出条目，避免远处一团字
  stage.classList.toggle("zoom-far", VIEW.zoom < 0.55);
  stage.classList.toggle("zoom-mini", VIEW.zoom < 0.32);
  $("#zoom").textContent = Math.round(VIEW.zoom * 100) + "%";
  $("#projname").textContent = "· " + (S.root || "");
  const u = $("#btn-undo"), r = $("#btn-redo");
  if (u) { u.disabled = !S.can_undo; u.title = S.can_undo ? "撤销（Ctrl+Z）" : "没有可撤销的操作"; }
  if (r) { r.disabled = !S.can_redo; r.title = S.can_redo ? "重做（Ctrl+Y）" : "没有可重做的操作"; }
  const exp = $("#btn-exp");
  if (exp) {
    // 项目页也能导：没根契约时导的是「整张图」，不再灰着
    exp.disabled = false;
    exp.title = LEVEL ? "导出这个模块的指令包（先预览）" : "导出整张图的指令包（先预览）";
  }
  renderStatus();
  renderCrumb();
  renderCards();
  $("#empty-hint").classList.toggle("hidden", (S.nodes || []).length > 0);
  renderSide();
  renderIssueCount();
  renderDock();
  renderAssist();
  renderMinimap();
  requestAnimationFrame(drawEdges);
}

function renderCrumb() {
  const el = $("#crumb");
  const parts = [`<button data-lvl="">项目</button>`];
  trail.forEach(([id, name], i) => {
    parts.push("<span>/</span>");
    parts.push(`<button data-lvl="${esc(id)}">${esc(name)}</button>`);
  });
  el.innerHTML = parts.join("");
  el.querySelectorAll("button").forEach(b => b.onclick = () => {
    const lvl = b.dataset.lvl;
    if (lvl === LEVEL) return;
    if (!lvl) { trail = []; goToLevel(""); return; }
    const i = trail.findIndex(t => t[0] === lvl);
    if (i >= 0) trail = trail.slice(0, i + 1);
    goToLevel(lvl);
  });
}

function enterNode(id) {
  const n = nodeById(id);
  if (!n) return;
  if (n.kind === "class") { toast("类级节点已经是最底层，不再展开"); return; }
  trail = trail.filter(t => t[0] !== id);
  trail.push([id, n.name]);
  selNode = null; selLink = null;
  goToLevel(id);
}

// 层级写进地址栏：刷新回到同一层，也方便直接分享「某个模块的页面」
// 每层各记各的视野：回到上一层时恢复它离开时的位置，而不是重新居中（否则会「跳」）。
function goToLevel(id) {
  if (id !== LEVEL) {
    VIEWS[LEVEL] = { ...VIEW };
    DIRTY_VIEWS.add(LEVEL);
    flushSave().catch(() => {});   // 离开前把这一层的视野立刻存下，回来时才不会跳
  }
  LEVEL = id;
  history.replaceState(null, "", id ? "#/" + encodeURIComponent(id) : "#");
  if (VIEWS[id]) {
    VIEW = { ...VIEWS[id] };
    render();
  } else {
    render();
    focusOnViewport();
  }
}

function syncFromHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  const n = raw ? nodeById(raw) : null;
  if (!n) { LEVEL = ""; trail = []; return; }
  const chain = [];
  let cur = n;
  while (cur) { chain.unshift([cur.id, cur.name]); cur = cur.parent ? nodeById(cur.parent) : null; }
  LEVEL = n.id;
  trail = chain;
}

function focusOnViewport() {
  const kids = visibleNodes();
  if (!kids.length) return;
  const r = stage.getBoundingClientRect();
  const xs = kids.map(k => POS[k.id]?.x ?? 0), ys = kids.map(k => POS[k.id]?.y ?? 0);
  const w = Math.max(...xs) - Math.min(...xs) + 322 + 120;
  const h = Math.max(...ys) - Math.min(...ys) + 260 + 120;
  // 先算出「铺满这一层要多大」，再决定缩放：卡片多的时候拉开看全貌，少的时候不放大到失真
  const fit = Math.min(r.width / w, r.height / h);
  VIEW.zoom = Math.max(0.35, Math.min(1, fit));
  const cx = (Math.min(...xs) + Math.max(...xs) + 322) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys) + 260) / 2;
  VIEW.x = r.width / 2 - cx * VIEW.zoom;
  VIEW.y = r.height / 2 - cy * VIEW.zoom;
  world.style.transform = `translate(${VIEW.x}px, ${VIEW.y}px) scale(${VIEW.zoom})`;
  drawEdges();
  scheduleSave();
}

function renderStatus() {
  const errs = (S.issues || []).filter(i => i.level === "error").length;
  const warns = (S.issues || []).filter(i => i.level === "warning").length;
  const el = $("#status");
  if (!errs) {
    el.className = "status ok";
    el.textContent = warns ? `✓ 通过（${warns} 条提醒）` : "✓ 校验通过";
  } else {
    el.className = "status bad";
    el.textContent = `✗ ${errs} 个错误${warns ? " · " + warns + " 提醒" : ""}`;
  }
}

function itemRow(n, kind, it, editable) {
  const miss = kind === "need" && !editable && unmetOf(n).has(it.id);
  const ops = editable ? `<span class="ops">
      <button data-op="edit" title="编辑这条">✎</button>
      <button data-op="up" title="上移">↑</button>
      <button data-op="down" title="下移">↓</button>
      <button class="rm" data-op="del" title="删除这条">×</button></span>` : "";
  return `<div class="item${miss ? " miss" : ""}" data-kind="${kind}" data-item="${esc(it.id)}">
    <span class="iid">${esc(it.id)}</span>
    <span class="it" title="${esc(it.title)}">${esc(it.title)}</span>
    ${ops}
    ${kind === "need" ? '<i class="port" title="按住拖到对方的提供项"></i>' : ""}
  </div>`;
}

function cardHtml(n) {
  const p = POS[n.id] || { x: 0, y: 0 };
  const bad = issuesOf(n.id).some(i => i.level === "error");
  const cls = ["card"];
  if (n.external) cls.push("ext");
  if (selNode === n.id) cls.push("sel");
  if (bad) cls.push("bad");
  if (onlyGaps && !hasProblem(n)) cls.push("dim");
  const kind = n.type_label || (n.kind === "class" ? "类级" : (n.external ? "外部" : "模块"));
  const fam = n.type_family || (n.kind === "class" ? "结构" : "结构");
  const ex = n.exposes.map(it => itemRow(n, "expose", it)).join("") || '<div class="item"><span class="it" style="color:#9ca3af">（无）</span></div>';
  const nd = n.needs.map(it => itemRow(n, "need", it)).join("") || '<div class="item"><span class="it" style="color:#9ca3af">（无）</span></div>';
  return `<div class="${cls.join(" ")}" data-id="${esc(n.id)}" style="transform:translate(${p.x}px,${p.y}px)">
    <div class="head">
      <span class="name" title="${esc(n.id)}">${esc(n.name)}</span>
      <span class="badge${n.kind === "class" ? " cls" : n.external ? " ext" : ""}" data-fam="${esc(fam)}" title="类型：${esc(kind)}">${esc(kind)}</span>
      <a class="doc" title="打开 ${esc(n.spec || "spec.md")}">契约 ↗</a>
    </div>
    <div class="body">
      <div class="col ex"><h4>提供</h4>${ex}</div>
      <div class="col nd"><h4>需要</h4>${nd}</div>
    </div>
    <div class="foot"><span class="dot${bad ? " bad" : ""}"></span><span>${n.constraints.length} 条约束</span></div>
  </div>`;
}

// 模块页里「当前模块」自己的契约卡：三段都能就地增删改。
function selfCardHtml(n) {
  const p = POS[n.id] || { x: 0, y: 0 };
  const cls = ["card", "self"];
  if (selNode === n.id) cls.push("sel");
  if (issuesOf(n.id).some(i => i.level === "error")) cls.push("bad");
  const kids = kidsOf(n.id);
  const col = (title, kind, sec, arr) => {
    const rows = arr.map(it => {
      const row = itemRow(n, kind, it, true);
      if (kind !== "expose" || !kids.length) return row;
      const m = (n.mapping || []).find(x => x.parent === it.id);
      const label = !m ? '<b style="color:#b45309">未承接</b>'
        : !m.child ? "<b>自实现</b>"
        : `<b>${esc(m.child)} · ${esc(m.child_item)}</b>`;
      return row + `<div class="map">承接：${label}<button data-op="map">改</button></div>`;
    }).join("") || '<div class="item"><span class="it" style="color:#9ca3af">（无）</span></div>';
    const add = n.kind === "class" ? "" : `<div class="addrow" data-op="add" data-sec="${sec}">＋ 新增${title}</div>`;
    return `<div class="col ${kind === "expose" ? "ex" : kind === "need" ? "nd" : "cs"}"><h4>${title}</h4>${rows}${add}</div>`;
  };
  return `<div class="${cls.join(" ")}" data-id="${esc(n.id)}" data-self="1" style="transform:translate(${p.x}px,${p.y}px)">
    <div class="head">
      <span class="name" title="${esc(n.id)}">${esc(n.name)}</span>
      <span class="badge">本模块契约</span>
      <button class="ren" data-op="rename" title="给这个模块改名">✎</button>
      <a class="doc" title="打开 ${esc(n.spec || "spec.md")}">契约 ↗</a>
    </div>
    <div class="body">
      ${col("提供", "expose", "提供", n.exposes)}
      ${col("需要", "need", "需要", n.needs)}
      ${col("约束", "constraint", "约束", n.constraints)}
    </div>
    <div class="foot"><span class="dot"></span><span>${esc(n.id)}</span></div>
  </div>`;
}

function renderCards() {
  const vis = visibleNodes();
  const self = LEVEL ? nodeById(LEVEL) : null;
  const parts = [];
  if (self) parts.push(selfCardHtml(self));
  if (!vis.length && !self) {
    cardsBox.innerHTML = `<div class="empty-level">这一层还没有模块。空白处双击 = 新建第一个。</div>`;
    return;
  }
  cardsBox.innerHTML = parts.concat(vis.map(cardHtml)).join("");
}

// ------------------------------------------------------------------ 契约条目编辑

const KIND_OF_SEC = { "提供": "expose", "需要": "need", "约束": "constraint" };

function itemsOf(n, kind) {
  return kind === "expose" ? n.exposes : kind === "need" ? n.needs : n.constraints;
}

function openItemEditor(rel, section, itemId, isNew) {
  SIDE_LOCK = true;
  const n = nodeById(rel);
  if (!n) return;
  const kind = KIND_OF_SEC[section];
  const it = isNew ? { id: "", title: "", fields: {}, body: "" }
    : (itemsOf(n, kind).find(x => x.id === itemId) || { id: "", title: "", fields: {}, body: "" });
  const fieldRow = (k, v) => `<div class="frow">
      <input class="fk" placeholder="字段名（如 名称）" value="${esc(k)}">
      <input class="fv" placeholder="值" value="${esc(v)}">
      <button class="rmf" title="删掉这个字段">×</button></div>`;
  const rows = Object.entries(it.fields || {}).map(([k, v]) => fieldRow(k, v)).join("");
  side.innerHTML = `<div class="side-form">
    <h3>${isNew ? "新增" : "编辑"}「${n.name}」的${section}项</h3>
    <div class="sub">写清楚「是什么、满足什么」，不写语言、框架、函数签名、文件路径。</div>
    <label>编号<input id="f-id" value="${esc(it.id || "（保存时自动编号）")}" readonly></label>
    <label>标题<input id="f-title" value="${esc(it.title)}" placeholder="比如：下单受理" autocomplete="off"></label>
    <div class="sec">字段</div>
    <div id="f-fields">${rows}</div>
    <div class="addrow" id="f-addfield">＋ 加一个字段</div>
    <div class="sec">补充说明</div>
    <textarea id="f-body" placeholder="可选。别写实现步骤。">${esc(it.body)}</textarea>
    <div class="acts"><button class="primary" id="f-save">保存</button><button class="ghost" id="f-cancel">取消</button></div>
    <div class="hint">保存后立刻写回 <span class="code">${esc(n.spec || "spec.md")}</span>，并重新跑一遍校验。</div>
  </div>`;
  const bindRemove = row => row.querySelector(".rmf").onclick = () => row.remove();
  side.querySelectorAll(".frow").forEach(bindRemove);
  $("#f-addfield").onclick = () => {
    const box = $("#f-fields");
    box.insertAdjacentHTML("beforeend", fieldRow("", ""));
    bindRemove(box.lastElementChild);
    box.lastElementChild.querySelector(".fk").focus();
  };
  $("#f-cancel").onclick = () => { SIDE_LOCK = false; selNode = rel; selLink = null; renderSide(); };
  $("#f-save").onclick = async () => {
    if (BUSY) return;
    const title = $("#f-title").value.trim();
    if (!title) { toast("标题不能为空", true); return; }
    const fields = [];
    side.querySelectorAll(".frow").forEach(r => {
      const k = r.querySelector(".fk").value.trim();
      const v = r.querySelector(".fv").value.trim();
      if (k) fields.push([k, v]);
    });
    BUSY = true;
    try {
      applyState(await api("item/save", {
        rel, section, id: it.id, title, fields, body: $("#f-body").value.trim(),
      }));
      SIDE_LOCK = false;
      selNode = rel; selLink = null; renderSide();
      toast("已保存到 spec.md");
    } catch (e) { toast(e.message, true); }
    finally { BUSY = false; }
  };
  $("#f-title").focus();
}

function openMapEditor(rel, itemId) {
  const n = nodeById(rel);
  const kids = kidsOf(rel);
  const cur = (n.mapping || []).find(m => m.parent === itemId);
  const kidOpts = kids.map(k => `<option value="${esc(k.id)}"${cur && cur.child_abs === k.id ? " selected" : ""}>${esc(k.name)}</option>`).join("");
  const itemOpts = kid => kids.find(k => k.id === kid).exposes
    .map(e => `<option value="${esc(e.id)}"${cur && cur.child_abs === kid && cur.child_item === e.id ? " selected" : ""}>${esc(e.id)} ${esc(e.title)}</option>`).join("");
  side.innerHTML = `<div class="side-form">
    <h3>${esc(itemId)} 由谁承接</h3>
    <div class="sub">父契约不等于子契约的并集。这条提供项要么下沉给某个子模块，要么由本模块自己实现。</div>
    <label>承接方式<select id="mp-child"><option value="">（本模块自实现）</option>${kidOpts}</select></label>
    <label id="mp-itemwrap">子模块里的提供项<select id="mp-item"></select></label>
    <div class="acts"><button class="primary" id="mp-save">保存</button><button class="ghost" id="mp-cancel">取消</button></div>
    <div class="hint">写进「## 内部承接」段：<span class="code">- ${esc(itemId)} → 子模块：E1</span></div>
  </div>`;
  const sync = () => {
    const kid = $("#mp-child").value;
    $("#mp-itemwrap").classList.toggle("hidden", !kid);
    $("#mp-item").innerHTML = kid ? itemOpts(kid) : "";
  };
  $("#mp-child").onchange = sync;
  sync();
  $("#mp-cancel").onclick = () => { SIDE_LOCK = false; selNode = rel; renderSide(); };
  $("#mp-save").onclick = async () => {
    const child = $("#mp-child").value;
    try {
      applyState(await api("map/set", {
        rel, item: itemId, child, child_item: child ? $("#mp-item").value : "",
      }));
      SIDE_LOCK = false;
      selNode = rel; selLink = null; renderSide();
      toast(child ? "已写进「内部承接」" : "已标为本模块自实现");
    } catch (e) { toast(e.message, true); }
  };
}

// 卡片上那些小按钮：编辑 / 上移 / 下移 / 删除 / 承接 / 新增
cardsBox.addEventListener("click", e => {
  const ren = e.target.closest(".ren[data-op='rename']");
  if (ren) {
    e.stopPropagation();
    const card = ren.closest(".card");
    const n = nodeById(card.dataset.id);
    if (n) openRename(n.id, n.name);
    return;
  }
  const doc = e.target.closest(".doc");
  if (doc) {
    e.stopPropagation();
    const card = doc.closest(".card");
    api("open", { rel: card.dataset.id }).catch(err => toast(err.message, true));
    return;
  }
  const add = e.target.closest(".addrow[data-op='add']");
  if (add) { e.stopPropagation(); openItemEditor(LEVEL, add.dataset.sec, "", true); return; }
  const btn = e.target.closest(".ops button, .map button");
  if (!btn) return;
  e.stopPropagation();
  const item = btn.closest(".item");
  const card = btn.closest(".card");
  const rel = card.dataset.id;
  const op = btn.dataset.op;
  const kind = item.dataset.kind;
  const section = kind === "expose" ? "提供" : kind === "need" ? "需要" : "约束";
  const id = item.dataset.item;
  if (op === "edit") openItemEditor(rel, section, id, false);
  if (op === "map") openMapEditor(rel, id);
  if (op === "up" || op === "down") {
    api("item/move", { rel, section, id, delta: op === "up" ? -1 : 1 })
      .then(st => { applyState(st); toast("已调整顺序"); })
      .catch(err => toast(err.message, true));
  }
  if (op === "del") {
    if (!confirm(`删掉 ${id}？指着它的连线会一起删掉（可撤销）。`)) return;
    api("item/delete", { rel, section, id })
      .then(st => { applyState(st); side.innerHTML = ""; toast("已删除 " + id); })
      .catch(err => toast(err.message, true));
  }
});

// ------------------------------------------------------------------ 连线

function worldPoint(el, side) {
  const r = el.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  const x = (side === "right" ? r.right : r.left) - s.left;
  const y = r.top + r.height / 2 - s.top;
  return { x: (x - VIEW.x) / VIEW.zoom, y: (y - VIEW.y) / VIEW.zoom };
}

function portEl(link, need) {
  return cardsBox.querySelector(`.card[data-id="${CSS.escape(link.from)}"] .item[data-kind="need"][data-item="${CSS.escape(need)}"]`);
}
function exposeEl(link, expose) {
  return cardsBox.querySelector(`.card[data-id="${CSS.escape(link.to)}"] .item[data-kind="expose"][data-item="${CSS.escape(expose)}"]`);
}

function bez(a, b) {
  if (b.x >= a.x) {
    const dx = Math.max(40, (b.x - a.x) * 0.45);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }
  // 目标在左侧：从右边甩出去、从上方/下方绕回来，别穿卡片
  const off = (a.y <= b.y ? -1 : 1) * 78;
  return `M ${a.x} ${a.y} C ${a.x + 92} ${a.y + off}, ${b.x - 92} ${b.y + off}, ${b.x} ${b.y}`;
}

function drawEdges() {
  svg.innerHTML = "";
  for (const l of S.links) {
    for (const s of l.satisfies || []) {
      const a = portEl(l, s.need), b = exposeEl(l, s.expose);
      if (!a || !b) continue;
      const pa = worldPoint(a, "right"), pb = worldPoint(b, "left");
      const d = bez(pa, pb);
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hit.setAttribute("d", d); hit.setAttribute("class", "hit");
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", d); p.setAttribute("class", "edge" + (selLink && selLink.key === keyOf(l, s) ? " hot" : ""));
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", pb.x); dot.setAttribute("cy", pb.y); dot.setAttribute("r", 2.6); dot.setAttribute("class", "dot");
      g.append(hit, p, dot);
      hit.addEventListener("click", ev => {
        ev.stopPropagation();
        selLink = { key: keyOf(l, s), link: l, sat: s };
        selNode = null;
        renderSide(); drawEdges();
      });
      svg.appendChild(g);
    }
  }
  if (drag && drag.kind === "link" && drag.ghost) svg.appendChild(drag.ghost);
}

const keyOf = (l, s) => `${l.from}|${l.to}|${s.need}|${s.expose}`;

// ------------------------------------------------------------------ 详情栏

function renderSide() {
  // 正在编辑条目/承接时，滚动、拖拽、快照回执都不该把表单换掉（输入就没了）
  if (SIDE_LOCK && side.querySelector(".side-form")) return;
  if (selLink) {
    const { link, sat } = selLink;
    const from = nodeById(link.from), to = nodeById(link.to);
    side.innerHTML = `
      <h3>一条连线</h3>
      <div class="sub">只表示「可以访问」，不是调用、不是数据流。</div>
      <div class="row"><div class="k">${esc(from ? from.name : link.from)} 的 ${esc(sat.need)}</div>
        <div class="v">被 ${esc(to ? to.name : link.to)} 的 ${esc(sat.expose)} 满足</div></div>
      <button class="del" id="del-link">删除这条连线</button>`;
    $("#del-link").onclick = async () => {
      try {
        applyState(await api("link/del", { from: link.from, to: link.to, need: sat.need, expose: sat.expose }));
        selLink = null;
        toast("连线已删除");
      } catch (e) { toast(e.message, true); }
    };
    return;
  }
  if (!selNode) {
    side.innerHTML = `<div class="side-hint">点方块看它的契约。<br>空白处双击 = 新建模块。<br>按住需求项右侧圆点拖到对方提供项 = 建一条连线。</div>`;
    return;
  }
  const n = nodeById(selNode);
  if (!n) { side.innerHTML = ""; return; }
  const rows = (title, arr, kind) => {
    let out = `<h4>${title}</h4>`;
    if (!arr.length) return out + '<div class="row"><div class="v">（无）</div></div>';
    for (const it of arr) {
      out += `<div class="row"><div class="k">${esc(it.id)} ${esc(it.title)}</div>`;
      for (const [k, v] of Object.entries(it.fields || {})) out += `<div class="v"><span class="code">${esc(k)}</span> ${esc(v)}</div>`;
      if (it.body) out += `<div class="v">${esc(it.body)}</div>`;
      out += "</div>";
    }
    return out;
  };
  const iss = issuesOf(n.id).map(i => `<div class="iss${i.level === "warning" ? " warn" : ""}">
      <div class="code">${esc(i.code)}${i.item ? " · " + esc(i.item) : ""}</div>
      <div>${esc(i.message)}</div><div class="fix">↳ ${esc(i.fix)}</div></div>`).join("");
  const tLabel = n.type_label || "";
  const tFam = n.type_family || "结构";
  side.innerHTML = `
    <h3>${esc(n.name)}${tLabel ? ` <span class="badge" data-fam="${esc(tFam)}">${esc(tLabel)}</span>` : ""}</h3>
    <div class="sub">${esc(n.id)} · ${n.kind === "class" ? "类级节点" : "模块"}</div>
    ${n.spec ? `<div class="sub"><a href="#" id="open-spec">打开契约原文 ↗</a><div class="code">${esc(n.spec)}</div></div>` : ""}
    ${rows("提供", n.exposes, "expose")}
    ${rows("需要", n.needs, "need")}
    ${rows("约束", n.constraints, "constraint")}
    ${iss ? "<h4>问题</h4>" + iss : ""}
    ${n.kind !== "class" ? `<button class="go" id="go-node">进入这个模块的页面 →</button>` : ""}
    ${n.id !== "." ? `<button class="go" id="rename-node">给这个模块改名</button>` : ""}
    <button class="del" id="trash-node">把模块移到回收站</button>`;
  const go = $("#go-node");
  if (go) go.onclick = () => enterNode(n.id);
  const rn = $("#rename-node");
  if (rn) rn.onclick = () => openRename(n.id, n.name);
  const open = $("#open-spec");
  if (open) open.onclick = e => { e.preventDefault(); api("open", { rel: n.id }).catch(err => toast(err.message, true)); };
  $("#trash-node").onclick = async () => {
    if (!confirm(`把「${n.name}」移到 .specgraph/trash？文件夹不会真的删除。`)) return;
    try {
      applyState(await api("trash", { rel: n.id }));
      selNode = null;
      toast("已移到回收站");
    } catch (e) { toast(e.message, true); }
  };
}

// ------------------------------------------------------------------ 问题面板

function renderIssueCount() {
  const all = S.issues || [];
  const errs = all.filter(i => i.level === "error").length;
  const b = $("#isscount");
  b.textContent = String(all.length);
  b.className = errs ? "bad" : "";
}

function renderIssuePanel() {
  const box = $("#islist");
  const all = S.issues || [];
  if (!all.length) { box.innerHTML = '<div class="side-hint" style="margin-top:16px">没有校验问题。</div>'; return; }
  const groups = new Map();
  for (const i of all) {
    const k = i.node || "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const html = [];
  for (const [nid, items] of groups) {
    const n = nid ? nodeById(nid) : null;
    html.push(`<div class="grp">${n ? esc(n.name) + " · " + esc(nid) : "图级（不属于某个节点）"}</div>`);
    for (const i of items) {
      html.push(`<div class="one${i.level === "warning" ? " warn" : ""}" data-node="${esc(nid)}">
        <div class="code">${i.level === "warning" ? "⚠ " : "✗ "}${esc(i.code)}${i.item ? " · " + esc(i.item) : ""}</div>
        <div>${esc(i.message)}</div><div class="fix">↳ ${esc(i.fix)}</div>
        ${i.file ? `<div class="at">@ ${esc(i.file)}${i.line ? ":" + i.line : ""}</div>` : ""}
      </div>`);
    }
  }
  box.innerHTML = html.join("");
  box.querySelectorAll(".one").forEach(el => el.addEventListener("click", () => {
    const nid = el.dataset.node;
    $("#isspanel").classList.remove("open");
    if (nid) { SIDE_LOCK = false; selNode = nid; selLink = null; render(); focusNode(nid); }
  }));
}

function focusNode(id) {
  const p = POS[id];
  if (!p) return;
  const r = stage.getBoundingClientRect();
  VIEW.x = r.width / 2 - (p.x + 160) * VIEW.zoom;
  VIEW.y = r.height / 2 - (p.y + 80) * VIEW.zoom;
  render();
  scheduleSave();
}

// ------------------------------------------------------------------ 交互：拖方块 / 平移 / 缩放

stage.addEventListener("pointerdown", e => {
  if (e.button !== 0) return;
  // 条目上的小按钮、契约链接、侧栏表单：都不该触发拖动
  if (e.target.closest(".ops, .addrow, .map, .doc, .ren, .side-form")) return;
  const port = e.target.closest(".port");
  const card = e.target.closest(".card");

  if (port && card) { startLink(e, card, port); return; }
  if (card) {
    const id = card.dataset.id;
    if (e.shiftKey) {                       // Shift+点：加/减选
      if (SEL.has(id)) SEL.delete(id); else SEL.add(id);
      paintSelection();
      return;
    }
    startMove(e, card);
    return;
  }
  if (e.shiftKey) { startMarquee(e); return; }
  startPan(e);
});

function paintSelection() {
  cardsBox.querySelectorAll(".card").forEach(c => c.classList.toggle("multi", SEL.has(c.dataset.id)));
}

function startMarquee(e) {
  mode = "marquee";
  const rect = document.createElement("div");
  rect.id = "marquee";
  stage.appendChild(rect);
  drag = { sx: e.clientX, sy: e.clientY, rect };
  SEL = new Set();
  paintSelection();
}

function updateMarquee(e) {
  const s = stage.getBoundingClientRect();
  const x = Math.min(e.clientX, drag.sx) - s.left;
  const y = Math.min(e.clientY, drag.sy) - s.top;
  const w = Math.abs(e.clientX - drag.sx);
  const h = Math.abs(e.clientY - drag.sy);
  Object.assign(drag.rect.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
  const box = { l: x, t: y, r: x + w, b: y + h };
  SEL = new Set();
  cardsBox.querySelectorAll(".card").forEach(c => {
    const r = c.getBoundingClientRect();
    const b = { l: r.left - s.left, t: r.top - s.top, r: r.right - s.left, b: r.bottom - s.top };
    if (b.l < box.r && b.r > box.l && b.t < box.b && b.b > box.t) SEL.add(c.dataset.id);
  });
  paintSelection();
}

function startMove(e, card) {
  const id = card.dataset.id;
  if (!SEL.has(id)) { SEL = new Set([id]); paintSelection(); }
  const ids = [...SEL];
  const origins = {};
  ids.forEach(i => origins[i] = Object.assign({}, POS[i] || { x: 0, y: 0 }));
  mode = "move";
  drag = { ids, origins, sx: e.clientX, sy: e.clientY, moved: false, cards: ids.map(i => cardsBox.querySelector(`.card[data-id="${CSS.escape(i)}"]`)).filter(Boolean) };
  drag.cards.forEach(c => c.classList.add("drag"));
  SIDE_LOCK = false;
  selNode = id; selLink = null; renderSide();
  cardsBox.querySelectorAll(".card.sel").forEach(c => c.classList.remove("sel"));
  card.classList.add("sel");
}

function startPan(e) {
  mode = "pan";
  drag = { sx: e.clientX, sy: e.clientY, ox: VIEW.x, oy: VIEW.y };
  stage.classList.add("panning");
}

function startLink(e, card, port) {
  e.preventDefault();
  const item = port.closest(".item");
  const from = card.dataset.id;
  const need = item.dataset.item;
  const ghost = document.createElementNS("http://www.w3.org/2000/svg", "path");
  ghost.setAttribute("class", "ghost");
  mode = "link";
  drag = { kind: "link", from, need, ghost, start: worldPoint(item, "right") };
  document.body.classList.add("linking");
  markCandidates(from, need);
  svg.appendChild(ghost);
  moveGhost(e);
}

// 拉线时只有「真的能接」的提供项保持明亮：默认拒绝，其余压暗。
// 能接 = 不在自己这张卡上，且这条需求还没有被别的提供项接过（再接就成歧义）。
function markCandidates(from, need) {
  const used = new Set(
    (S.links || [])
      .filter(l => l.from === from && (l.satisfies || []).some(s => s.need === need))
      .map(l => `${l.to}|${(l.satisfies || []).find(s => s.need === need).expose}`)
  );
  cardsBox.querySelectorAll('.item[data-kind="expose"]').forEach(el => {
    const card = el.closest(".card");
    const ok = card && card.dataset.id !== from &&
               !used.has(`${card.dataset.id}|${el.dataset.item}`);
    el.classList.toggle("cand", !!ok);
  });
}

function clearCandidates() {
  cardsBox.querySelectorAll(".item.cand").forEach(x => x.classList.remove("cand"));
}

// 放弃这次拉线：撤掉幽灵线、候选高亮，回到普通状态
function cancelLink() {
  drag?.ghost?.remove();
  cardsBox.querySelectorAll(".item.drop").forEach(x => x.classList.remove("drop"));
  document.body.classList.remove("linking");
  clearCandidates();
  mode = null;
  drag = null;
  toast("已取消这次连线");
}

function moveGhost(e) {
  const s = stage.getBoundingClientRect();
  const p = { x: (e.clientX - s.left - VIEW.x) / VIEW.zoom, y: (e.clientY - s.top - VIEW.y) / VIEW.zoom };
  drag.ghost?.setAttribute("d", bez(drag.start, p));
}

window.addEventListener("pointermove", e => {
  if (!mode) return;
  if (mode === "pan") {
    VIEW.x = drag.ox + (e.clientX - drag.sx);
    VIEW.y = drag.oy + (e.clientY - drag.sy);
    world.style.transform = `translate(${VIEW.x}px, ${VIEW.y}px) scale(${VIEW.zoom})`;
    drawEdges();
  } else if (mode === "move") {
    const dx = (e.clientX - drag.sx) / VIEW.zoom;
    const dy = (e.clientY - drag.sy) / VIEW.zoom;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    drag.ids.forEach((id, i) => {
      const o = drag.origins[id];
      POS[id] = { x: Math.round(o.x + dx), y: Math.round(o.y + dy) };
      DIRTY.add(id);
      const c = drag.cards[i];
      if (c) c.style.transform = `translate(${POS[id].x}px,${POS[id].y}px)`;
    });
    drawEdges();
  } else if (mode === "marquee") {
    updateMarquee(e);
  } else if (mode === "link") {
    moveGhost(e);
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const target = el && el.closest(".item[data-kind='expose']");
    cardsBox.querySelectorAll(".item.drop").forEach(x => x.classList.remove("drop"));
    if (target) target.classList.add("drop");
  }
});

window.addEventListener("pointerup", async e => {
  if (!mode) return;
  const state = mode;
  mode = null;
  if (state === "pan") {
    stage.classList.remove("panning");
    scheduleSave();
  } else if (state === "marquee") {
    drag?.rect?.remove();
    paintSelection();
  } else if (state === "move") {
    drag?.cards?.forEach(c => c.classList.remove("drag"));
    if (drag?.moved) scheduleSave();
    drawEdges();
  } else if (state === "link") {
    document.body.classList.remove("linking");
    drag?.ghost?.remove();
    cardsBox.querySelectorAll(".item.drop").forEach(x => x.classList.remove("drop"));
    clearCandidates();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const target = el && el.closest(".item[data-kind='expose']");
    const card = el && el.closest(".card");
    if (target && card && drag) {
      try {
        applyState(await api("link/add", {
          from: drag.from, to: card.dataset.id,
          need: drag.need, expose: target.dataset.item,
        }));
        toast("已建立连线");
      } catch (err) { toast(err.message, true); }
    }
  }
  drag = null;
});

stage.addEventListener("wheel", e => {
  if (e.ctrlKey || true) e.preventDefault();
  const s = stage.getBoundingClientRect();
  const cx = e.clientX - s.left, cy = e.clientY - s.top;
  const wx = (cx - VIEW.x) / VIEW.zoom, wy = (cy - VIEW.y) / VIEW.zoom;
  const next = clamp(VIEW.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.25, 2.4);
  VIEW.x = cx - wx * next;
  VIEW.y = cy - wy * next;
  VIEW.zoom = next;
  render();
  scheduleSave();
}, { passive: false });

// 空白处双击：新建
stage.addEventListener("dblclick", e => {
  if (e.target.closest(".card")) return;
  const s = stage.getBoundingClientRect();
  openModal({ x: (e.clientX - s.left - VIEW.x) / VIEW.zoom, y: (e.clientY - s.top - VIEW.y) / VIEW.zoom });
});

// 双击方块：进它的页面（看它的子模块）
cardsBox.addEventListener("dblclick", e => {
  if (e.target.closest(".ops, .addrow, .map, .doc, .ren")) return;
  const card = e.target.closest(".card");
  if (card) { e.stopPropagation(); enterNode(card.dataset.id); }
});

// ------------------------------------------------------------------ 右键菜单

stage.addEventListener("contextmenu", e => {
  const card = e.target.closest(".card");
  if (!card) return;
  e.preventDefault();
  const id = card.dataset.id;
  const n = nodeById(id);
  const menu = $("#ctx");
  menu.innerHTML = `
    <button data-act="open">打开说明书</button>
    <button data-act="focus">居中显示</button>
    <button data-act="copy">复制节点 ID</button>
    <button data-act="trash" class="danger">移到回收站</button>`;
  menu.classList.remove("hidden");
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(e.clientX, innerWidth - w - 8) + "px";
  menu.style.top = Math.min(e.clientY, innerHeight - h - 8) + "px";
  menu.querySelectorAll("button").forEach(b => b.onclick = async () => {
    menu.classList.add("hidden");
    const act = b.dataset.act;
    if (act === "open") api("open", { rel: id }).catch(err => toast(err.message, true));
    if (act === "focus") focusNode(id);
    if (act === "copy") { navigator.clipboard?.writeText(id); toast("已复制 " + id); }
    if (act === "trash") {
      if (!n || !confirm(`把「${n.name}」移到 .specgraph/trash？`)) return;
      try { applyState(await api("trash", { rel: id })); toast("已移到回收站"); }
      catch (err) { toast(err.message, true); }
    }
  });
});
window.addEventListener("click", () => $("#ctx").classList.add("hidden"));

// ------------------------------------------------------------------ 新建弹窗

let pendingPoint = null;
function openModal(point) {
  const lv = LEVEL ? nodeById(LEVEL) : null;
  if (lv && lv.kind === "class") { toast("类级节点是最底层，下面不能再挂模块"); return; }
  pendingPoint = point;
  $("#modal h3").textContent = lv ? `新建节点 · 建在「${lv.name}」里` : "新建节点 · 建在项目页";
  $("#m-err").textContent = "";
  $("#m-name").value = "";
  $("#m-class").value = "";
  $("#m-file").value = "";
  document.querySelectorAll(".seg button").forEach(x => x.classList.toggle("on", x.dataset.kind === "module"));
  document.querySelectorAll(".sheet .cls").forEach(l => l.hidden = true);
  $("#modal").classList.remove("hidden");
  setTimeout(() => $("#m-name").focus(), 30);
}
function closeModal() { $("#modal").classList.add("hidden"); pendingPoint = null; }

document.querySelectorAll(".seg button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".seg button").forEach(x => x.classList.remove("on"));
  b.classList.add("on");
  const isClass = b.dataset.kind === "class";
  document.querySelectorAll(".sheet .cls").forEach(l => l.hidden = !isClass);
});
$("#m-cancel").onclick = closeModal;
$("#m-ok").onclick = async () => {
  const name = $("#m-name").value.trim();
  const kind = document.querySelector(".seg button.on").dataset.kind;
  try {
    const parent = createParent();
    const next = await api("new", {
      name, kind, parent,
      class_name: $("#m-class").value.trim(),
      file: $("#m-file").value.trim(),
    });
    const id = parent && parent !== "." ? parent + "/" + name : name;
    if (pendingPoint) {
      POS[id] = { x: Math.round(pendingPoint.x), y: Math.round(pendingPoint.y) };
      DIRTY.add(id);
      await api("move", { pos: { [id]: POS[id] }, view: VIEW, level: LEVEL });
      DIRTY.delete(id);
    }
    closeModal();
    applyState(await api("state"));
    if (id) ensureVisible(id);
    toast("已创建 " + name);
  } catch (e) {
    $("#m-err").textContent = e.message;
  }
};
$("#m-name").addEventListener("keydown", e => { if (e.key === "Enter") $("#m-ok").click(); if (e.key === "Escape") { e.stopPropagation(); closeModal(); } });

// ------------------------------------------------------------------ 顶栏

$("#btn-gaps").onclick = () => {
  onlyGaps = !onlyGaps;
  $("#btn-gaps").classList.toggle("on", onlyGaps);
  render();
};
$("#btn-issues").onclick = () => {
  $("#isspanel").classList.toggle("open");
  renderIssuePanel();
};
$("#iss-close").onclick = () => $("#isspanel").classList.remove("open");

$("#btn-undo").onclick = async () => {
  if (BUSY) return;              // 连点两次不能退两步
  BUSY = true;
  try { applyState(await api("undo")); toast("已撤销"); }
  catch (e) { toast(e.message, true); }
  finally { BUSY = false; }
};
$("#btn-redo").onclick = async () => {
  if (BUSY) return;
  BUSY = true;
  try { applyState(await api("redo")); toast("已重做"); }
  catch (e) { toast(e.message, true); }
  finally { BUSY = false; }
};
let EXP = null;
$("#btn-exp").onclick = async () => {
  const rel = LEVEL || "";
  try {
    const r = await api("export/preview", { rel });
    EXP = { rel, ...r };
    $("#exp-title").textContent = `导出指令包 · ${r.name}`;
    const bits = [`依赖 ${r.deps} 条`, `约束 ${r.constraints} 条`];
    if (r.unsatisfied.length) bits.push(`缺口 ${r.unsatisfied.length} 条`);
    bits.push(r.ok ? "图通过校验" : "图未通过校验");
    $("#exp-meta").textContent = bits.join(" · ");
    const warn = $("#exp-warn");
    const lines = [];
    if (!r.ok) lines.push("这张图还有错误。导出只是预览，修好再存更稳妥（清单见「问题」抽屉）。");
    r.unsatisfied.forEach(u => lines.push(`未满足：${u.id} ${u.title}`));
    (r.selfcheck || []).forEach(s => lines.push(`自检：${s}`));
    warn.innerHTML = lines.map(t => `<div>${esc(t)}</div>`).join("");
    warn.classList.toggle("hidden", lines.length === 0);
    $("#exp-text").textContent = r.text;
    $("#expmodal").classList.remove("hidden");
    $("#exp-text").scrollTop = 0;
  } catch (e) { toast(e.message, true); }
};
$("#exp-cancel").onclick = () => $("#expmodal").classList.add("hidden");
$("#exp-copy").onclick = async () => {
  if (!EXP) return;
  try {
    await navigator.clipboard.writeText(EXP.text);
    toast("已复制全文");
  } catch (e) {
    // 剪贴板权限不给时退回到手选
    const ta = document.createElement("textarea");
    ta.value = EXP.text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
    toast("已复制全文");
  }
};
$("#exp-save").onclick = async () => {
  if (!EXP) return;
  try {
    const r = await api("export", { rel: EXP.rel });
    toast("已写出：" + r.path);
    $("#expmodal").classList.add("hidden");
  } catch (e) { toast(e.message, true); }
};
$("#exp-reveal").onclick = async () => {
  try { await api("reveal", { path: "exports" }); }
  catch (e) { toast(e.message, true); }
};
$("#btn-ref").onclick = () => {
  $("#refmodal").classList.remove("hidden");
  $("#r-path").value = "";
  $("#ref-err").textContent = "";
  setTimeout(() => $("#r-path").focus(), 30);
};
$("#ref-cancel").onclick = () => $("#refmodal").classList.add("hidden");
$("#r-ok").onclick = async () => {
  try {
    applyState(await api("ref/add", { target: $("#r-path").value.trim() }));
    $("#refmodal").classList.add("hidden");
    toast("已引用，并钉住了当前指纹");
  } catch (e) { $("#ref-err").textContent = e.message; }
};
$("#r-path").addEventListener("keydown", e => {
  if (e.key === "Enter") $("#r-ok").click();
  if (e.key === "Escape") { e.stopPropagation(); $("#refmodal").classList.add("hidden"); }
});

// 项目：切换 / 新建
$("#btn-proj").onclick = () => {
  $("#projmodal").classList.remove("hidden");
  $("#p-path").value = S.project || "";
  $("#p-err").textContent = "";
  setTimeout(() => $("#p-path").focus(), 30);
};
$("#p-cancel").onclick = () => $("#projmodal").classList.add("hidden");
$("#p-open").onclick = async () => {
  if (await switchProject($("#p-path").value.trim(), false, $("#p-err")))
    $("#projmodal").classList.add("hidden");
};
$("#p-new").onclick = async () => {
  if (await switchProject($("#p-path").value.trim(), true, $("#p-err")))
    $("#projmodal").classList.add("hidden");
};
$("#p-path").addEventListener("keydown", e => {
  if (e.key === "Enter") $("#p-open").click();
  if (e.key === "Escape") { e.stopPropagation(); $("#projmodal").classList.add("hidden"); }
});

// ------------------------------------------------------------------ 助手
// 助手只改契约与连线：它给出的写操作一律先变成计划，用户点了执行才落盘。
// 执行走后端 batch：一步一步做，任何一步失败就整批回滚，不留半截图。

const ASSIST = { msgs: [], plan: [], busy: false };
const AI_TIP = $("#ai-log") ? $("#ai-log").innerHTML : "";

function renderAssist() {
  const log = $("#ai-log");
  if (!log) return;
  const ai = S?.ai || {};
  const state = $("#ai-state");
  state.textContent = ai.ready ? `已连 ${ai.model || "模型"}` : "还没配 API Key";
  state.classList.toggle("bad", !ai.ready);

  log.innerHTML = ASSIST.msgs.map(m => {
    if (m.role === "user") return `<div class="msg me">${esc(m.content)}</div>`;
    return `<div class="msg ai${m.bad ? " bad" : ""}">${esc(m.content)}</div>`;
  }).join("") || AI_TIP;
  log.scrollTop = log.scrollHeight;

  $("#ai-plan").classList.toggle("hidden", !ASSIST.plan.length);
  $("#ai-plan-n").textContent = ASSIST.plan.length;
  $("#ai-plan-list").innerHTML = ASSIST.plan.map(o => `<li>${esc(o.desc)}</li>`).join("");
  $("#ai-send").disabled = ASSIST.busy;
  $("#ai-send").textContent = ASSIST.busy ? "想…" : "发送";
}

function say(text, bad) {
  ASSIST.msgs.push({ role: "assistant", content: text, bad: !!bad });
}

async function aiSend() {
  if (ASSIST.busy) return;
  const ta = $("#ai-text");
  const text = (ta.value || "").trim();
  if (!text) return;
  if (!(S.ai && S.ai.ready)) {
    say("还没填 API Key。点上面的「设置」填一下，Key 只存在本机。", true);
    renderAssist();
    openAiSettings();
    return;
  }
  ASSIST.msgs.push({ role: "user", content: text });
  ta.value = "";
  ASSIST.busy = true;
  ASSIST.plan = [];
  renderAssist();
  try {
    const r = await api("ai/chat", { messages: ASSIST.msgs.map(m => ({ role: m.role, content: m.content })), level: LEVEL });
    if (r.reply) say(r.reply);
    if ((r.plan || []).length) {
      ASSIST.plan = r.plan;
      if (!r.reply) say(`我准备改 ${r.plan.length} 步，看看下面的计划。`);
      if ((r.gaps || []).length) {
        say("这份计划还有没补齐的地方，执行后图上仍会留问题：\n" + r.gaps.map(g => "· " + g).join("\n"), true);
      }
      // 计划出来了但必须人点一下才写盘，不说清楚最容易以为「AI 不会改」
      toast(`计划好了：${r.plan.length} 步。点下面的「执行这些改动」才会写盘`);
    }
  } catch (e) {
    say(e.message, true);
  }
  ASSIST.busy = false;
  renderAssist();
}

$("#ai-send").onclick = aiSend;
$("#ai-text").addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); aiSend(); }
});
$("#ai-cancel").onclick = () => {
  ASSIST.plan = [];
  say("这次不改了。要不要我换个说法再试一次？");
  renderAssist();
};
$("#ai-run").onclick = async () => {
  if (!ASSIST.plan.length || ASSIST.busy) return;
  ASSIST.busy = true;
  renderAssist();
  try {
    const r = await api("ai/apply", { ops: ASSIST.plan });
    const touched = (r.changed || []).join("、") || "（没动文件）";
    if (r.partial) {
      // 图已经改了，只有导出那一步失败：别让用户以为要重来
      say(`${r.error || "导出没成功。"}图已经按计划改好了，${r.applied} 步，动到：${touched}。`, true);
      if (r.export && r.export.error) say(`导出失败：${r.export.error}`, true);
    } else {
      say(`执行完了，${r.applied} 步，动到：${touched}。不满意可以 Ctrl+Z 撤销。`);
      if (r.export && r.export.path) say(`指令包已写出：${r.export.path}`);
      toast(`已按计划改图（${r.applied} 步）`);
    }
    ASSIST.plan = [];
    applyState(r.state);
  } catch (e) {
    say("这一步没做成，已经整批撤销，图还是原样：" + e.message, true);
    ASSIST.plan = [];
  }
  ASSIST.busy = false;
  renderAssist();
};

// 助手设置：地址 / 模型 / Key，只存本机
async function openAiSettings() {
  const err = $("#a-err");
  err.textContent = "";
  try {
    const r = await api("ai/config");
    const c = r.config || {};
    $("#a-base").value = c.base_url || "";
    $("#a-model").value = c.model || "";
    $("#a-key").value = "";
    $("#a-key").placeholder = c.api_key_set ? "已保存（留空则不修改）" : "sk-...";
  } catch (e) { err.textContent = e.message; }
  $("#aimodal").classList.remove("hidden");
  setTimeout(() => $("#a-base").focus(), 30);
}
$("#btn-ai-set").onclick = openAiSettings;
$("#a-cancel").onclick = () => $("#aimodal").classList.add("hidden");
$("#a-save").onclick = async () => {
  const body = {
    base_url: $("#a-base").value.trim() || "https://api.deepseek.com",
    model: $("#a-model").value.trim() || "deepseek-chat",
  };
  const key = $("#a-key").value.trim();
  if (key) body.api_key = key;
  try {
    const r = await api("ai/config", body);
    if (S) S.ai = { ready: r.config.api_key_set, model: r.config.model, base_url: r.config.base_url };
    $("#aimodal").classList.add("hidden");
    toast("助手设置已保存");
    renderAssist();
  } catch (e) { $("#a-err").textContent = e.message; }
};

$("#minimap").addEventListener("click", e => {
  if (!MM.s) return;
  const r = e.currentTarget.getBoundingClientRect();
  const wx = (e.clientX - r.left - MM.ox) / MM.s + MM.minX;
  const wy = (e.clientY - r.top - MM.oy) / MM.s + MM.minY;
  const st = stage.getBoundingClientRect();
  VIEW.x = st.width / 2 - wx * VIEW.zoom;
  VIEW.y = st.height / 2 - wy * VIEW.zoom;
  DIRTY_VIEWS.add(LEVEL);
  render();
  scheduleSave();
});

// 关掉最上面那层浮层；关掉一个就返回 true。一次 Esc 只关一层，
// 不能「关掉弹窗 + 顺带退出当前模块页」。
function anyOverlayOpen() {
  if (FIND.open) { closeFind(); return true; }
  if (RENAME) { closeRename(); return true; }
  if ($("#isspanel").classList.contains("open")) {
    $("#isspanel").classList.remove("open");
    return true;
  }
  for (const id of ["#expmodal", "#aimodal", "#projmodal", "#refmodal", "#modal"]) {
    const el = $(id);
    if (el && !el.classList.contains("hidden")) {
      if (id === "#modal") closeModal(); else el.classList.add("hidden");
      return true;
    }
  }
  return false;
}

window.addEventListener("keydown", e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openFind(); return; }
  // 在输入框里打字时，Ctrl+Z / Delete 属于文本框，不能拿去撤销图谱或删连线
  const typing = e.target instanceof Element &&
                 e.target.closest("input, textarea, select, [contenteditable='true']");
  if (typing) {
    if (e.key === "Escape") { e.stopPropagation(); return; }   // Esc 由输入框自己处理
    return;
  }
  if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); $("#btn-undo").click(); return; }
  if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
    e.preventDefault(); $("#btn-redo").click(); return;
  }
  if (e.key === "Escape") {
    if (anyOverlayOpen()) return;    // 浮层优先：关掉它，且这一次 Esc 到此为止
    // 正在拉线：只取消这一次拉线，不退出层级
    if (mode === "link") {
      cancelLink();
      return;
    }
    $("#ctx").classList.add("hidden");
    SEL = new Set(); paintSelection();
    if (LEVEL) {
      trail.pop();
      goToLevel(trail.length ? trail[trail.length - 1][0] : "");
    }
  }
  if (e.key === "Delete" && selLink) {
    const { link, sat } = selLink;
    api("link/del", { from: link.from, to: link.to, need: sat.need, expose: sat.expose })
      .then(st => { selLink = null; applyState(st); toast("连线已删除"); })
      .catch(err => toast(err.message, true));
  }
});

// ------------------------------------------------------------------ 搜索（Ctrl+K）
// 只搜已经加载进来的快照：模块名、条目编号与标题、字段正文。不扫磁盘、不碰代码。

const FIND = { hits: [], idx: 0, open: false };

function findIndex() {
  const out = [];
  for (const n of S.nodes || []) {
    out.push({
      rel: n.id, name: n.name, kind: "node", section: "", entry: "",
      title: n.name, sub: n.kind === "class" ? `${n.id} · 类级` : `${n.id} · 模块`,
      hay: `${n.name} ${n.id}`.toLowerCase(),
    });
    const each = (arr, sec) => (arr || []).forEach(it => out.push({
      rel: n.id, name: n.name, kind: "item", section: sec, entry: it.id, title: it.title,
      sub: `${n.name} · ${sec} · ${it.id}`,
      hay: [n.name, n.id, it.id, it.title,
        Object.entries(it.fields || {}).map(([k, v]) => `${k} ${v}`).join(" "), it.body || ""]
        .join(" ").toLowerCase(),
    }));
    each(n.exposes, "提供");
    each(n.needs, "需要");
    each(n.constraints, "约束");
  }
  return out;
}

function findRender(q) {
  const key = q.trim().toLowerCase();
  const all = findIndex();
  let hits = key ? all.filter(h => h.hay.includes(key)) : all.filter(h => h.kind === "node");
  hits = hits.map(h => {
    let rank = 3;
    const t = (h.kind === "node" ? h.name : h.title).toLowerCase();
    if (t === key) rank = 0;
    else if (t.startsWith(key)) rank = 1;
    else if (t.includes(key)) rank = 2;
    if (h.kind === "node") rank -= 0.5;
    return { ...h, rank };
  }).sort((a, b) => a.rank - b.rank || a.title.length - b.title.length);
  FIND.hits = hits.slice(0, 40);
  FIND.idx = 0;
  $("#find-n").textContent = hits.length > FIND.hits.length
    ? `${FIND.hits.length} / ${hits.length}` : (hits.length ? `${hits.length} 条` : "");
  $("#find-list").innerHTML = FIND.hits.map((h, i) => `
    <button class="fr${i === 0 ? " on" : ""}" data-i="${i}">
      <span class="fr-t">${esc(h.kind === "node" ? h.name : `${h.entry} ${h.title}`)}</span>
      <span class="fr-s">${esc(h.sub)}</span>
    </button>`).join("") || `<div class="fr-empty">没找到。换个词试试，比如「登录」「约束」「指纹」。</div>`;
  $("#find-list").querySelectorAll(".fr").forEach(btn => {
    btn.onclick = () => pickFind(Number(btn.dataset.i));
  });
}

function pickFind(i) {
  const h = FIND.hits[i];
  if (!h) return;
  closeFind();
  jumpTo(h.rel, h.section, h.entry, h.kind);
}

// 模块命中 → 直接进它的页面；条目命中 → 停在它所在的模块页并打开那条
function jumpTo(rel, section, entry, kind) {
  const parts = String(rel).split("/");
  const parent = parts.slice(0, -1).join("/");
  const target = kind === "node" ? rel : parent;
  trail = [];
  const upto = target ? target.split("/").length : 0;
  for (let i = 1; i <= upto; i++) {
    const id = parts.slice(0, i).join("/");
    const n = nodeById(id);
    trail.push([id, n ? n.name : id]);
  }
  if (LEVEL !== target) {
    VIEWS[LEVEL] = { ...VIEW };
    DIRTY_VIEWS.add(LEVEL);
    flushSave().catch(() => {});
    LEVEL = target;
    VIEW = VIEWS[target] ? { ...VIEWS[target] } : { zoom: 1, x: 0, y: 0 };
  }
  history.replaceState(null, "", target ? "#/" + encodeURIComponent(target) : "#");
  selNode = rel; selLink = null;
  render();
  if (kind !== "node") ensureVisible(rel);
  renderSide();
  if (entry) openItemEditor(rel, section, entry, false);
}

function openFind() {
  FIND.open = true;
  $("#find").classList.remove("hidden");
  const q = $("#find-q");
  q.value = "";
  q.focus();
  findRender("");
}

function closeFind() {
  FIND.open = false;
  $("#find").classList.add("hidden");
}

$("#btn-find").onclick = () => openFind();
$("#find").onclick = e => { if (e.target.id === "find") closeFind(); };
$("#find-q").addEventListener("input", e => findRender(e.target.value));
$("#find-q").addEventListener("keydown", e => {
  const n = FIND.hits.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!n) return;
    FIND.idx = (FIND.idx + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    $("#find-list").querySelectorAll(".fr").forEach((b, i) => b.classList.toggle("on", i === FIND.idx));
    const cur = $("#find-list .fr.on");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }
  if (e.key === "Enter") { e.preventDefault(); pickFind(FIND.idx); }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
});

// ------------------------------------------------------------------ 改名
// 改的是文件夹名；graph.toml 里指向它的 from/to、画布坐标一起改，算一步撤销。

let RENAME = null;

function openRename(rel, name) {
  if (!rel || rel === ".") { toast("项目根不能改名", true); return; }
  RENAME = rel;
  $("#r-old").textContent = `当前：${rel}`;
  $("#r-name").value = name || rel.split("/").pop();
  $("#r-err").textContent = "";
  $("#renmodal").classList.remove("hidden");
  const inp = $("#r-name");
  inp.focus();
  inp.select();
}

function closeRename() {
  RENAME = null;
  $("#renmodal").classList.add("hidden");
}

async function doRename() {
  if (!RENAME) return;
  const name = $("#r-name").value.trim();
  if (!name) { $("#r-err").textContent = "名字不能为空"; return; }
  const rel = RENAME;
  try {
    const st = await api("node/rename", { rel, name });
    const openInside = LEVEL === rel || (LEVEL || "").startsWith(rel + "/");
    closeRename();
    if (openInside) { LEVEL = ""; trail = []; }
    selNode = st.renamed ? st.renamed.to : rel;
    applyState(st);
    toast(`已改名为「${name}」`);
  } catch (e) {
    $("#r-err").textContent = e.message;
  }
}

$("#r-cancel").onclick = () => closeRename();
$("#r-save").onclick = () => doRename();
$("#r-name").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); doRename(); }
  if (e.key === "Escape") { e.stopPropagation(); closeRename(); }
});

// ------------------------------------------------------------------ 左栏：项目树 / 模块库

function renderDock() {
  renderProj();
  renderTree();
  renderLib();
  renderTypes();
}

// 项目区：当前项目 + 最近打开过的（一个项目就是一个文件夹，切过去就是换一份图）
function renderProj() {
  const cur = $("#proj-current"), list = $("#projlist");
  if (!cur || !list) return;
  const path = S.project || "";
  cur.textContent = S.root || "（未命名）";
  cur.title = path || "当前项目没有路径";
  const items = S.projects || [];
  list.innerHTML = items.map(p => `
    <div class="pj${p.path === path ? " on" : ""}" data-path="${esc(p.path)}" title="${esc(p.path)}">
      <span class="pjn">${esc(p.name)}</span><small>${esc(p.path)}</small>
      <span class="pjacts">
        <button class="pjx" data-act="reveal" title="打开这个文件夹">▣</button>
        <button class="pjx" data-act="remove" title="从列表移除（不动磁盘）">×</button>
      </span>
    </div>`).join("") || `<div class="pj" style="cursor:default">还没有打开过别的项目</div>`;
  list.querySelectorAll(".pj[data-path]").forEach(el => {
    el.onclick = async () => {
      const want = el.dataset.path;
      if (!want || want === path) return;
      await switchProject(want, false);
    };
    el.querySelectorAll(".pjx").forEach(btn => {
      btn.onclick = async ev => {
        ev.stopPropagation();
        const want = el.dataset.path;
        if (btn.dataset.act === "reveal") {
          try { await api("reveal", { path: want }); }
          catch (e) { toast(e.message, true); }
          return;
        }
        try {
          const r = await api("project/remove", { path: want });
          S.projects = r.items;
          renderProj();
          toast(`已从列表移除「${want.split(/[\\/]/).pop()}」（文件夹没动）`);
        } catch (e) { toast(e.message, true); }
      };
    });
  });
}

async function switchProject(path, create, errBox) {
  try {
    const snap = await api(create ? "project/new" : "project/open", { path });
    trail = [];
    LEVEL = "";                 // 不重置会停在上个项目的模块页
    VIEWS = {};                 // 同名节点的视野不能跨项目继承
    VIEW = { zoom: 1, x: 0, y: 0 };
    DIRTY.clear(); DIRTY_VIEWS.clear();
    SEL = new Set(); selNode = null; selLink = null; SIDE_LOCK = false;
    location.hash = "";
    applyState(snap, { keepView: false });
    toast(create ? `已新建项目「${snap.root}」` : `已切换到「${snap.root}」`);
    return true;
  } catch (err) {
    if (errBox) errBox.textContent = err.message;
    else toast(err.message, true);
    return false;
  }
}

// 概览：按当前层的坐标画缩略图 + 视口框；点一下把视角移到那儿
let MM = { minX: 0, minY: 0, s: 0, ox: 0, oy: 0 };
function renderMinimap() {
  const box = $("#minimap");
  if (!box) return;
  box.querySelectorAll(".mm-node, .mm-view").forEach(e => e.remove());
  const nodes = visibleNodes();
  // 只有自己一张卡时，缩略图没有意义
  box.classList.toggle("hidden", nodes.length < 2);
  const W = box.clientWidth, H = box.clientHeight;
  const padTop = 18, pad = 8;
  const CW = 322, CH = 240;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  nodes.forEach(n => {
    const p = POS[n.id];
    if (!p) return;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + CW); maxY = Math.max(maxY, p.y + CH);
  });
  if (!isFinite(minX)) { MM = { minX: 0, minY: 0, s: 0, ox: pad, oy: padTop }; return; }
  const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
  const s = Math.min((W - pad * 2) / bw, (H - padTop - pad) / bh);
  const ox = pad, oy = padTop;
  MM = { minX, minY, s, ox, oy };
  nodes.forEach(n => {
    const p = POS[n.id];
    if (!p) return;
    const d = document.createElement("i");
    d.className = "mm-node" + (hasProblem(n) ? " bad" : "");
    d.style.left = (ox + (p.x - minX) * s).toFixed(1) + "px";
    d.style.top = (oy + (p.y - minY) * s).toFixed(1) + "px";
    d.style.width = Math.max(5, CW * s).toFixed(1) + "px";
    d.style.height = Math.max(4, CH * s).toFixed(1) + "px";
    box.appendChild(d);
  });
  const r = stage.getBoundingClientRect();
  const vx = -VIEW.x / VIEW.zoom, vy = -VIEW.y / VIEW.zoom;
  const vw = r.width / VIEW.zoom, vh = r.height / VIEW.zoom;
  const v = document.createElement("i");
  v.className = "mm-view";
  v.style.left = Math.max(0, ox + (vx - minX) * s).toFixed(1) + "px";
  v.style.top = Math.max(0, oy + (vy - minY) * s).toFixed(1) + "px";
  v.style.width = Math.max(8, vw * s).toFixed(1) + "px";
  v.style.height = Math.max(8, vh * s).toFixed(1) + "px";
  box.appendChild(v);
}

function renderTree() {
  const box = $("#tree");
  if (!box) return;
  const rows = [];
  const walk = (n, depth) => {
    const bad = issuesOf(n.id).some(i => i.level === "error");
    rows.push(`<div class="tnode${n.id === LEVEL ? " cur" : ""}${n.kind === "class" ? " cls" : ""}"
      data-id="${esc(n.id)}" style="padding-left:${6 + depth * 14}px">
      <span class="tw">${kidsOf(n.id).length ? "▾" : (n.kind === "class" ? "◇" : "·")}</span>
      <span class="tk">${esc(n.name)}</span>
      ${bad ? '<span class="tbadge" title="这个节点有错误">!</span>' : ""}
    </div>`);
    kidsOf(n.id).forEach(k => walk(k, depth + 1));
  };
  S.nodes.filter(n => (n.parent || "") === "").forEach(n => walk(n, 0));
  box.innerHTML = rows.join("") || `<div class="empty">这一层还没有模块。</div>`;
  box.querySelectorAll(".tnode").forEach(el => {
    el.onclick = () => {
      const n = nodeById(el.dataset.id);
      if (!n) return;
      if (n.kind === "class") { toast("类级节点已经是最底层，不再展开"); return; }
      enterNode(n.id);
    };
  });
}

// 类型面板：点一下就在当前层建一个带该类型标签的空模块（类型只是标签，不改校验）。
const TYPE_HINT = {
  模块: "一组契约的容器", 接口控制器: "对外入口，接收请求并分派", 网关: "统一的进出关口",
  中间件: "请求前置处理", 服务: "一段业务能力的实现", 编排器: "把多个能力编排成流程",
  事件处理器: "收到事件后做什么", 数据模型: "数据与规则的载体", 传输对象: "模块之间传的形态",
  数据表: "持久化的行列", 视图: "给人看的呈现", 枚举: "有限的取值集合",
  仓储: "取存数据的那一层", 缓存: "先查这里，再回源", 界面组件: "页面上的一个块",
  前端应用: "用户直接打开的应用", 环境变量: "部署时注入的配置", 错误类型: "可判定的失败形态",
  外部服务: "图外的系统",
};

function renderTypes() {
  const box = $("#types");
  if (!box) return;
  const list = S.types || [];
  box.innerHTML = list.map(t => `
    <div class="typechip" data-key="${esc(t.key)}" data-fam="${esc(t.family)}"
         title="${esc(t.family)} · ${esc(TYPE_HINT[t.label] || "")}">
      <i></i><span>${esc(t.label)}</span>
    </div>`).join("");
  box.querySelectorAll(".typechip").forEach(el => {
    el.addEventListener("click", async () => {
      const t = list.find(x => x.key === el.dataset.key);
      if (!t) return;
      const base = "新" + t.label;
      let name = base, i = 2;
      while (S.nodes.some(n => n.id === parentId(name))) name = base + (i++);
      try {
        const st = await api("new", {
          name, kind: "module", parent: createParent(), type: t.key,
        });
        applyState(st);
        toast(`已新建「${name}」（${t.label}）`);
      } catch (e) { toast("新建失败：" + e.message); }
    });
  });
}

function renderLib() {
  const box = $("#lib");
  if (!box) return;
  const lib = S.library || [];
  box.innerHTML = lib.map(t => `
    <div class="libcard" draggable="true" data-key="${esc(t.key)}" data-name="${esc(t.name)}">
      <b>${esc(t.name)}</b>
      ${t.type_label ? `<span class="badge" data-fam="${esc(t.family || "结构")}">${esc(t.type_label)}</span>` : ""}
      <div class="bl">${esc(t.blurb)}</div>
      <div class="drag-hint">拖进画布 →</div>
    </div>`).join("");
  box.querySelectorAll(".libcard").forEach(el => {
    el.addEventListener("dragstart", ev => {
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData("text/x-specgraph-tpl", el.dataset.key);
      ev.dataTransfer.setData("text/plain", el.dataset.name);
    });
  });
}

document.querySelectorAll("#dock .tabs button").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll("#dock .tabs button").forEach(x => x.classList.toggle("on", x === b));
    ["tree", "lib", "ai", "help"].forEach(t => $("#tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
    if (b.dataset.tab === "ai") setTimeout(() => $("#ai-text")?.focus(), 30);
  };
});

$("#btn-demo").onclick = async () => {
  try {
    const st = await api("tpl/demo", { parent: createParent() });
    applyState(st);
    const vis = visibleNodes();
    if (vis.length && onScreenCount(vis) * 2 <= vis.length) focusOnViewport();
    toast("示例已放进当前这一层：4 个模块 + 3 条线");
  } catch (e) { toast(e.message, true); }
};

// 模块库拖进画布：落点换算成世界坐标，然后新建模块并把它摆在那儿。
let dropTpl = null;
stage.addEventListener("dragover", e => {
  if (!e.dataTransfer.types.includes("text/x-specgraph-tpl")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  stage.classList.add("dropping");
});
stage.addEventListener("dragleave", e => {
  if (e.target === stage) stage.classList.remove("dropping");
});
stage.addEventListener("drop", async e => {
  const key = e.dataTransfer.getData("text/x-specgraph-tpl");
  if (!key) return;
  e.preventDefault();
  stage.classList.remove("dropping");
  const rect = stage.getBoundingClientRect();
  const wx = Math.round((e.clientX - rect.left - VIEW.x) / VIEW.zoom - 160);
  const wy = Math.round((e.clientY - rect.top - VIEW.y) / VIEW.zoom - 40);
  const name = e.dataTransfer.getData("text/plain") || "";
  try {
    const st = await api("tpl/new", { key, name, parent: createParent() });
    const id = st.created;
    if (id) {
      // 落点就是它该待的地方：先记在本地的「已改」集合里，免得被服务端旧快照覆盖
      POS[id] = { x: wx, y: wy };
      DIRTY.add(id);
      await api("move", { pos: { [id]: POS[id] }, view: VIEW, level: LEVEL });
      DIRTY.delete(id);
      VIEWS[LEVEL] = Object.assign({}, VIEW);
    }
    applyState(await api("state"));
    if (id) ensureVisible(id);
    toast(`已放到「${id || name}」`);
  } catch (err) { toast(err.message, true); }
});

$("#btn-dock")?.addEventListener("click", () => {
  $("#dock").classList.toggle("hidden");
  requestAnimationFrame(drawEdges);
});

$("#zoom")?.addEventListener("click", () => {
  focusOnViewport();
  toast("已把这一层的模块都放进视野");
});

// ------------------------------------------------------------------ 启动

(async function boot() {
  try {
    applyState(await api("state"), { keepView: false });
    syncFromHash();
    render();
  } catch (e) {
    toast("读不到项目：" + e.message, true);
  }
})();

// 关窗口前把还没落盘的位置/视野补上（防抖 400ms 内关机也不会丢）
window.addEventListener("beforeunload", () => {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    fetch("/api/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pos: POS, view: VIEW, level: LEVEL }),
      keepalive: true,
    });
  } catch (e) { /* 关窗时无能为力，别拦着 */ }
});

window.addEventListener("hashchange", () => { syncFromHash(); render(); });


