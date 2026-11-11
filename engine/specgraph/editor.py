"""就地改契约：只在 spec.md 的某一段里动条目，别的地方一个字节都不碰。

界面上的「加一条需求」「改语义」「删掉这条约束」都走这里。
这一层只管文本；合法不合法交给校验器，改完再跑一遍就知道。
"""

from __future__ import annotations

import re

from .model import (
    FIELD_RE,
    ITEM_ID_RE,
    SEC_CONSTRAINTS,
    SEC_EXPOSES,
    SEC_MAP,
    SEC_NEEDS,
    SECTION_ALIASES,
    SECTION_PREFIX,
)

SECTIONS = (SEC_EXPOSES, SEC_NEEDS, SEC_CONSTRAINTS)


def canonical_heading(line: str) -> str | None:
    """`## 提供` / `## exposes` → `提供`；不是二级标题就返回 None。"""
    if not line.startswith("## "):
        return None
    name = line[3:].strip().rstrip("#").strip()
    return SECTION_ALIASES.get(name)


def _lines(text: str) -> list[str]:
    return text.splitlines()


def _join(lines: list[str]) -> str:
    return "\n".join(lines) + ("\n" if lines else "")


def _section_bounds(lines: list[str], section: str) -> tuple[int, int]:
    """返回 (段内第一行, 段结束行)；段不存在抛 ValueError。"""
    start = None
    for i, line in enumerate(lines):
        head = canonical_heading(line)
        if start is None:
            if head == section:
                start = i + 1
        elif head is not None:
            return start, i
    if start is None:
        raise ValueError(f"说明书里没有「## {section}」这一段")
    return start, len(lines)


H3_RE = re.compile(r"^###\s+(?P<rest>.+?)\s*$")


def item_ranges(text: str, section: str) -> list[dict]:
    """列出某一段里的条目：id / 标题 / 行范围 / 字段 / 正文。"""
    lines = _lines(text)
    start, end = _section_bounds(lines, section)
    out: list[dict] = []
    i = start
    while i < end:
        h3 = H3_RE.match(lines[i])
        m = ITEM_ID_RE.match(h3.group("rest")) if h3 else None
        if not m:
            i += 1
            continue
        j = i + 1
        while j < end and not H3_RE.match(lines[j]):
            j += 1
        block = lines[i + 1:j]
        fields: list[tuple[str, str]] = []
        body: list[str] = []
        for raw in block:
            fm = FIELD_RE.match(raw)
            if fm:
                fields.append((fm.group(1).strip(), fm.group(2).strip()))
            else:
                body.append(raw)
        while body and not body[0].strip():
            body.pop(0)
        while body and not body[-1].strip():
            body.pop()
        out.append({
            "id": m.group(1),
            "title": m.group(2).strip() if m.lastindex and m.lastindex >= 2 else "",
            "start": i,
            "end": j,
            "fields": fields,
            "body": "\n".join(body),
        })
        i = j
    return out


def next_item_id(text: str, section: str) -> str:
    prefix = SECTION_PREFIX[section]
    nums = []
    for it in item_ranges(text, section):
        m = re.fullmatch(re.escape(prefix) + r"(\d+)", it["id"])
        if m:
            nums.append(int(m.group(1)))
    return f"{prefix}{max(nums) + 1 if nums else 1}"


def render_item(item_id: str, title: str, fields: list[tuple[str, str]], body: str) -> list[str]:
    title = (title or "").strip() or item_id
    head = f"### {item_id} {title}"
    out = [head]
    for k, v in fields:
        k, v = (k or "").strip(), (v or "").strip()
        if k:
            out.append(f"- {k}：{v}")
    body = (body or "").strip("\n")
    if body:
        out.append("")
        out.extend(body.splitlines())
    return out


def _tidy(lines: list[str]) -> list[str]:
    """条目之间留一个空行，段首段尾不留空。"""
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.splitlines()


def save_item(
    text: str,
    section: str,
    item_id: str,
    title: str,
    fields: list[tuple[str, str]],
    body: str,
) -> str:
    """新增或改写一条；item_id 给了就必须已经存在（否则就是新增）。"""
    lines = _lines(text)
    start, end = _section_bounds(lines, section)
    block = render_item(item_id, title, fields, body)
    existing = next((it for it in item_ranges(text, section) if it["id"] == item_id), None)
    if existing:
        lines[existing["start"]:existing["end"]] = block
    else:
        # 插到这一段最后一条后面；段里还空着就直接接在标题下
        tail = end
        while tail > start and not lines[tail - 1].strip():
            tail -= 1
        insert = block if tail == start else [""] + block
        lines[tail:tail] = insert
    return _join(_tidy(lines))


def delete_item(text: str, section: str, item_id: str) -> str:
    lines = _lines(text)
    item = next((it for it in item_ranges(text, section) if it["id"] == item_id), None)
    if not item:
        raise ValueError(f"这一段里没有条目 {item_id}")
    # 连同它后面的空行一起删，别把段尾越删越空
    end = item["end"]
    while end < len(lines) and not lines[end].strip():
        end += 1
    lines[item["start"]:end] = []
    return _join(_tidy(lines))


def move_item(text: str, section: str, item_id: str, delta: int) -> str:
    """同段内上移/下移一格。"""
    items = item_ranges(text, section)
    idx = next((i for i, it in enumerate(items) if it["id"] == item_id), None)
    if idx is None:
        raise ValueError(f"这一段里没有条目 {item_id}")
    j = idx + delta
    if j < 0 or j >= len(items):
        return text
    a, b = items[idx], items[j]
    lo, hi = min(a["start"], b["start"]), max(a["end"], b["end"])
    first, second = (a, b) if a["start"] < b["start"] else (b, a)
    lines = _lines(text)
    block_a = lines[first["start"]:first["end"]]
    gap = lines[first["end"]:second["start"]]
    block_b = lines[second["start"]:second["end"]]
    lines[lo:hi] = block_b + gap + block_a
    return _join(_tidy(lines))


MAP_LINE_RE = re.compile(r"^-\s*([A-Z]+[0-9]+)\s*(?:→|->)\s*(.*)$")


def mappings(text: str) -> dict[str, tuple[str, str] | None]:
    """`- E1 → 对账：E1` → {"E1": ("对账", "E1")}；`- E1 → 自实现` → {"E1": None}。"""
    out: dict[str, tuple[str, str] | None] = {}
    try:
        lines = _lines(text)
        start, end = _section_bounds(lines, SEC_MAP)
    except ValueError:
        return out
    for line in lines[start:end]:
        m = MAP_LINE_RE.match(line.strip())
        if not m:
            continue
        item, rest = m.group(1), m.group(2).strip()
        if rest in ("自实现", "本模块自己实现", "自身", ""):
            out[item] = None
            continue
        parts = re.split(r"[：:]", rest, maxsplit=1)
        if len(parts) == 2:
            out[item] = (parts[0].strip(), parts[1].strip())
        else:
            out[item] = (rest, "")
    return out


def set_mapping(text: str, item_id: str, child_rel: str, child_item: str) -> str:
    """一条父提供项：要么下沉给某子模块的某条提供项，要么标自实现。"""
    line = f"- {item_id} → 自实现" if not child_rel else f"- {item_id} → {child_rel}：{child_item}"
    lines = _lines(text)
    rest = [ln for ln in lines if not (MAP_LINE_RE.match(ln.strip()) and MAP_LINE_RE.match(ln.strip()).group(1) == item_id)]
    rest = _tidy(rest)
    try:
        start, end = _section_bounds(rest, SEC_MAP)
    except ValueError:
        while rest and not rest[-1].strip():
            rest.pop()
        rest.extend(["", f"## {SEC_MAP}", "", line])
        return _join(rest)
    # 段尾插入
    tail = end
    while tail > start and not rest[tail - 1].strip():
        tail -= 1
    rest[tail:tail] = ["", line]
    return _join(_tidy(rest))


def clear_mapping(text: str, item_id: str) -> str:
    lines = _lines(text)
    keep = [ln for ln in lines if not (MAP_LINE_RE.match(ln.strip()) and MAP_LINE_RE.match(ln.strip()).group(1) == item_id)]
    # 承接段空了就把整个段拿掉，别留一个空标题
    out: list[str] = []
    i = 0
    while i < len(keep):
        if canonical_heading(keep[i]) == SEC_MAP:
            j = i + 1
            while j < len(keep) and not keep[j].lstrip().startswith("## "):
                j += 1
            if all(not ln.strip() for ln in keep[i + 1:j]):
                i = j
                continue
        out.append(keep[i])
        i += 1
    return _join(_tidy(out))