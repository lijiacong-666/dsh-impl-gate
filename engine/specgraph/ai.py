"""AI 助手：把用户的话变成对图谱的一串操作。

边界（和三条铁律一致）：
- 助手只改契约与连线，不生成代码，也不把代码写回图谱。
- 所有写操作先变成「计划」，用户点了执行才落盘；执行失败整批回滚。
- 只读工具（看图、校验、模板）可以立刻执行，不改任何文件。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

CONFIG_FILE = Path.home() / ".specgraph" / "ai.json"

DEFAULTS = {
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "api_key": "",
}

SYSTEM = """你是「规格图谱」这个应用的助手。用户用中文说需求，你把需求变成对图谱的改动。

图的数据模型（不能发明新概念）：
- 一个模块 = 一个文件夹 + 一份 spec.md，页面上的每张卡片就是一个模块。
- spec.md 固定三段：「## 提供」对外能给什么、「## 需要」依赖外面什么、「## 约束」任何实现都必须满足的规则。
- 条目写成 `### E1 标题`，下面跟 `- 名称：…`、`- 语义：…`、`- 约束：…` 这样的字段行。提供项用 E，需求项用 N，约束项用 C。
- 连线只有一个含义：A 的某条需求项，由 B 的某条提供项满足。每条需求恰好一条连线；不是调用、不是数据流。

工具用法：
- 动手前先用 inspect_graph 看清现状（有哪些模块、条目 id、已经连了哪些线）。
- 写条目的 item 字段：新增就留空，系统会分配 E2/N3/C1 这种编号；改已有的才填。
- **新增「需要」条目时，必须在同一份计划里给它连线**：先想好它会拿到哪个编号（比如这个模块已有 N1、N2，那新条目就是 N3），write_item 的 item 直接填 "N3"，再配一条 add_link（from=本模块, need="N3", to=提供方, expose=提供方编号）。只加需求不连线，图就会报「需求未满足」。
- 改名用 rename_node，不要新建再删旧。
- 删模块用 trash_module（进回收站，可撤销）。
- 一次给完整计划，不要只给一步。计划里每一步都必须是工具调用。
- 不要臆造不存在的模块或条目 id；不确定就先 inspect_graph。
- 给了计划也要说一句话：准备怎么改、为什么。

说话方式：中文，短句，别用代码块，别解释工具怎么用。改完之后用一两句话说明你改了什么、还差什么（比如哪条需求还没接上）。"""

CHAT_PATH = "/chat/completions"

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "inspect_graph",
            "description": "看当前图：模块清单、每个模块的提供/需要/约束条目、已有连线、校验错误、可用模板。动手前先看。",
            "parameters": {
                "type": "object",
                "properties": {
                    "level": {"type": "string", "description": "只看某个模块的详情（模块标识，如 订单服务 或 对账/日切水位）；留空看全图"}
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_graph",
            "description": "跑一遍校验，返回错误与提醒。改完用它确认。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_templates",
            "description": "列出模块库里的模板（用户信息、身份校验、名单服务、信息过滤），可用来快速铺底。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_module",
            "description": "新建一个模块或类级节点，会在磁盘上建文件夹和 spec.md。",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "模块名，同一个父模块下不能重名"},
                    "type": {"type": "string", "description": "类型：module/controller/gateway/middleware/service/orchestrator/handler/model/dto/table/view/enum/repository/cache/ui/frontend/config/external/exception"},
                    "parent": {"type": "string", "description": "父模块标识；放顶层留空"},
                    "kind": {"type": "string", "description": "module 或 class；建类级节点时用 class"},
                    "class_name": {"type": "string", "description": "kind=class 时的类名"},
                    "file": {"type": "string", "description": "kind=class 时类所在的文件（仅供定位，不写进正文）"},
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_item",
            "description": "写一条契约条目（新增或改写）。新增时 item 留空。",
            "parameters": {
                "type": "object",
                "properties": {
                    "rel": {"type": "string", "description": "模块标识（顶层模块直接写名字，如 订单服务）"},
                    "section": {"type": "string", "description": "提供 / 需要 / 约束"},
                    "item": {"type": "string", "description": "已有条目 id（E1/N2/C1）；新增留空"},
                    "title": {"type": "string", "description": "条目标题，短名词"},
                    "fields": {"type": "object", "description": "字段行，常用键：名称/语义/约束"},
                    "body": {"type": "string", "description": "补充说明，可空"},
                },
                "required": ["rel", "section", "title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_item",
            "description": "删除一条契约条目。删需求项会让指向它的连线一起消失，谨慎。",
            "parameters": {
                "type": "object",
                "properties": {
                    "rel": {"type": "string"},
                    "section": {"type": "string"},
                    "item": {"type": "string"},
                },
                "required": ["rel", "section", "item"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_link",
            "description": "连一条线：from 的某条需求项，由 to 的某条提供项满足。",
            "parameters": {
                "type": "object",
                "properties": {
                    "from": {"type": "string", "description": "需求方模块标识"},
                    "to": {"type": "string", "description": "提供方模块标识"},
                    "need": {"type": "string", "description": "需求项 id，如 N1"},
                    "expose": {"type": "string", "description": "提供项 id，如 E1"},
                },
                "required": ["from", "to", "need", "expose"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remove_link",
            "description": "删掉一条连线。",
            "parameters": {
                "type": "object",
                "properties": {
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                    "need": {"type": "string"},
                    "expose": {"type": "string"},
                },
                "required": ["from", "to", "need"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_mapping",
            "description": "设置父模块某条提供项由哪个子模块承接；child 留空表示「本模块自实现」。",
            "parameters": {
                "type": "object",
                "properties": {
                    "rel": {"type": "string"},
                    "item": {"type": "string"},
                    "child": {"type": "string", "description": "子模块名（相对本模块），留空=自实现"},
                    "child_item": {"type": "string", "description": "子模块的提供项 id"},
                },
                "required": ["rel", "item"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "trash_module",
            "description": "把一个模块挪进项目的回收站（连线一并消失，可撤销）。用户说要删模块时用它。",
            "parameters": {
                "type": "object",
                "properties": {
                    "rel": {"type": "string", "description": "模块标识"},
                },
                "required": ["rel"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rename_node",
            "description": "给模块改名：文件夹、graph.toml 里指向它的连线、画布坐标会一起改。不要用「新建一个再删掉旧的」来改名。",
            "parameters": {
                "type": "object",
                "properties": {
                    "rel": {"type": "string", "description": "要改名的模块标识，如 用户信息 或 对账/日切水位"},
                    "name": {"type": "string", "description": "新名字（只改这一层，不带父路径）"},
                },
                "required": ["rel", "name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "export_pack",
            "description": "导出实现指令包（只含契约）。rel 留空导出整图。",
            "parameters": {
                "type": "object",
                "properties": {"rel": {"type": "string"}},
            },
        },
    },
]

READ_ONLY = {"inspect_graph", "check_graph", "list_templates"}
WRITE_TOOLS = {"create_module", "write_item", "delete_item", "add_link", "remove_link",
               "set_mapping", "rename_node", "trash_module", "export_pack"}


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    try:
        raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            cfg.update({k: str(v) for k, v in raw.items() if k in DEFAULTS})
    except (OSError, ValueError):
        pass
    return cfg


def save_config(cfg: dict) -> dict:
    out = {k: str(cfg.get(k, DEFAULTS[k])) for k in DEFAULTS}
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def graph_summary(ws, level: str = "") -> str:
    """给模型看的紧凑摘要：够它做判断，又不至于把上下文撑爆。"""
    st = ws.snapshot()
    nodes = st.get("nodes", [])
    by_id = {n["id"]: n for n in nodes}
    lines: list[str] = []

    def one(n) -> str:
        head = f"- 「{n['id']}」{n.get('name', '')}（{n.get('type_label') or n.get('kind')}"
        if n.get("external"):
            head += "，外部引用"
        head += "）"
        out = [head]
        for label, key, prefix in (("提供", "exposes", "E"), ("需要", "needs", "N"), ("约束", "constraints", "C")):
            items = n.get(key) or []
            if items:
                body = "；".join(f"{i['id']} {i.get('title', '')}" for i in items)
                out.append(f"    {label}：{body}")
        return "\n".join(out)

    if level:
        n = by_id.get(level)
        if n:
            lines.append(one(n))
        for k in nodes:
            if k.get("parent") == level:
                lines.append(one(k))
    else:
        for n in nodes:
            if n.get("external"):
                continue
            lines.append(one(n))

    links = st.get("links", [])
    if links:
        lines.append("")
        lines.append("已有连线：")
        for l in links:
            for s in l.get("satisfies", []):
                lines.append(f"- 「{l['from']}」{s.get('need', '')} ← 「{l['to']}」{s.get('expose', '')}")

    issues = [i for i in st.get("issues", []) if i.get("level") == "error"]
    if issues:
        lines.append("")
        lines.append("当前错误：")
        for i in issues[:20]:
            lines.append(f"- [{i.get('code')}] {i.get('node') or ''} {i.get('message')}")

    lines.append("")
    lines.append("可用模板：" + "、".join(t["name"] for t in st.get("library", [])))
    lines.append(f"当前项目：{st.get('project')}；根目录有契约：{'是' if '.' in by_id else '否'}")
    return "\n".join(lines)


def run_read(ws, name: str, args: dict) -> str:
    if name == "inspect_graph":
        return graph_summary(ws, str(args.get("level", "")))
    if name == "check_graph":
        st = ws.snapshot()
        errs = [i for i in st.get("issues", []) if i.get("level") == "error"]
        if not errs:
            return "校验通过，没有错误。"
        return "\n".join(f"[{i.get('code')}] {i.get('node') or ''} {i.get('message')}" for i in errs[:30])
    if name == "list_templates":
        st = ws.snapshot()
        return "\n".join(f"- {t['key']}：{t['name']}（{t['type_label']}）{t['blurb']}"
                         for t in st.get("library", []))
    raise ValueError(f"不是只读工具：{name}")


def _post(cfg: dict, payload: dict, timeout: int = 90) -> dict:
    url = cfg["base_url"].rstrip("/") + CHAT_PATH
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cfg['api_key']}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise ValueError(f"模型返回 {exc.code}：{detail}") from exc
    except urllib.error.URLError as exc:
        raise ValueError(f"连不上模型服务：{exc.reason}") from exc


def complete(cfg: dict, messages: list[dict]) -> dict:
    """调一次模型；返回 {content, tool_calls}。"""
    if not cfg.get("api_key"):
        raise ValueError("还没填 API Key：点右上角「助手设置」，填 DeepSeek 的 Key。")
    data = _post(cfg, {
        "model": cfg["model"],
        "messages": [{"role": "system", "content": SYSTEM}] + messages,
        "tools": TOOLS,
        "tool_choice": "auto",
        "temperature": 0.2,
    })
    choices = data.get("choices") or []
    if not choices:
        raise ValueError(f"模型没有返回结果：{json.dumps(data, ensure_ascii=False)[:300]}")
    msg = choices[0].get("message") or {}
    return {
        "content": (msg.get("content") or "").strip(),
        "tool_calls": msg.get("tool_calls") or [],
    }


def describe(op: dict) -> str:
    kind = op.get("op")
    a = op.get("args") or {}
    if kind == "create_module":
        return f"新建模块「{a.get('name', '')}」" + (f"（类型 {a.get('type')}）" if a.get("type") else "")
    if kind == "write_item":
        return f"写「{a.get('rel', '')}」的{a.get('section', '')}条目「{a.get('title', '')}」"
    if kind == "delete_item":
        return f"删除「{a.get('rel', '')}」的 {a.get('item', '')}"
    if kind == "add_link":
        return f"连线 {a.get('from', '')}.{a.get('need', '')} → {a.get('to', '')}.{a.get('expose', '')}"
    if kind == "remove_link":
        return f"删线 {a.get('from', '')}.{a.get('need', '')} → {a.get('to', '')}"
    if kind == "set_mapping":
        return f"「{a.get('rel', '')}」{a.get('item', '')} 的承接改为 {a.get('child') or '自实现'}"
    if kind == "rename_node":
        return f"把「{a.get('rel', '')}」改名为「{a.get('name', '')}」"
    if kind == "trash_module":
        return f"把「{a.get('rel', '')}」挪进回收站（可撤销）"
    if kind == "export_pack":
        return f"导出指令包（{a.get('rel') or '整图'}）"
    return kind or "?"