/* 界面里那几个「以谁为准」的纯判断，单独放这里：
 * 它们不碰 DOM，可以在 node 里直接跑测试（见 tests/ui_logic_check.js）。
 * 规则只有一条：本地刚改过的东西，服务端的旧快照不许覆盖它。
 */
(function (root) {
  // 位置：服务端给的底子，本地改过的节点以本地为准
  function mergePositions(serverPos, localPos, dirty) {
    const out = Object.assign({}, serverPos || {});
    (dirty || []).forEach(function (id) {
      if (localPos && localPos[id]) out[id] = localPos[id];
    });
    return out;
  }

  // 视野：同理，本地动过的层以本地为准
  function mergeViews(serverViews, localViews, dirtyLevels) {
    const out = Object.assign({}, serverViews || {});
    (dirtyLevels || []).forEach(function (lv) {
      if (localViews && localViews[lv]) out[lv] = localViews[lv];
    });
    return out;
  }

  // 什么时候才允许自动取景：第一次看这一层，或者记住的视野已经看不到一半模块、
  // 且这一轮没有新摆进来的节点（有节点在自动摆放时，位置还没稳定，先别动视野）。
  function shouldFit(opt) {
    const total = opt.total || 0;
    if (!total) return false;
    if (opt.firstLook) return true;
    if (opt.placed > 0) return false;
    return opt.onScreen * 2 <= total;
  }

  // 新建/放入的节点如果不在屏幕里，把它平移到视野中央（不改缩放）
  function centerOn(pos, view, stage, card) {
    const w = (card && card.w) || 322, h = (card && card.h) || 260;
    const cx = (pos.x + w / 2) * view.zoom + view.x;
    const cy = (pos.y + h / 2) * view.zoom + view.y;
    if (cx > 40 && cx < stage.width - 40 && cy > 40 && cy < stage.height - 40) return null;
    return {
      zoom: view.zoom,
      x: stage.width / 2 - (pos.x + w / 2) * view.zoom,
      y: stage.height / 2 - (pos.y + h / 2) * view.zoom,
    };
  }

  const api = { mergePositions: mergePositions, mergeViews: mergeViews, shouldFit: shouldFit, centerOn: centerOn };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SGLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this);