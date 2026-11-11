"""桌面画布应用：把图摆到窗口里，能拖、能新建、能连线。

设计边界（和十条铁律一致）：
- 画布只写两种东西：`spec.md`（契约）与 `graph.toml`（连线）。坐标另存
  `.specgraph/layout.json`，它随时可以删，删了重排，不影响契约。
- 不读代码、不生成代码；界面上没有「从代码生成」「导出代码」这类入口。
- 每个改动都重新跑一遍校验，结果直接回填到画布上。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import ai, canvas, checks, editor, export, library
from .cli import TEMPLATE
from .model import (
    GRAPH_FILE,
    SEC_CONSTRAINTS,
    SEC_EXPOSES,
    SEC_NEEDS,
    SPEC_FILE,
    TYPES,
    load_project,
    load_whitelist,
    normalize_type,
    sha256_file,
)

def _web_dir() -> Path:
    """源码运行时是 specgraph/web；PyInstaller 打包后在解包目录里。"""
    import sys
    base = getattr(sys, "_MEIPASS", None)
    if base:
        return Path(base) / "specgraph" / "web"
    return Path(__file__).resolve().parent / "web"


WEB_DIR = _web_dir()
STATE_DIR = ".specgraph"
LAYOUT_FILE = "layout.json"
# 最近打开过的项目。它只是「快捷方式」：图本身仍然只由项目文件夹里的三份文件决定，
# 删掉这个列表不会丢任何契约。
PROJECTS_FILE = Path.home() / ".specgraph" / "projects.json"
WINDOW = None  # pywebview 的窗口对象；换项目时改标题用

# 加载器不会遍历这些文件夹名（见 model.load_project 的 skip 集合）。用它们当模块名，
# 目录会建出来、卡片却不出现——所以建/改名时直接拦住。
RESERVED_DIRS = {"__pycache__", "node_modules", ".git", ".venv", "venv", "dist", "build",
                 "exports", STATE_DIR}


def load_projects() -> list[dict]:
    try:
        data = json.loads(PROJECTS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    # 文件夹被删/改名的不再列出来，免得点了报错
    return [p for p in data
            if isinstance(p, dict) and p.get("path") and Path(p["path"]).is_dir()]


def remove_project(path: str) -> list[dict]:
    """只把它从最近列表里拿掉，磁盘上的文件夹一个字都不动。"""
    items = [p for p in load_projects() if p.get("path") != str(Path(path))]
    try:
        PROJECTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        PROJECTS_FILE.write_text(
            json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
    return items


def remember_project(root: Path) -> None:
    items = [p for p in load_projects() if p.get("path") != str(root)]
    items.insert(0, {
        "path": str(root),
        "name": root.name,
        "last": datetime.now().isoformat(timespec="seconds"),
    })
    try:
        PROJECTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        PROJECTS_FILE.write_text(
            json.dumps(items[:12], ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass  # 记不住最近项目不算错误


EMPTY_PROJECT_SPEC = """---
name: {name}
kind: module
status: draft
---

## 提供

（暂无。项目根本身可以什么都不提供，能力通常落在子模块里。）

## 需要

（无。）

## 约束

### C1 真相源

- 规则：这张图的真相只在这份 spec.md 和 graph.toml 里，代码是图外的一次性实现。
- 与实现无关：不指定语言、不指定框架、不写具体做法。
"""


# --------------------------------------------------------------------------- layout

def _state_dir(root: Path) -> Path:
    d = root / STATE_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_layout(root: Path) -> dict:
    path = root / STATE_DIR / LAYOUT_FILE
    if not path.is_file():
        return {"version": 1, "pos": {}, "view": {"zoom": 1, "x": 0, "y": 0}, "views": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": 1, "pos": {}, "view": {"zoom": 1, "x": 0, "y": 0}, "views": {}}
    data.setdefault("version", 1)
    data.setdefault("pos", {})
    data.setdefault("view", {"zoom": 1, "x": 0, "y": 0})
    data.setdefault("views", {})
    return data


def _prune_layout(root: Path, data: dict) -> None:
    """扔掉已经不存在的节点留下的坐标与视野。

    改名、删模块、撤销之后，layout.json 里会留下「信息过滤」「JWT校验」这种旧名字的
    键。它们不会报错，只会让文件越积越大，并且下次误建同名模块时会「凭空继承」旧位置。
    """
    def alive(key: str) -> bool:
        rel = (key or "").strip("/")
        if not rel:                      # 项目根永远有效
            return True
        return (root / rel).is_dir()

    cur = data.get("pos")
    if isinstance(cur, dict):
        data["pos"] = {k: v for k, v in cur.items() if alive(k)}


def save_layout(root: Path, data: dict) -> None:
    _state_dir(root)
    _prune_layout(root, data)
    _atomic_write(root / STATE_DIR / LAYOUT_FILE, json.dumps(data, ensure_ascii=False, indent=1))


def _field_pairs(fields) -> list[tuple[str, str]]:
    """字段可以来自人（[[k, v], …]）、也可以来自模型（{k: v} 或 "k：v" 列表）。

    模型给 dict 时以前会被当成「键序列」直接解包，"语义" 被拆成 语/义 —— 写进文件就是
    "- 语：义"。这里统一归一。
    """
    out: list[tuple[str, str]] = []
    if not fields:
        return out
    if isinstance(fields, dict):
        return [(str(k).strip(), str(v).strip()) for k, v in fields.items() if str(k).strip()]
    for f in fields:
        if isinstance(f, dict):
            out.extend((str(k).strip(), str(v).strip()) for k, v in f.items() if str(k).strip())
        elif isinstance(f, (list, tuple)) and len(f) >= 2:
            out.append((str(f[0]).strip(), str(f[1]).strip()))
        elif isinstance(f, str):
            sep = "：" if "：" in f else ":"
            k, _, v = f.partition(sep)
            if k.strip():
                out.append((k.strip(), v.strip()))
    return out


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


# --------------------------------------------------------------------------- model

class Workspace:
    """一个打开的项目。所有改动都从这里落盘。"""

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.lock = threading.Lock()
        self._undo: list[dict] = []
        self._redo: list[dict] = []
        # 批量事务期间不裁剪撤销栈，否则 start 下标会失效，撤销会写回半截状态
        self._batching = 0
        self.tx = threading.RLock()

    # -- 读 -------------------------------------------------------------
    def snapshot(self) -> dict:
        project = load_project(self.root)
        rep = checks.check(project, load_whitelist(self.root))
        data = canvas.snapshot(project, rep)
        data["root"] = self.root.name
        layout = load_layout(self.root)
        data["view"] = layout.get("view", {"zoom": 1, "x": 0, "y": 0})
        data["views"] = layout.get("views", {})
        data["pos"] = layout.get("pos", {})
        data["library"] = library.catalog()
        data["types"] = [
            {"key": k, "label": zh, "family": fam}
            for k, (zh, fam) in TYPES.items()
        ]
        data["can_undo"] = bool(self._undo)
        data["can_redo"] = bool(self._redo)
        data["project"] = str(self.root)
        data["projects"] = load_projects()
        cfg = ai.load_config()
        data["ai"] = {"ready": bool(cfg.get("api_key")), "model": cfg.get("model", ""),
                      "base_url": cfg.get("base_url", "")}
        return data

    # -- 写：新建模块 ---------------------------------------------------
    def new_module(self, name: str, kind: str = "module",
                   parent: str = "", class_name: str = "", file: str = "",
                   node_type: str = "") -> dict:
        name = (name or "").strip()
        name = self._check_name(name)
        base = (self.root / parent).resolve() if parent else self.root
        if self.root not in base.parents and base != self.root:
            raise ValueError("父路径必须在项目里")
        target = base / name
        if (target / SPEC_FILE).exists():
            raise ValueError(f"{name} 已经有 {SPEC_FILE} 了")
        kind = "class" if kind == "class" else "module"
        extra = ""
        node_type = normalize_type(node_type)
        if node_type in TYPES:          # 认不出来的标签不写进文件
            extra += f"type: {node_type}\n"
        if kind == "class":
            extra = f"class: {class_name or name}\n" + extra
            if file:
                extra += f"file: {file}\n"
        with self.lock:
            target.mkdir(parents=True, exist_ok=True)
            text = TEMPLATE.format(
                name=name, kind=kind, extra=extra,
                sec_e=SEC_EXPOSES, sec_n=SEC_NEEDS, sec_c=SEC_CONSTRAINTS,
            )
            (target / SPEC_FILE).write_text(text, encoding="utf-8")
        return self.snapshot()

    # -- 写：从模块库拖进来 ---------------------------------------------
    def new_from_template(self, key: str, name: str = "", parent: str = "") -> dict:
        tpl = library.TEMPLATES.get(key)
        if not tpl:
            raise ValueError(f"模块库里没有「{key}」")
        name = (name or tpl.name).strip()
        if not name or any(c in name for c in '\\/:*?"<>|'):
            raise ValueError("名字不能为空，也不能包含 \\ / : * ? \" < > |")
        base = (self.root / parent).resolve() if parent else self.root
        if self.root not in base.parents and base != self.root:
            raise ValueError("父路径必须在项目里")
        target = base / name
        if (target / SPEC_FILE).exists():
            raise ValueError(f"{name} 已经有 {SPEC_FILE} 了")
        with self.lock:
            target.mkdir(parents=True, exist_ok=True)
            (target / SPEC_FILE).write_text(library.spec_text(key, name), encoding="utf-8")
        st = self.snapshot()
        st["created"] = f"{parent}/{name}" if parent and parent != "." else name
        return st

    def create_demo(self, parent: str = "") -> dict:
        """放一整张「用户中心」示例：四个模块 + 三条线，放进来就是合法的图。"""
        base = (self.root / parent).resolve() if parent else self.root
        if self.root not in base.parents and base != self.root:
            raise ValueError("父路径必须在项目里")
        for _, folder, _ in library.DEMO_MODULES:
            if (base / folder / SPEC_FILE).exists():
                raise ValueError(f"「{folder}」已经存在，示例没有放进来；换个空目录或先挪走它")
        prefix = "" if parent in ("", ".") else parent + "/"
        with self.lock:
            for key, folder, _ in library.DEMO_MODULES:
                target = base / folder
                target.mkdir(parents=True, exist_ok=True)
                (target / SPEC_FILE).write_text(library.spec_text(key, folder), encoding="utf-8")
        for src, dst, need, expose in library.DEMO_LINKS:
            self.add_link(prefix + src, prefix + dst, need, expose)
        return self.snapshot()

    # -- 写：位置 -------------------------------------------------------
    def move(self, positions: dict[str, dict], view: dict | None = None,
             level: str = "") -> dict:
        with self.lock:
            data = load_layout(self.root)
            data["pos"].update({k: v for k, v in positions.items() if isinstance(v, dict)})
            if view:
                data["view"] = view
                # 每一层各记各的视野：从子页面退回来，位置和缩放要回到原样
                data.setdefault("views", {})[level] = view
            save_layout(self.root, data)
        return {"ok": True}

    # -- 写：连线 -------------------------------------------------------
    def _graph_path(self) -> Path:
        return self.root / GRAPH_FILE

    def add_link(self, src: str, dst: str, need: str, expose: str) -> dict:
        src, dst = src.strip(), dst.strip()
        if not (src and dst and need and expose):
            raise ValueError("连线的两端都必须精确到条目")
        if src == dst:
            raise ValueError("不能连自己")
        project = load_project(self.root)
        if src not in project.specs:
            raise ValueError(f"图里没有节点 {src}")
        if dst not in project.specs:
            raise ValueError(f"图里没有节点 {dst}")
        if not any(i.id == need for i in project.specs[src].needs()):
            raise ValueError(f"{src} 没有需求项 {need}")
        if not any(i.id == expose for i in project.specs[dst].exposes()):
            raise ValueError(f"{dst} 没有提供项 {expose}")
        text = self._graph_path().read_text(encoding="utf-8") if self._graph_path().is_file() else ""
        for block in _link_blocks(text):
            if block["from"] == src and block["to"] == dst and any(
                    s.get("need") == need and s.get("expose") == expose for s in block["satisfies"]):
                raise ValueError("这条线已经有了")
        block = (
            "[[link]]\n"
            f'from = "{src}"\n'
            f'to = "{dst}"\n'
            f'satisfies = [{{ need = "{need}", expose = "{expose}" }}]\n'
        )
        with self.lock:
            self._keep(self._graph_path())
            body = text if text.strip() else "# 连线：A 的某条需求项，由 B 的某条提供项满足。\n"
            if not body.endswith("\n"):
                body += "\n"
            _atomic_write(self._graph_path(), body + ("\n" if body.strip() else "") + block)
        return self.snapshot()

    def del_link(self, src: str, dst: str, need: str, expose: str) -> dict:
        path = self._graph_path()
        text = path.read_text(encoding="utf-8") if path.is_file() else ""
        keep: list[str] = []
        dropped = False
        for chunk in _split_blocks(text):
            if chunk["kind"] != "link":
                keep.append(chunk["raw"])
                continue
            hit = (chunk["data"].get("from") == src and chunk["data"].get("to") == dst and any(
                s.get("need") == need and s.get("expose") == expose
                for s in (chunk["data"].get("satisfies") or [])))
            if hit and not dropped:
                dropped = True
                continue
            keep.append(chunk["raw"])
        if not dropped:
            raise ValueError("没有找到这条线")
        with self.lock:
            self._keep(path)
            _atomic_write(path, "".join(keep).rstrip() + "\n")
        return self.snapshot()

    # -- 杂项 -----------------------------------------------------------
    def trash_module(self, rel: str) -> dict:
        if rel in ("", "."):
            raise ValueError("不能删项目根")
        target = (self.root / rel).resolve()
        if self.root not in target.parents:
            raise ValueError("路径必须在项目里")
        if not target.is_dir():
            raise ValueError("没有这个模块")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        base = _state_dir(self.root) / "trash" / f"{target.name}-{stamp}"
        dest = base
        n = 2
        while dest.exists():             # 同一秒删两个同名模块时别撞车
            dest = base.with_name(f"{base.name}-{n}")
            n += 1
        dest.parent.mkdir(parents=True, exist_ok=True)
        with self.lock, self.tx:
            # 整个文件夹搬走也算一步操作：撤销时把它搬回来，连线一并还回去
            self._keep(self._graph_path(), moves=[(target, dest)])
            try:
                shutil.move(str(target), str(dest))
                self._drop_links(rel)
            except Exception:
                # 搬到一半失败：文件搬回来，撤销栈里那条也退掉
                self._move_path(dest, target)
                self._undo.pop()
                raise
        return self.snapshot()

    def _drop_links(self, rel: str) -> None:
        """模块被移走后，指向它的连线留着只会变成脏数据，一并清掉。"""
        path = self._graph_path()
        if not path.is_file():
            return
        text = path.read_text(encoding="utf-8")
        keep: list[str] = []
        for b in _split_blocks(text):
            if b["kind"] == "link":
                d = b["data"]
                if _under(d.get("from", ""), rel) or _under(d.get("to", ""), rel):
                    continue
            keep.append(b["raw"])
        _atomic_write(path, "".join(keep).rstrip() + "\n")

    # -- 写：改名（文件夹、连线、坐标一起改，算一步操作）------------------
    @staticmethod
    def _check_name(name: str) -> str:
        name = (name or "").strip()
        if not name:
            raise ValueError("名字不能为空")
        if any(c in name for c in '\\/:*?"<>|'):
            raise ValueError('名字不能包含 \\ / : * ? " < > |')
        if name.startswith("."):
            raise ValueError("名字不能以 . 开头（这种文件夹会被当成隐藏目录跳过）")
        if name in RESERVED_DIRS:
            raise ValueError(f"「{name}」是保留目录名，换一个")
        if name in (".", ".."):
            raise ValueError("这个名字不能用")
        return name

    def _rewrite_paths(self, old: str, new: str) -> bool:
        """graph.toml 里所有指到 old（或 old 下面）的 from / to / module，跟着改名。"""
        path = self._graph_path()
        if not path.is_file():
            return False
        text = path.read_text(encoding="utf-8")
        out: list[str] = []
        changed = False
        for line in text.splitlines(True):
            bare = line.rstrip("\r\n")
            for key in ("from", "to", "module"):
                head = f'{key} = "'
                if bare.startswith(head) and bare.endswith('"'):
                    val = bare[len(head):-1]
                    if val == old:
                        val = new
                    elif val.startswith(old + "/"):
                        val = new + val[len(old):]
                    else:
                        break
                    bare = f'{key} = "{val}"'
                    changed = True
                    break
            out.append(bare + ("\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""))
        if changed:
            _atomic_write(path, "".join(out))
        return changed

    def _rename_layout(self, old: str, new: str) -> None:
        """坐标和每层视野是按节点路径记的，改名后要一起挪，否则卡片会「飞」回原点。"""
        data = load_layout(self.root)

        def fix(key: str) -> str:
            if key == old:
                return new
            if key.startswith(old + "/"):
                return new + key[len(old):]
            return key

        if isinstance(data.get("pos"), dict):
            data["pos"] = {fix(k): v for k, v in data["pos"].items()}
        if isinstance(data.get("views"), dict):
            data["views"] = {fix(k): v for k, v in data["views"].items()}
        save_layout(self.root, data)

    def rename_node(self, rel: str, new_name: str) -> dict:
        rel = (rel or "").strip().strip("/")
        if rel in ("", "."):
            raise ValueError("项目根不能改名")
        new_name = self._check_name(new_name)
        src = (self.root / rel).resolve()
        if self.root not in src.parents:
            raise ValueError("路径必须在项目里")
        if not (src / SPEC_FILE).is_file():
            raise ValueError("没有这个模块")
        parent_rel = rel.rsplit("/", 1)[0] if "/" in rel else ""
        dest_dir = (self.root / parent_rel) if parent_rel else self.root
        dest = (dest_dir / new_name).resolve()
        if dest.exists():
            raise ValueError(f"「{new_name}」已经存在了，换一个名字")
        new_rel = f"{parent_rel}/{new_name}" if parent_rel else new_name
        with self.lock:
            spec_file = dest / SPEC_FILE
            self._keep(self._graph_path(), src / SPEC_FILE, moves=[(src, dest)])
            self._move_path(src, dest)
            self._rewrite_paths(rel, new_rel)
            self._rename_layout(rel, new_rel)
            self._rename_title(spec_file, rel.rsplit("/", 1)[-1], new_name)
        st = self.snapshot()
        st["renamed"] = {"from": rel, "to": new_rel}
        return st

    def _rename_title(self, spec_file: Path, old_name: str, new_name: str) -> None:
        """契约里表示「这个名字」的地方一起改：frontmatter 的 name、以及恰好等于旧名的一级标题。
        自定义的标题（比如「用户身份校验」）不动。"""
        try:
            text = spec_file.read_text(encoding="utf-8")
        except OSError:
            return
        lines = text.splitlines()
        changed = False
        for i, line in enumerate(lines):
            s = line.strip()
            if s.startswith("name:") and s.split(":", 1)[1].strip().strip("\"'") == old_name:
                lines[i] = f"name: {new_name}"
                changed = True
            elif s == f"# {old_name}":
                lines[i] = f"# {new_name}"
                changed = True
        if changed:
            spec_file.write_text("\n".join(lines) + ("\n" if text.endswith("\n") else ""), encoding="utf-8")

    def open_spec(self, rel: str) -> dict:
        target = (self.root / rel / SPEC_FILE).resolve() if rel not in ("", ".") else self.root / SPEC_FILE
        if not target.is_file():
            raise ValueError("没有这个文件")
        try:
            os.startfile(str(target))  # type: ignore[attr-defined]
        except AttributeError:
            pass
        return {"ok": True, "path": str(target)}

    # -- 写：契约条目 ---------------------------------------------------
    def _spec_path(self, rel: str) -> Path:
        base = (self.root / rel).resolve() if rel not in ("", ".") else self.root
        if base != self.root and self.root not in base.parents:
            raise ValueError("越界了：只能改项目里的模块")
        path = base / SPEC_FILE
        if not path.is_file():
            raise ValueError(f"{rel or '.'} 还没有 {SPEC_FILE}")
        return path

    def read_spec(self, rel: str) -> dict:
        path = self._spec_path(rel)
        text = path.read_text(encoding="utf-8")
        return {
            "rel": rel,
            "path": str(path),
            "text": text,
            "items": {sec: editor.item_ranges(text, sec) for sec in editor.SECTIONS},
            "mapping": {k: (v if v else None) for k, v in editor.mappings(text).items()},
            "next": {sec: editor.next_item_id(text, sec) for sec in editor.SECTIONS},
        }

    def save_item(self, rel: str, section: str, item_id: str = "", title: str = "",
                  fields: list | None = None, body: str = "") -> dict:
        path = self._spec_path(rel)
        text = path.read_text(encoding="utf-8")
        item_id = (item_id or "").strip() or editor.next_item_id(text, section)
        pairs = _field_pairs(fields)
        with self.lock:
            self._keep(path)
            _atomic_write(path, editor.save_item(text, section, item_id, title, pairs, body))
        return self.snapshot()

    def delete_item(self, rel: str, section: str, item_id: str) -> dict:
        path = self._spec_path(rel)
        text = path.read_text(encoding="utf-8")
        with self.lock:
            self._keep(path, self._graph_path())
            _atomic_write(path, editor.delete_item(text, section, item_id))
            self._drop_item_links(rel, section, item_id)
        return self.snapshot()

    def _drop_item_links(self, rel: str, section: str, item_id: str) -> None:
        """条目删了，指着它的连线也别留着——否则图上会冒出一条指向空气的线。"""
        path = self._graph_path()
        if not path.is_file():
            return
        text = path.read_text(encoding="utf-8")
        keep: list[str] = []
        changed = False
        for b in _split_blocks(text):
            if b["kind"] == "link":
                d = b["data"]
                sats = d.get("satisfies") or []
                left = []
                for s in sats:
                    hit = (section == SEC_NEEDS and d.get("from") == rel and s.get("need") == item_id) or \
                          (section == SEC_EXPOSES and d.get("to") == rel and s.get("expose") == item_id)
                    if hit:
                        changed = True
                    else:
                        left.append(s)
                if changed and len(left) != len(sats):
                    if not left:
                        continue
                    raw = b["raw"]
                    for s in sats:
                        if s not in left:
                            raw = raw.replace(
                                "{ need = \"%s\", expose = \"%s\" }" % (s.get("need"), s.get("expose")),
                                "", 1)
                    keep.append(raw)
                    continue
            keep.append(b["raw"])
        if changed:
            _atomic_write(path, "".join(keep).rstrip() + "\n")

    def move_item(self, rel: str, section: str, item_id: str, delta: int) -> dict:
        path = self._spec_path(rel)
        text = path.read_text(encoding="utf-8")
        with self.lock:
            self._keep(path)
            _atomic_write(path, editor.move_item(text, section, item_id, int(delta)))
        return self.snapshot()

    def set_mapping(self, rel: str, item_id: str, child: str = "", child_item: str = "") -> dict:
        path = self._spec_path(rel)
        text = path.read_text(encoding="utf-8")
        with self.lock:
            self._keep(path)
            if not child:
                _atomic_write(path, editor.set_mapping(text, item_id, "", ""))
            else:
                child_spec = self._spec_path(child)
                child_text = child_spec.read_text(encoding="utf-8")
                if not any(i["id"] == child_item for i in editor.item_ranges(child_text, SEC_EXPOSES)):
                    raise ValueError(f"{child} 没有提供项 {child_item}")
                # 契约里写相对名：父模块写「对账」，不写「订单系统/对账」
                rel_child = child
                if rel not in ("", ".") and child.startswith(rel + "/"):
                    rel_child = child[len(rel) + 1:]
                _atomic_write(path, editor.set_mapping(text, item_id, rel_child, child_item))
        return self.snapshot()

    def clear_mapping(self, rel: str, item_id: str) -> dict:
        path = self._spec_path(rel)
        text = path.read_text(encoding="utf-8")
        with self.lock:
            self._keep(path)
            _atomic_write(path, editor.clear_mapping(text, item_id))
        return self.snapshot()

    # -- 撤销 / 重做 -----------------------------------------------------
    def _keep(self, *paths: Path, moves: list[tuple[Path, Path]] | None = None) -> None:
        """记一步操作：文件改动 + （可选）整目录搬动。撤销就是把这两样都倒回去。"""
        snap: dict[str, str | None] = {}
        for p in paths:
            p = Path(p)
            snap[str(p)] = p.read_text(encoding="utf-8") if p.is_file() else None
        self._undo.append({"files": snap, "moves": [tuple(map(Path, m)) for m in (moves or [])]})
        if not self._batching:
            del self._undo[:-50]
        self._redo.clear()

    @staticmethod
    def _move_path(src: Path, dest: Path) -> None:
        """把 src 搬到 dest（任一端不存在/已存在时什么都不做，重放才安全）。"""
        if not Path(src).exists() or Path(dest).exists():
            return
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))

    def _replay(self, entry: dict, forward: bool) -> None:
        for src, dest in entry.get("moves", []):
            if forward:
                self._move_path(src, dest)
            else:
                self._move_path(dest, src)
        for k, v in entry["files"].items():
            p = Path(k)
            if v is None:
                p.unlink(missing_ok=True)
            else:
                _atomic_write(p, v)
        self._prune_empty_dirs()

    def _prune_empty_dirs(self) -> None:
        """撤销/回滚之后，把因此空掉的模块文件夹也收走，免得留下一堆空壳。"""
        for d in sorted((p for p in self.root.rglob("*") if p.is_dir()),
                        key=lambda p: len(p.parts), reverse=True):
            rel = d.relative_to(self.root)
            if any(part in self._SKIP_PARTS for part in rel.parts):
                continue
            try:
                if not any(d.iterdir()):
                    d.rmdir()
            except OSError:
                pass

    def undo(self) -> dict:
        with self.tx:                    # 弹栈与回放要原子，否则连点两次会退两步
            if not self._undo:
                raise ValueError("没有可撤销的操作了")
            entry = self._undo.pop()
            current = {
                "files": {
                    k: (Path(k).read_text(encoding="utf-8") if Path(k).is_file() else None)
                    for k in entry["files"]
                },
                "moves": entry.get("moves", []),
            }
            self._redo.append(current)
            with self.lock:
                self._replay(entry, forward=False)
        return self.snapshot()

    def redo(self) -> dict:
        with self.tx:
            if not self._redo:
                raise ValueError("没有可重做的操作了")
            entry = self._redo.pop()
            current = {
                "files": {
                    k: (Path(k).read_text(encoding="utf-8") if Path(k).is_file() else None)
                    for k in entry["files"]
                },
                "moves": entry.get("moves", []),
            }
            self._undo.append(current)
            with self.lock:
                self._replay(entry, forward=True)
        return self.snapshot()

    # -- 引用外部契约 ----------------------------------------------------
    def add_ref(self, target: str, module: str = "") -> dict:
        target = (target or "").strip()
        if not target:
            raise ValueError("要填外部契约的路径")
        target_dir = (self.root / target).resolve() if not Path(target).is_absolute() else Path(target).resolve()
        spec = target_dir / SPEC_FILE
        if not spec.is_file():
            raise ValueError(f"那个目录里没有 {SPEC_FILE}：{target}")
        try:
            rel_target = os.path.relpath(target_dir, self.root).replace("\\", "/")
        except ValueError:  # 跨盘：保留绝对路径，由 model.resolve_target 识别
            rel_target = target_dir.as_posix()
        digest = sha256_file(spec)
        path = self._graph_path()
        text = path.read_text(encoding="utf-8") if path.is_file() else ""
        for b in _split_blocks(text):
            if b["kind"] == "ref" and b["data"].get("target") == rel_target:
                raise ValueError("这张图已经引用过它了")
        block = (
            "[[ref]]\n"
            f'module = "{module or "."}"\n'
            f'target = "{rel_target}"\n'
            f'pinned_hash = "{digest}"\n'
        )
        with self.lock:
            self._keep(path)
            base = text.rstrip()
            _atomic_write(path, (base + "\n\n" if base else "") + block)
        return self.snapshot()

    # -- 导出指令包 ------------------------------------------------------
    EXPORT_DIR = "exports"

    def _export_name(self, rel: str) -> str:
        """文件名带上父目录，免得 订单系统/对账 和 库存系统/对账 互相覆盖。"""
        if rel in ("", "."):
            return self.root.name
        return rel.replace("/", "__")

    def _is_whole(self, project, rel: str) -> bool:
        """项目页（rel 为空）一律导整图；"." 有根契约时导根节点，没有就当整图。"""
        return rel == "" or (rel == "." and project.lookup(rel) is None)

    def _check_export_target(self, project, rel: str) -> None:
        if rel == "" or project.lookup(rel) is not None:
            return
        if rel == ".":
            return  # 没有根契约的老项目也允许整图导出
        raise ValueError(f"找不到节点：{rel}")

    def _export_payload(self, project, rel: str) -> dict:
        """把「单节点 / 整图」两种导出统一成一份预览数据。"""
        if self._is_whole(project, rel):
            whole = export.build_whole(project)
            return {
                "scope": "whole",
                "name": f"{self.root.name}-整图",
                "target": ".",
                "text": export.render_whole(whole),
                "manifest": export.render_whole_manifest(whole),
                "deps": len(whole.edges),
                "constraints": sum(len(s.constraints()) for s in whole.specs),
                "modules": len(whole.specs),
                "unsatisfied": [
                    {"id": n.id, "title": n.title, "node": rel2} for rel2, n in whole.unsatisfied
                ],
                "selfcheck": export.self_check_whole(whole),
            }
        pack = export.build(project, rel)
        return {
            "scope": "node",
            "name": self._export_name(rel),
            "target": pack.target.rel,
            "text": export.render(pack),
            "manifest": export.render_manifest(pack),
            "deps": len(pack.deps),
            "constraints": len(pack.target.constraints()),
            "modules": 1,
            "unsatisfied": [{"id": i.id, "title": i.title, "node": pack.target.rel}
                            for i in pack.unsatisfied],
            "selfcheck": export.self_check(pack),
        }

    def export_preview(self, rel: str) -> dict:
        """只渲染、不落盘：让用户先看清包里有什么，再决定要不要导出。"""
        project = load_project(self.root)
        self._check_export_target(project, rel)
        rep = checks.check(project, load_whitelist(self.root))
        payload = self._export_payload(project, rel)
        payload.update({
            "ok": rep.ok,
            "errors": [{"code": i.code, "node": i.node, "message": i.message}
                       for i in rep.issues if i.level == "error"][:20],
            "dir": str(self.root / self.EXPORT_DIR),
        })
        return payload

    def export_pack(self, rel: str) -> dict:
        project = load_project(self.root)
        self._check_export_target(project, rel)
        rep = checks.check(project, load_whitelist(self.root))
        payload = self._export_payload(project, rel)
        outdir = self.root / self.EXPORT_DIR
        outdir.mkdir(parents=True, exist_ok=True)
        md = outdir / f"{payload['name']}-指令包.md"
        js = outdir / f"{payload['name']}-manifest.json"
        _atomic_write(md, payload["text"])
        _atomic_write(js, payload["manifest"])
        return {"ok": rep.ok, "path": str(md), "manifest": str(js), "dir": str(outdir),
                "scope": payload["scope"]}

    def reveal(self, path: str) -> dict:
        """在资源管理器里定位到某个文件或文件夹。"""
        target = Path(path)
        if not target.is_absolute():
            target = (self.root / path).resolve()
        if not target.exists():
            target = target.parent if target.parent.exists() else self.root
        try:
            if target.is_dir():
                os.startfile(str(target))  # noqa: S606
            else:
                subprocess.Popen(["explorer", "/select,", str(target)])
        except OSError as exc:
            raise ValueError(f"打不开：{exc}") from exc
        return {"ok": True, "path": str(target)}

    # -- 批量事务（AI 助手用：要么全成，要么一个字都不动）------------------
    _SKIP_PARTS = {".specgraph", "exports", ".export", "__pycache__", ".git", "node_modules"}

    def _tree_of(self) -> dict[str, str]:
        snap: dict[str, str] = {}
        layout_rel = f"{STATE_DIR}/{LAYOUT_FILE}"
        for p in self.root.rglob("*"):
            rel = p.relative_to(self.root)
            keep_state = rel.as_posix() == layout_rel   # 坐标/视野也要能回滚
            if not keep_state and any(part in self._SKIP_PARTS for part in rel.parts):
                continue
            if p.is_file():
                try:
                    snap[rel.as_posix()] = p.read_text(encoding="utf-8")
                except (OSError, UnicodeDecodeError):
                    continue
        return snap

    def _restore_tree(self, snap: dict[str, str]) -> None:
        now = self._tree_of()
        for rel in now:
            if rel not in snap:
                (self.root / rel).unlink(missing_ok=True)
        for rel, text in snap.items():
            path = self.root / rel
            if not path.is_file() or path.read_text(encoding="utf-8", errors="replace") != text:
                _atomic_write(path, text)
        # 清掉回滚后留下的空目录（自底向上）
        for d in sorted((p for p in self.root.rglob("*") if p.is_dir()),
                        key=lambda p: len(p.parts), reverse=True):
            rel = d.relative_to(self.root)
            if any(part in self._SKIP_PARTS for part in rel.parts):
                continue
            try:
                if not any(d.iterdir()):
                    d.rmdir()
            except OSError:
                pass

    def _apply_op(self, op: dict) -> str:
        kind = op.get("op") or op.get("tool")
        args = op.get("args") or op
        if kind in ("create_module", "new_module"):
            self.new_module(
                name=args.get("name", ""), kind=args.get("kind", "module"),
                parent=args.get("parent", ""), class_name=args.get("class_name", ""),
                file=args.get("file", ""), node_type=args.get("type", ""),
            )
            return f"新建模块 {args.get('name', '')}"
        if kind == "write_item":
            self.save_item(
                rel=args.get("rel", ""), section=args.get("section", "提供"),
                item_id=args.get("item", "") or args.get("item_id", ""),
                title=args.get("title", ""), fields=args.get("fields") or {},
                body=args.get("body", ""),
            )
            return f"写入 {args.get('rel', '')} 的 {args.get('section', '')} 条目"
        if kind == "delete_item":
            self.delete_item(args.get("rel", ""), args.get("section", "提供"),
                             args.get("item", "") or args.get("item_id", ""))
            return f"删除 {args.get('rel', '')} 的 {args.get('item', '')}"
        if kind == "move_item":
            self.move_item(args.get("rel", ""), args.get("section", "提供"),
                           args.get("item", "") or args.get("item_id", ""),
                           int(args.get("delta", 0)))
            return f"调整 {args.get('item', '')} 的顺序"
        if kind == "set_mapping":
            self.set_mapping(args.get("rel", ""), args.get("item", "") or args.get("item_id", ""),
                             args.get("child", ""), args.get("child_item", ""))
            return f"设置承接 {args.get('item', '')}"
        if kind == "add_link":
            self.add_link(args.get("from", ""), args.get("to", ""),
                          args.get("need", ""), args.get("expose", ""))
            return f"连线 {args.get('from', '')}.{args.get('need', '')} → {args.get('to', '')}.{args.get('expose', '')}"
        if kind == "remove_link":
            self.del_link(args.get("from", ""), args.get("to", ""),
                          args.get("need", ""), args.get("expose", ""))
            return f"删除连线 {args.get('from', '')}.{args.get('need', '')}"
        if kind == "trash_module":
            self.trash_module(args.get("rel", ""))
            return f"回收站：{args.get('rel', '')}"
        if kind in ("rename_node", "rename_module"):
            self.rename_node(args.get("rel", ""), args.get("name", ""))
            return f"改名 {args.get('rel', '')} → {args.get('name', '')}"
        raise ValueError(f"不认识的步骤：{kind}")

    def batch(self, ops: list[dict]) -> dict:
        """顺序执行一串步骤；任何一步失败就把整个项目恢复原样。"""
        with self.tx:                    # 整批持锁：别的请求不能插进来改半个状态
            before = self._tree_of()
            start = len(self._undo)
            done: list[str] = []
            self._batching += 1
            try:
                for op in ops:
                    done.append(self._apply_op(op))
            except Exception as exc:  # noqa: BLE001
                self._restore_tree(before)
                del self._undo[start:]
                raise ValueError(f"第 {len(done) + 1} 步失败，整批已撤销：{exc}") from exc
            finally:
                self._batching -= 1

            after = self._tree_of()
            changed = {p for p in before.keys() | after.keys() if before.get(p) != after.get(p)}
            del self._undo[start:]
            if changed:
                self._undo.append({
                    "files": {str(self.root / p): before.get(p) for p in changed},
                    "moves": [],
                })
                self._redo.clear()
            del self._undo[:-50]
            return {"ok": True, "applied": len(done), "steps": done,
                    "changed": sorted(changed), "state": self.snapshot()}

    # -- AI 助手 ---------------------------------------------------------
    def plan_check(self, ops: list[dict]) -> list[str]:
        """把计划在临时副本上真跑一遍：能跑通、且跑完校验没有新错误，才算合格。

        这样模型「只加需求不连线」这类缺口会在给用户看之前就被发现，而不是等执行到一半回滚。
        """
        graph_ops = [o for o in ops if (o.get("op") or o.get("tool")) != "export_pack"]
        if not graph_ops:
            return []
        tmp_root = Path(tempfile.mkdtemp(prefix="sg_plan-")) / self.root.name
        try:
            shutil.copytree(self.root, tmp_root)
            probe = Workspace(tmp_root)
            before = {i.code + "|" + str(i.node) + "|" + i.message
                      for i in checks.check(load_project(self.root),
                                            load_whitelist(self.root)).issues
                      if i.level == "error"}
            probe.batch(graph_ops)
            rep = checks.check(load_project(tmp_root), load_whitelist(tmp_root))
            fresh = []
            for i in rep.issues:
                if i.level != "error":
                    continue
                key = i.code + "|" + str(i.node) + "|" + i.message
                if key in before:
                    continue
                fresh.append(f"{i.node} · {i.code}：{i.message}")
            # 新建了模块却一条契约都没写：校验器不报错，但那就是个空壳
            for op in graph_ops:
                if op.get("op") != "create_module":
                    continue
                args = op.get("args") or {}
                name = (args.get("name") or "").strip()
                parent = (args.get("parent") or "").strip()
                key = f"{parent}/{name}" if parent and parent != "." else name
                try:
                    sp = probe.read_spec(key)
                except Exception:  # noqa: BLE001
                    continue
                if not any(sp["items"].get(s) for s in (SEC_EXPOSES, SEC_NEEDS, SEC_CONSTRAINTS)):
                    fresh.append(
                        f"{key} · 空契约：新建了模块，却没写任何提供项/需求项。"
                        f"要么在这份计划里把它写满，要么说清它有意留空。")
            return fresh[:8]
        except Exception as exc:  # noqa: BLE001
            return [f"按这个计划执行会失败：{exc}"]
        finally:
            shutil.rmtree(tmp_root.parent, ignore_errors=True)

    def ai_chat(self, messages: list[dict], level: str = "") -> dict:
        """一轮对话：只读工具当场执行，写操作变成计划等用户批准。

        计划出来后再在临时副本上试跑一遍；跑不通或跑完有新错误，就把问题丢回给模型补计划。
        """
        cfg = ai.load_config()
        msgs: list[dict] = list(messages)
        reply = ""
        plan: list[dict] = []
        gaps: list[str] = []
        for attempt in range(3):
            out = ai.complete(cfg, msgs)
            reply = out["content"] or reply
            calls = out["tool_calls"]
            if not calls:
                # 用户明明在要求「改」，模型却只回了话：再问一次，逼它给出工具调用或明说不用改。
                # 纯问答（「这图有什么问题」）不加这一轮，免得白等一次。
                ask = (messages[-1].get("content") if messages else "") or ""
                wants_edit = any(w in ask for w in (
                    "改", "加", "新增", "删", "去掉", "新建", "重命名", "改名",
                    "连", "接线", "拆", "补", "调整", "换"))
                if wants_edit and not plan and attempt == 0:
                    msgs.append({"role": "assistant", "content": reply or "（没有调用工具）"})
                    msgs.append({"role": "user", "content": (
                        "你刚才只回了话，没有调用任何工具。如果这次确实要改图，请直接调用工具，"
                        "把改动列成计划；如果确实不需要改，请明确回一句「这次不需要改图」。")})
                    reply = ""
                    continue
                break
            reads = []
            unknown: list[tuple[str, str]] = []
            for c in calls:
                fn = c.get("function") or {}
                name = fn.get("name") or ""
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except ValueError:
                    args = {}
                if name in ai.READ_ONLY:
                    reads.append((c.get("id", ""), name, args))
                elif name in ai.WRITE_TOOLS:
                    op = {"op": name, "args": args}
                    op["desc"] = ai.describe(op)
                    key = (name, json.dumps(args, ensure_ascii=False, sort_keys=True))
                    if key not in {(o["op"], json.dumps(o.get("args") or {}, ensure_ascii=False,
                                                        sort_keys=True)) for o in plan}:
                        plan.append(op)
                else:
                    unknown.append((c.get("id", ""), name))
            if plan:
                gaps = self.plan_check(plan)
                if not gaps or attempt == 2:
                    break
                msgs.append({"role": "assistant", "content": reply, "tool_calls": calls})
                # 写了不等于执行了：这里如实告诉模型「已记入计划、还没跑」，
                # 但协议要求每条 tool_call 都得有对应的 tool 消息，否则下一次请求直接 400。
                for c in calls:
                    msgs.append({"role": "tool", "tool_call_id": c.get("id", ""),
                                 "content": "这一步已记入待批准的计划，尚未执行。"})
                msgs.append({"role": "user", "content": (
                    "按你现在的计划执行，校验会报这些问题：\n- " + "\n- ".join(gaps)
                    + "\n请只补上还缺的步骤（比如给新加的需求项配一条 add_link，"
                      "注意用你前面计划的编号）；已经给过的步骤不要重复。")})
                reply = ""
                continue
            msgs.append({"role": "assistant", "content": reply, "tool_calls": calls})
            for cid, name, args in reads:
                try:
                    res = ai.run_read(self, name, args)
                except Exception as exc:  # noqa: BLE001
                    res = f"出错：{exc}"
                msgs.append({"role": "tool", "tool_call_id": cid, "content": res})
            for cid, name in unknown:
                # 每个 tool_call 都必须有回执，否则下一轮请求直接 400
                msgs.append({"role": "tool", "tool_call_id": cid,
                             "content": f"没有这个工具：{name}，没有执行。可用工具见系统提示。"})
            reply = ""
        if not (reply or "").strip():
            # 模型只回工具调用时 content 是空串，界面上会是一个空气泡。
            reply = ("这些改动我列成了下面的计划，你确认后我再执行。"
                     if plan else "模型这次没说话（只返回了空内容），再问一次试试。")
        return {"ok": True, "reply": reply, "plan": plan, "gaps": gaps}

    def ai_apply(self, ops: list[dict]) -> dict:
        graph_ops = [o for o in ops if (o.get("op") or o.get("tool")) != "export_pack"]
        exports = [o for o in ops if (o.get("op") or o.get("tool")) == "export_pack"]
        out: dict = {"ok": True, "applied": 0, "steps": []}
        if graph_ops:
            res = self.batch(graph_ops)
            out.update(applied=res["applied"], steps=res["steps"], changed=res["changed"])
            out["state"] = res["state"]
        for o in exports:
            rel = (o.get("args") or o).get("rel", "")
            try:
                out["export"] = self.export_pack(rel)
            except Exception as exc:  # noqa: BLE001
                # 图已经改好了：这里失败不能告诉用户「全撤销了」
                out["ok"] = False
                out["partial"] = True
                out["error"] = f"图已按计划改好，但导出失败：{exc}"
        if "state" not in out:
            out["state"] = self.snapshot()
        return out


# --------------------------------------------------------------------------- toml 文本

def _split_blocks(text: str) -> list[dict]:
    """按 `[[table]]` 切块，尽量原样保留（注释、空行）。"""
    blocks: list[dict] = []
    cur: list[str] = []
    kind = "head"
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith("[[") and stripped.endswith("]]"):
            if cur:
                blocks.append({"kind": kind, "raw": "".join(cur), "data": _unwrap(kind, _parse_toml("".join(cur)))})
            kind = stripped[2:-2].strip()
            cur = [line]
        else:
            cur.append(line)
    if cur:
        blocks.append({"kind": kind, "raw": "".join(cur), "data": _unwrap(kind, _parse_toml("".join(cur)))})
    return blocks


def _unwrap(kind: str, parsed: dict) -> dict:
    """把 `{"link": {...}}`（或 `{"link": [{...}]}`）拆回块自身的字段。"""
    if kind != "head" and isinstance(parsed, dict):
        v = parsed.get(kind)
        if isinstance(v, list) and v and isinstance(v[0], dict):
            return v[0]
        if isinstance(v, dict):
            return v
    return parsed


def _parse_toml(text: str) -> dict:
    try:
        import tomllib
        return tomllib.loads(text)
    except Exception:  # noqa: BLE001
        return {}


def _under(node: str, rel: str) -> bool:
    return node == rel or node.startswith(rel + "/")


def _link_blocks(text: str) -> list[dict]:
    out = []
    for b in _split_blocks(text):
        if b["kind"] == "link" and b["data"]:
            d = b["data"]
            out.append({
                "from": d.get("from", ""), "to": d.get("to", ""),
                "satisfies": [s for s in (d.get("satisfies") or []) if isinstance(s, dict)],
            })
    return out


# --------------------------------------------------------------------------- http

def _looks_like_project(p: Path) -> bool:
    """根目录没有 spec.md 也算项目：只要有 graph.toml，或任一子文件夹里有契约。"""
    if (p / GRAPH_FILE).is_file():
        return True
    for child in p.iterdir():
        if child.is_dir() and not child.name.startswith(".") and (child / SPEC_FILE).is_file():
            return True
    return False


# 给 CLI 用：判断一个文件夹是不是能直接打开的项目
looks_like_project = _looks_like_project


def open_project(path: str, create: bool = False) -> dict:
    """切换到一个项目文件夹。create=True 时允许新建空文件夹并写一份根契约。"""
    raw = (path or "").strip().strip('"')
    if not raw:
        raise ValueError("填一个文件夹路径")
    p = Path(raw).expanduser()
    if not p.is_absolute():
        raise ValueError("请填完整路径，比如 D:\\项目\\我的图")
    if create:
        if p.exists() and any(p.iterdir()) and not (p / SPEC_FILE).exists():
            raise ValueError("这个文件夹里已经有别的东西了，换一个空文件夹")
        try:
            p.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ValueError(f"建不了这个文件夹：{exc}") from exc
    if not p.is_dir():
        raise ValueError(f"没有这个文件夹：{p}")
    spec = p / SPEC_FILE
    if not spec.exists():
        if p.exists() and any(p.iterdir()):
            # 没有根契约也可能是合法项目：只要图里已经有节点（graph.toml 或某个子模块有合同）
            if _looks_like_project(p):
                pass
            elif create:
                raise ValueError("这个文件夹里已经有别的东西了，换一个空文件夹")
            else:
                raise ValueError("这不是一个规格图项目（没有 spec.md，也没有子模块契约）。要新建，请用「新建项目」")
        else:
            spec.write_text(EMPTY_PROJECT_SPEC.format(name=p.name), encoding="utf-8")
    Handler.workspace = Workspace(p)
    remember_project(p)
    if WINDOW is not None:
        try:
            WINDOW.title = f"规格图谱 · {p.name}"
        except Exception:
            pass
    return Handler.workspace.snapshot()


class Handler(BaseHTTPRequestHandler):
    server_version = "specgraph"
    workspace: Workspace  # 由 serve() 注入

    def log_message(self, fmt, *args):  # 安静点
        pass

    # -- 工具 -----------------------------------------------------------
    def _json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path) -> None:
        if not path.is_file():
            self.send_error(404)
            return
        types = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon"}
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", types.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _payload(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return {}

    # -- 路由 -----------------------------------------------------------
    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        if url.path == "/":
            return self._file(WEB_DIR / "index.html")
        if url.path.startswith("/api/"):
            return self._api(url.path[5:].strip("/"), {})
        rel = url.path.lstrip("/")
        target = (WEB_DIR / rel).resolve()
        if WEB_DIR in target.parents:
            return self._file(target)
        self.send_error(404)

    def do_POST(self):  # noqa: N802
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            self.send_error(404)
            return
        return self._api(url.path[5:].strip("/"), self._payload())

    def _api(self, name: str, data: dict):
        ws = self.workspace
        try:
            if name == "state":
                return self._json(ws.snapshot())
            if name == "project/recent":
                return self._json({"current": str(ws.root), "items": load_projects()})
            if name in ("project/open", "project/new"):
                snap = open_project(data.get("path", ""), create=(name == "project/new"))
                return self._json(snap)
            if name == "new":
                return self._json(ws.new_module(
                    data.get("name", ""), data.get("kind", "module"),
                    data.get("parent", ""), data.get("class_name", ""), data.get("file", ""),
                    data.get("type", ""),
                ))
            if name == "move":
                return self._json(ws.move(data.get("pos") or {}, data.get("view"), data.get("level") or ""))
            if name == "link/add":
                return self._json(ws.add_link(
                    data.get("from", ""), data.get("to", ""),
                    data.get("need", ""), data.get("expose", ""),
                ))
            if name == "link/del":
                return self._json(ws.del_link(
                    data.get("from", ""), data.get("to", ""),
                    data.get("need", ""), data.get("expose", ""),
                ))
            if name == "trash":
                return self._json(ws.trash_module(data.get("rel", "")))
            if name == "node/rename":
                return self._json(ws.rename_node(data.get("rel", ""), data.get("name", "")))
            if name == "tpl/new":
                return self._json(ws.new_from_template(
                    data.get("key", ""), data.get("name", ""), data.get("parent", "")))
            if name == "tpl/demo":
                return self._json(ws.create_demo(data.get("parent", "")))
            if name == "open":
                return self._json(ws.open_spec(data.get("rel", "")))
            if name == "spec/read":
                return self._json(ws.read_spec(data.get("rel", "")))
            if name == "item/save":
                return self._json(ws.save_item(
                    data.get("rel", ""), data.get("section", SEC_EXPOSES),
                    data.get("id", ""), data.get("title", ""),
                    data.get("fields") or [], data.get("body", ""),
                ))
            if name == "item/delete":
                return self._json(ws.delete_item(
                    data.get("rel", ""), data.get("section", SEC_EXPOSES), data.get("id", ""),
                ))
            if name == "item/move":
                return self._json(ws.move_item(
                    data.get("rel", ""), data.get("section", SEC_EXPOSES),
                    data.get("id", ""), int(data.get("delta", -1)),
                ))
            if name == "map/set":
                return self._json(ws.set_mapping(
                    data.get("rel", ""), data.get("item", ""),
                    data.get("child", ""), data.get("child_item", ""),
                ))
            if name == "map/clear":
                return self._json(ws.clear_mapping(data.get("rel", ""), data.get("item", "")))
            if name == "undo":
                return self._json(ws.undo())
            if name == "redo":
                return self._json(ws.redo())
            if name == "ref/add":
                return self._json(ws.add_ref(data.get("target", ""), data.get("module", "")))
            if name == "export":
                return self._json(ws.export_pack(data.get("rel", "")))
            if name == "export/preview":
                return self._json(ws.export_preview(data.get("rel", "")))
            if name == "reveal":
                return self._json(ws.reveal(data.get("path", "")))
            if name == "project/remove":
                return self._json({"ok": True, "items": remove_project(data.get("path", ""))})
            if name == "ai/config":
                cfg = ai.load_config()
                if "base_url" in data or "api_key" in data or "model" in data:
                    cfg = ai.save_config({**cfg, **{k: data[k] for k in ("base_url", "api_key", "model")
                                                    if k in data}})
                return self._json({"ok": True, "config": {**cfg, "api_key_set": bool(cfg.get("api_key"))}})
            if name == "ai/chat":
                return self._json(ws.ai_chat(data.get("messages") or [], data.get("level", "")))
            if name == "ai/apply":
                return self._json(ws.ai_apply(data.get("ops") or []))
            if name == "check":
                return self._json(ws.snapshot())
        except ValueError as exc:
            return self._json({"error": str(exc)}, 400)
        except Exception as exc:  # noqa: BLE001
            return self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)
        return self._json({"error": "unknown api"}, 404)


def serve(root: Path, port: int = 0, open_window: bool = True) -> None:
    global WINDOW
    ws = Workspace(root)
    Handler.workspace = ws
    remember_project(ws.root)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    print(f"specgraph app · {ws.root}")
    print(f"  {url}")
    if not open_window:
        print("  （--no-window：不弹窗，按 Ctrl+C 结束）")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        return

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    import webview  # 延迟导入：没有装也能用 --no-window

    WINDOW = webview.create_window(f"规格图谱 · {ws.root.name}", url, width=1440, height=900,
                                   min_size=(960, 640))
    try:
        webview.start()
    finally:
        httpd.shutdown()
