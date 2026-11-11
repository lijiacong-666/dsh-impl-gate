"""规格图谱 v0.1 · 模型与解析

核心约定（已锁定）：
- 节点 = 文件夹 + spec.md。只有这一种节点类型。
- spec.md = 文件头（可选元数据）+ 三段（提供 / 需要 / 约束）+ 可选（内部承接）。
- 图 = graph.toml，声明「谁可以访问谁」，并能勾选「用到了对方哪几条提供项」。
- 复用 = ref 指向项目外的模块文件夹，按内容哈希感知变更。
- 系统里没有代码。
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, field as dc_field
from pathlib import Path

SPEC_FILE = "spec.md"
GRAPH_FILE = "graph.toml"
WHITELIST_FILE = "_whitelist.toml"

SEC_EXPOSES = "提供"
SEC_NEEDS = "需要"
SEC_CONSTRAINTS = "约束"
SEC_MAP = "内部承接"

REQUIRED_SECTIONS = (SEC_EXPOSES, SEC_NEEDS, SEC_CONSTRAINTS)

SECTION_ALIASES = {
    "提供": SEC_EXPOSES, "提供项": SEC_EXPOSES, "暴露": SEC_EXPOSES, "暴露项": SEC_EXPOSES,
    "exposes": SEC_EXPOSES, "expose": SEC_EXPOSES, "provides": SEC_EXPOSES,
    "需要": SEC_NEEDS, "需求": SEC_NEEDS, "需求项": SEC_NEEDS, "needs": SEC_NEEDS, "need": SEC_NEEDS,
    "约束": SEC_CONSTRAINTS, "约束项": SEC_CONSTRAINTS, "constraints": SEC_CONSTRAINTS, "constraint": SEC_CONSTRAINTS,
    "内部承接": SEC_MAP, "承接": SEC_MAP, "映射": SEC_MAP, "mapping": SEC_MAP,
}

SECTION_PREFIX = {SEC_EXPOSES: "E", SEC_NEEDS: "N", SEC_CONSTRAINTS: "C", SEC_MAP: "M"}

# 节点类型：**只是给人看的标签**，不是数据结构，也不参与校验（写错只提醒，不拦）。
# 键必须是小写英文短名，值 = (中文名, 族)。族只用来配色和分组。
TYPES: dict[str, tuple[str, str]] = {
    "module": ("模块", "结构"),
    "controller": ("接口控制器", "接口"),
    "gateway": ("网关", "接口"),
    "middleware": ("中间件", "接口"),
    "external": ("外部服务", "接口"),
    "service": ("服务", "逻辑"),
    "orchestrator": ("编排器", "逻辑"),
    "handler": ("事件处理器", "逻辑"),
    "model": ("数据模型", "数据"),
    "dto": ("传输对象", "数据"),
    "table": ("数据表", "数据"),
    "view": ("视图", "数据"),
    "enum": ("枚举", "数据"),
    "repository": ("仓储", "数据"),
    "cache": ("缓存", "数据"),
    "ui": ("界面组件", "前端"),
    "frontend": ("前端应用", "前端"),
    "config": ("环境变量", "配置"),
    "exception": ("错误类型", "逻辑"),
}

TYPE_ALIASES = {
    "mod": "module", "svc": "service", "repo": "repository", "entity": "model",
    "apigateway": "gateway", "env": "config", "envvar": "config",
    "exceptiontype": "exception", "component": "ui", "frontendapp": "frontend",
    "queue": "handler", "messagequeue": "handler", "eventhandler": "handler",
    # 中文别名（写中文类型名也能认）
    "模块": "module", "控制器": "controller", "接口控制器": "controller",
    "网关": "gateway", "中间件": "middleware", "服务": "service",
    "编排器": "orchestrator", "事件处理器": "handler", "处理器": "handler",
    "数据模型": "model", "模型": "model", "传输对象": "dto", "数据表": "table",
    "表": "table", "视图": "view", "枚举": "enum", "仓储": "repository",
    "仓储层": "repository", "缓存": "cache", "界面组件": "ui", "组件": "ui",
    "前端应用": "frontend", "前端": "frontend", "环境变量": "config",
    "配置": "config", "错误类型": "exception", "异常": "exception",
    "外部服务": "external",
    "uicomponent": "ui", "externalservice": "external", "environmentvariable": "config",
}


def normalize_type(raw: str) -> str:
    """把用户写的类型名收敛到词表键；认不出来就原样返回（校验器只提醒，不拦）。"""
    t = (raw or "").strip().lower().replace("_", "").replace("-", "").replace(" ", "")
    if not t:
        return ""
    if t in TYPES:
        return t
    if t in TYPE_ALIASES:
        return TYPE_ALIASES[t]
    for k, (zh, _fam) in TYPES.items():
        if t == zh:
            return k
    return t  # 认不出来：调用方决定是提醒（读入）还是丢弃（创建）


def type_label(node_type: str) -> str:
    t = normalize_type(node_type)
    if t in TYPES:
        return TYPES[t][0]
    return node_type or "模块"


def type_family(node_type: str) -> str:
    t = normalize_type(node_type)
    return TYPES[t][1] if t in TYPES else "结构"

H2_RE = re.compile(r"^##\s+(?P<name>.+?)\s*$")
H3_RE = re.compile(r"^###\s+(?P<rest>.+?)\s*$")
ITEM_ID_RE = re.compile(r"^(?P<id>[A-Za-z][A-Za-z0-9_-]{0,7}\d+)\s+(?P<title>.+)$")
FIELD_RE = re.compile(r"^[-*]\s*(?P<key>[^：:\s]{1,16})\s*[：:]\s*(?P<val>.*)$")
MAP_RE = re.compile(
    r"^[-*]\s*(?P<parent>[A-Za-z][A-Za-z0-9_-]*\d+)\s*(?:→|->|=>)\s*(?P<child>[^:：]+?)\s*[:：]\s*(?P<child_item>[A-Za-z][A-Za-z0-9_-]*\d+)\s*$"
)
SELF_RE = re.compile(
    r"^[-*]\s*(?P<parent>[A-Za-z][A-Za-z0-9_-]*\d+)\s*(?:→|->|=>)\s*(?:自实现|本模块自己实现|自身)\s*$"
)
FM_RE = re.compile(r"^\s*(?P<key>[A-Za-z_][\w-]*)\s*[：:]\s*(?P<val>.*?)\s*$")


# --------------------------------------------------------------------------- 基础结构


@dataclass
class SpecProblem:
    code: str
    level: str          # error | warning | info
    message: str
    fix: str
    line: int = 0


@dataclass
class Item:
    id: str
    title: str
    fields: dict[str, str]
    body: str
    line: int
    end_line: int
    section: str

    def text(self) -> str:
        parts = [f"{self.id} {self.title}"]
        for k, v in self.fields.items():
            parts.append(f"{k}：{v}")
        if self.body.strip():
            parts.append(self.body.strip())
        return "\n".join(parts)


@dataclass
class Mapping:
    parent_item: str
    child_rel: str
    child_item: str
    line: int


@dataclass
class Spec:
    path: Path
    rel: str                     # 正斜杠相对路径（模块唯一标识）
    kind: str = "module"         # module | class
    name: str = ""
    class_name: str = ""
    file_hint: str = ""          # 类级节点的定位字段（不算说明书正文）
    status: str = ""
    node_type: str = ""          # 纯展示的类型标签（见 TYPES），不参与校验

    def type_label(self) -> str:
        if not self.node_type and self.kind == "class":
            return "类级"
        return type_label(self.node_type or "module")

    def type_family(self) -> str:
        return type_family(self.node_type or "module")
    fm: dict[str, str] = dc_field(default_factory=dict)
    items: dict[str, list[Item]] = dc_field(default_factory=dict)
    mapping: list[Mapping] = dc_field(default_factory=list)
    has_map_section: bool = False
    raw: str = ""
    fm_end_line: int = 0         # 文件头结束行（1 基）；0 表示没有文件头
    problems: list[SpecProblem] = dc_field(default_factory=list)

    def exposes(self) -> list[Item]:
        return self.items.get(SEC_EXPOSES, [])

    def needs(self) -> list[Item]:
        return self.items.get(SEC_NEEDS, [])

    def constraints(self) -> list[Item]:
        return self.items.get(SEC_CONSTRAINTS, [])

    def find(self, section: str, item_id: str) -> Item | None:
        for it in self.items.get(section, []):
            if it.id == item_id:
                return it
        return None

    def items_with_lines(self):
        """按行号排序的 (item) 列表，供按行定位。"""
        out = []
        for items in self.items.values():
            out.extend(items)
        return sorted(out, key=lambda i: i.line)

    def item_at(self, line: int) -> Item | None:
        for it in self.items_with_lines():
            if it.line <= line <= it.end_line:
                return it
        return None

    @property
    def label(self) -> str:
        if self.kind == "class" and self.class_name:
            return f"{self.rel}（类 {self.class_name}）"
        return self.rel


@dataclass
class Satisfy:
    need: str
    expose: str


@dataclass
class Link:
    src: str
    dst: str
    satisfies: list[Satisfy] = dc_field(default_factory=list)


@dataclass
class Ref:
    module: str
    target: str
    pinned_hash: str = ""


@dataclass
class Project:
    root: Path
    specs: dict[str, Spec] = dc_field(default_factory=dict)
    externals: dict[str, Spec] = dc_field(default_factory=dict)
    links: list[Link] = dc_field(default_factory=list)
    refs: list[Ref] = dc_field(default_factory=list)
    problems: list[SpecProblem] = dc_field(default_factory=list)

    def all_specs(self) -> dict[str, Spec]:
        merged = dict(self.externals)
        merged.update(self.specs)
        return merged

    def lookup(self, rel: str) -> Spec | None:
        key = normalize_rel(rel)
        return self.specs.get(key) or self.externals.get(key)


# --------------------------------------------------------------------------- 工具


def normalize_rel(rel: str) -> str:
    rel = rel.replace("\\", "/").strip()
    while rel.startswith("./"):
        rel = rel[2:]
    return rel.rstrip("/")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def kind_of_dir(path: Path) -> bool:
    return (path / SPEC_FILE).is_file()


# --------------------------------------------------------------------------- 解析 spec.md


def _assign_ids(spec: Spec, section: str, needed: int) -> None:
    prefix = SECTION_PREFIX.get(section, "X")
    existing = {it.id for its in spec.items.values() for it in its}
    n = 1
    for line_no, item in needed:
        while f"{prefix}{n}" in existing:
            n += 1
        item.id = f"{prefix}{n}"
        existing.add(item.id)


def _read_spec_text(path: Path) -> tuple[str, str]:
    """读契约正文。返回 (文本, 编码问题说明)。

    记事本存成 ANSI(GBK) 的 spec.md 很常见：直接按 UTF-8 读会抛 UnicodeDecodeError，
    而它又是 ValueError 的子类——整个项目会因此打不开、所有接口一起 400。
    这里做一次退让：UTF-8 → GBK → 带替换符的 UTF-8，并把问题写进校验报告。
    """
    data = path.read_bytes()
    for enc in ("utf-8-sig", "gbk"):
        try:
            return data.decode(enc), ""
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace"), "这段契约不是 UTF-8 编码，已按容错方式读取，请另存为 UTF-8。"


def parse_spec(path: Path, rel: str) -> Spec:
    spec = Spec(path=path, rel=rel)
    raw, enc_note = _read_spec_text(path)
    spec.raw = raw
    lines = raw.splitlines()
    if enc_note:
        spec.problems.append(SpecProblem(
            "SPEC_ENCODING", "warning", enc_note,
            "用编辑器另存为 UTF-8 即可。", 1,
        ))

    i = 0
    fm: dict[str, str] = {}
    if lines and lines[0].strip() == "---":
        j = 1
        while j < len(lines) and lines[j].strip() != "---":
            m = FM_RE.match(lines[j])
            if m:
                fm[m.group("key").lower()] = m.group("val").strip()
            j += 1
        if j >= len(lines):
            spec.problems.append(SpecProblem(
                "FRONTMATTER_UNCLOSED", "error",
                "文件头以 --- 开始但没有闭合。",
                "补一行 --- 结束文件头。", 1,
            ))
        else:
            i = j + 1
            spec.fm_end_line = j + 1
    spec.fm = fm
    spec.kind = (fm.get("kind") or "module").strip().lower()
    if spec.kind not in ("module", "class"):
        spec.problems.append(SpecProblem(
            "KIND_UNKNOWN", "error",
            f"kind 只能是 module 或 class，当前是 {spec.kind!r}。",
            "把 kind 改成 module（模块）或 class（类级节点）。", spec.fm_end_line,
        ))
        spec.kind = "module"
    spec.name = (fm.get("name") or Path(rel).name).strip()
    spec.class_name = (fm.get("class") or "").strip()
    spec.file_hint = (fm.get("file") or "").strip()
    spec.status = (fm.get("status") or "").strip()

    raw_type = (fm.get("type") or "").strip()
    if raw_type:
        spec.node_type = normalize_type(raw_type)
        if spec.node_type not in TYPES:
            allowed = "、".join(TYPES[k][0] for k in TYPES)
            spec.problems.append(SpecProblem(
                "TYPE_UNKNOWN", "warning",
                f"节点类型 {raw_type!r} 不在词表里。类型只是给人看的标签，不影响校验；"
                f"内置的有：{allowed}。",
                "改成上面任意一种，或忽略这条提醒——自定义类型也能用，只是画布上按默认样式显示。",
                spec.fm_end_line,
            ))

    section: str | None = None
    section_lines: dict[str, int] = {}
    cur_item: Item | None = None
    cur_buf: list[tuple[int, str]] = []
    pending: list[tuple[int, Item]] = []   # 需要自动编号的条目

    def flush_item() -> None:
        nonlocal cur_item, cur_buf
        if cur_item is None:
            cur_buf = []
            return
        fields: dict[str, str] = {}
        body_lines: list[str] = []
        last_key: str | None = None
        for ln, text in cur_buf:
            m = FIELD_RE.match(text)
            if m:
                key = m.group("key").strip()
                val = m.group("val").strip()
                if key in fields:
                    fields[key] += " " + val
                else:
                    fields[key] = val
                last_key = key
            elif text.startswith((" ", "\t")) and last_key and last_key in fields:
                fields[last_key] += " " + text.strip()
            else:
                body_lines.append(text)
                last_key = None
        cur_item.fields = fields
        cur_item.body = "\n".join(body_lines).strip()
        cur_item.end_line = cur_buf[-1][0] if cur_buf else cur_item.line
        cur_item = None
        cur_buf = []

    for idx in range(i, len(lines)):
        line = lines[idx]
        ln = idx + 1
        m2 = H2_RE.match(line)
        if m2:
            flush_item()
            name = m2.group("name").strip().rstrip("#").strip()
            key = SECTION_ALIASES.get(name.lower(), SECTION_ALIASES.get(name))
            if key is None:
                spec.problems.append(SpecProblem(
                    "SECTION_UNKNOWN", "warning",
                    f"未知段落「{name}」，不参与校验。",
                    "如需保留说明文字，改成「## 备注」；否则删除。", ln,
                ))
                section = None
                continue
            section = key
            section_lines.setdefault(section, ln)
            if key == SEC_MAP:
                spec.has_map_section = True
            continue

        m3 = H3_RE.match(line)
        if m3:
            flush_item()
            if section is None:
                continue
            rest = m3.group("rest").strip()
            mid = ITEM_ID_RE.match(rest)
            if mid:
                item = Item(id=mid.group("id"), title=mid.group("title").strip(),
                            fields={}, body="", line=ln, end_line=ln, section=section)
            else:
                item = Item(id="", title=rest, fields={}, body="",
                            line=ln, end_line=ln, section=section)
                pending.append((ln, item))
            spec.items.setdefault(section, []).append(item)
            cur_item = item
            cur_buf = []
            continue

        if cur_item is not None:
            cur_buf.append((ln, line))
        elif section == SEC_MAP:
            mm = MAP_RE.match(line)
            ms = SELF_RE.match(line)
            if mm:
                spec.mapping.append(Mapping(
                    parent_item=mm.group("parent"), child_rel=mm.group("child").strip(),
                    child_item=mm.group("child_item"), line=ln,
                ))
            elif ms:
                spec.mapping.append(Mapping(
                    parent_item=ms.group("parent"), child_rel="", child_item="", line=ln,
                ))

    flush_item()

    # 自动编号 + 缺 ID 提示
    for section_name, items in spec.items.items():
        missing = [(it.line, it) for it in items if not it.id]
        if missing:
            _assign_ids(spec, section_name, missing)
            for ln, it in missing:
                spec.problems.append(SpecProblem(
                    "ITEM_ID_MISSING", "warning",
                    f"条目「{it.title}」没有编号，已自动编为 {it.id}。",
                    f"建议显式写成「### {it.id} {it.title}」，编号稳定后连线与引用才不会断。", ln,
                ))

    # 三段齐全
    for sec in REQUIRED_SECTIONS:
        if sec not in spec.items and sec not in section_lines:
            spec.problems.append(SpecProblem(
                "SECTION_MISSING", "error",
                f"缺少「## {sec}」段落。三段式缺一段即不合法。",
                f"补上「## {sec}」段落；确实没有内容时也保留标题并写「（无）」。", 0,
            ))

    # 同一段内重复编号
    for sec, items in spec.items.items():
        seen: dict[str, Item] = {}
        for it in items:
            if it.id in seen:
                spec.problems.append(SpecProblem(
                    "ITEM_DUPLICATE", "error",
                    f"「{sec}」里编号 {it.id} 出现了两次：{seen[it.id].title} / {it.title}。",
                    "给其中一个换编号，连线是按编号指的。", it.line,
                ))
            else:
                seen[it.id] = it

    # 类级节点必须指明类
    if spec.kind == "class" and not spec.class_name:
        spec.problems.append(SpecProblem(
            "CLASS_NAME_MISSING", "error",
            "类级节点（kind: class）必须在文件头写 class: 类名。",
            "在文件头加一行 class: 你的类名。", spec.fm_end_line,
        ))
    return spec


# --------------------------------------------------------------------------- 项目加载


def load_graph(path: Path) -> tuple[list[Link], list[Ref], list[SpecProblem]]:
    problems: list[SpecProblem] = []
    links: list[Link] = []
    refs: list[Ref] = []
    if not path.is_file():
        problems.append(SpecProblem(
            "GRAPH_MISSING", "warning",
            "没有找到 graph.toml，本次按「所有模块之间都没有连线」校验。",
            "在项目根目录建 graph.toml，用 [[link]] 声明可访问关系。", 0,
        ))
        return links, refs, problems
    try:
        import tomllib
        data = tomllib.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:  # noqa: BLE001
        problems.append(SpecProblem(
            "GRAPH_PARSE", "error", f"graph.toml 解析失败：{exc}",
            "检查 TOML 语法（字符串要加引号，数组用 [ ]）。", 0,
        ))
        return links, refs, problems

    raw_links = data.get("link") or data.get("links") or []
    if isinstance(raw_links, dict):
        raw_links = [raw_links]
    for rl in raw_links:
        if not isinstance(rl, dict):
            problems.append(SpecProblem(
                "GRAPH_PARSE", "error", "[[link]] 必须是一个表。", "用 [[link]] 而不是 link = ...", 0))
            continue
        src = normalize_rel(str(rl.get("from") or rl.get("src") or ""))
        dst = normalize_rel(str(rl.get("to") or rl.get("dst") or ""))
        sat = []
        for s in rl.get("satisfies") or []:
            if isinstance(s, dict):
                sat.append(Satisfy(need=str(s.get("need") or "").strip(),
                                   expose=str(s.get("expose") or "").strip()))
            else:
                problems.append(SpecProblem(
                    "GRAPH_PARSE", "error",
                    "satisfies 的每一项要写成 { need = \"N1\", expose = \"E1\" }。",
                    "改成内联表形式。", 0))
        links.append(Link(src=src, dst=dst, satisfies=sat))
        if str(rl.get("purpose") or "").strip():
            problems.append(SpecProblem(
                "LINK_PURPOSE_IGNORED", "warning",
                "[[link]] 里的 purpose 已不再使用：连线只表示「可以访问」，不解释用途、"
                "不是调用理由、不是数据流。",
                "删掉 purpose；真要说明用了对方什么，写进 satisfies 并精确到条目。", 0,
            ))

    raw_refs = data.get("ref") or data.get("refs") or []
    if isinstance(raw_refs, dict):
        raw_refs = [raw_refs]
    for rr in raw_refs:
        if not isinstance(rr, dict):
            problems.append(SpecProblem(
                "GRAPH_PARSE", "error", "[[ref]] 必须是一个表。", "用 [[ref]] 而不是 ref = ...", 0))
            continue
        refs.append(Ref(module=normalize_rel(str(rr.get("module") or "")),
                        target=normalize_rel(str(rr.get("target") or "")),
                        pinned_hash=str(rr.get("pinned_hash") or "").strip()))
    return links, refs, problems


def load_project(root: Path) -> Project:
    root = root.resolve()
    project = Project(root=root)
    if not root.is_dir():
        project.problems.append(SpecProblem(
            "ROOT_MISSING", "error", f"目录不存在：{root}", "检查路径。", 0))
        return project

    skip = {"__pycache__", "node_modules", ".git", ".venv", "venv", "dist", "build"}

    # 根目录自己有说明书时，它就是顶层模块，标识为 "."
    if (root / SPEC_FILE).is_file():
        project.specs["."] = parse_spec(root / SPEC_FILE, ".")

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in skip and not d.startswith("."))
        d = Path(dirpath)
        if d == root:
            continue
        if SPEC_FILE in filenames:
            rel = normalize_rel(d.relative_to(root).as_posix())
            project.specs[rel] = parse_spec(d / SPEC_FILE, rel)

    # 祖先目录也必须是模块
    for rel in list(project.specs):
        parts = rel.split("/")
        for k in range(1, len(parts)):
            anc = "/".join(parts[:k])
            if anc not in project.specs:
                project.problems.append(SpecProblem(
                    "CONTAINER_DIR", "error",
                    f"目录「{anc}」下面有模块（{rel}），但它自己不是模块（没有 {SPEC_FILE}）。",
                    f"给「{anc}」补一份 {SPEC_FILE}，或把下层模块挪到已有模块里。", 0,
                ))

    # 类级节点不能再有子模块
    for rel, spec in project.specs.items():
        if spec.kind != "class":
            continue
        for other in project.specs:
            if other.startswith(rel + "/"):
                project.problems.append(SpecProblem(
                    "CLASS_HAS_CHILDREN", "error",
                    f"类级节点「{rel}」下面还有子模块「{other}」。类是最小粒度，不能再展开。",
                    "把子内容并进类的说明书，或把这些内容提升为模块。", 0,
                ))

    links, refs, graph_problems = load_graph(root / GRAPH_FILE)
    project.links = links
    project.refs = refs
    project.problems.extend(graph_problems)

    # 外部引用模块
    for ref in refs:
        target_dir = resolve_target(root, ref.target)
        spec_path = target_dir / SPEC_FILE
        if not ref.target or not spec_path.is_file():
            continue  # 由校验器报 REF_MISSING
        if ref.target in project.specs:
            continue
        try:
            project.externals[ref.target] = parse_spec(spec_path, ref.target)
        except OSError:
            continue
    return project


SKIP_DIRS = {"__pycache__", "node_modules", ".git", ".venv", "venv", "dist", "build"}


@dataclass
class RefUse:
    """一处"某图引用某契约"的记录，用来回答"这个契约被谁用着"。"""

    graph_root: Path
    module: str
    target: str
    target_dir: Path
    pinned: str
    state: str  # ok / changed / missing / unpinned


def resolve_target(graph_root: Path, target: str) -> Path:
    """把 [[ref]] 的 target 解析成目录：相对路径按图的根解析，绝对路径原样使用。"""
    if not target:
        return graph_root
    p = Path(target)
    return (p if p.is_absolute() else graph_root / p).resolve()


def audit_refs(graph_root: Path) -> list[RefUse]:
    """读一个图的 [[ref]]，解析目标并判断当前状态（不加载整张图）。"""
    _, refs, problems = load_graph(graph_root / GRAPH_FILE)
    if any(p.code == "GRAPH_PARSE" for p in problems):
        return []
    uses: list[RefUse] = []
    for ref in refs:
        target_dir = resolve_target(graph_root, ref.target)
        spec_path = target_dir / SPEC_FILE
        if not ref.target:
            continue
        if not spec_path.is_file():
            state = "missing"
        elif not ref.pinned_hash:
            state = "unpinned"
        elif sha256_file(spec_path) == ref.pinned_hash:
            state = "ok"
        else:
            state = "changed"
        uses.append(RefUse(graph_root, ref.module, ref.target, target_dir, ref.pinned_hash, state))
    return uses


def find_graphs(base: Path) -> list[Path]:
    """在 base 下找出所有图（含 graph.toml 的目录）。"""
    base = base.resolve()
    found: list[Path] = []
    if not base.is_dir():
        return found
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        if GRAPH_FILE in filenames:
            found.append(Path(dirpath))
    return found


def load_whitelist(root: Path) -> tuple[str, ...]:
    path = root / WHITELIST_FILE
    if not path.is_file():
        return ()
    try:
        import tomllib
        data = tomllib.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:  # noqa: BLE001
        return ()
    words = data.get("allowed_terms") or data.get("allowed") or []
    if isinstance(words, str):
        words = [words]
    return tuple(str(w) for w in words if str(w).strip())