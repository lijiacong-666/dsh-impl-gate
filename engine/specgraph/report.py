"""把校验结果渲染成人能读的报告，或直接吐 JSON。"""

from __future__ import annotations

import json
from pathlib import Path

from .checks import Issue, Report
from .model import Project

MARK = {"error": "✗", "warning": "⚠", "info": "·"}
LEVEL_CN = {"error": "错误", "warning": "提醒", "info": "说明"}


def _rel(project: Project, file: str) -> str:
    if not file:
        return ""
    try:
        return Path(file).resolve().relative_to(project.root).as_posix()
    except (ValueError, OSError):
        return file


def render(report: Report, project: Project, name: str = "") -> str:
    s = report.stats
    out: list[str] = []
    out.append("规格图谱 · 校验报告")
    out.append(f"项目：{name or project.root.name}")
    out.append("")

    headline = (
        f"{s['modules']} 个模块"
        + (f"（含 {s['externals']} 个外部引用）" if s["externals"] else "")
        + f" · 提供 {s['exposes']} · 需要 {s['needs']} · 约束 {s['constraints']} · 连线 {s['links']}"
    )
    out.append(headline)
    out.append("")

    if not report.issues:
        out.append("✓ 全部通过。这个图是合法的。")
        out.append("")
        out.append("（提醒：合法不等于完备，孤立提供项是复用候选，可以导出给别人用。）")
        out.append("")
        return "\n".join(out)

    out.append(f"{MARK['error']} 错误 {s['errors']} 个   {MARK['warning']} 提醒 {s['warnings']} 个")
    out.append("")

    # 按文件分组，保持 node 顺序
    groups: list[tuple[str, list[Issue]]] = []
    index: dict[str, int] = {}
    for issue in report.issues:
        key = issue.file or issue.node or "（项目级）"
        if key not in index:
            index[key] = len(groups)
            groups.append((key, []))
        groups[index[key]][1].append(issue)

    n = 0
    for key, issues in groups:
        title = _rel(project, key)
        out.append(f"── {title} " + "─" * max(4, 60 - len(title)))
        for issue in issues:
            n += 1
            loc = ""
            if issue.section:
                loc = issue.section
                if issue.item:
                    loc += f" · {issue.item}"
            line = f":{issue.line}" if issue.line else ""
            head = f"  {MARK.get(issue.level, '·')} [{n}] {issue.code}"
            if loc:
                head += f"   {loc}"
            out.append(head)
            out.append(f"     {issue.message}")
            if issue.fix:
                out.append(f"     ↳ {issue.fix}")
            if line:
                out.append(f"     @ {title}{line}")
            out.append("")
    out.append("按上面每组的第一条开始改，改完重跑 specgraph check。")
    out.append("")
    return "\n".join(out)


def to_json(report: Report, project: Project) -> str:
    payload = {
        "ok": report.ok,
        "root": str(project.root),
        "stats": report.stats,
        "issues": [
            {
                **i.as_dict(),
                "file": _rel(project, i.file) if i.file else "",
            }
            for i in report.issues
        ],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)