"""出口：AI 实现指令包。

只装契约，不装代码。包里没有一句「怎么实现」，只有「要实现什么」。
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field as dc_field

from .model import Project, Spec, Item, SEC_CONSTRAINTS, SEC_EXPOSES

INSTRUCTION = (
    "按以上契约实现「{name}」。语言、框架、目录结构、文件划分全部自选；"
    "实现只需要满足这些暴露项的行为与全部约束项，"
    "不需要、也不允许把代码或文件路径回写到图谱。"
)

BLOCKED = (
    "该节点的图还不合法，先修好再导出。下面这些没通过：\n{detail}"
)

NUM = ("零", "一", "二", "三", "四", "五", "六")


@dataclass
class Dep:
    need: Item
    provider_rel: str
    provider_name: str
    link_dst: str
    expose: Item | None
    provider_constraints: list[Item] = dc_field(default_factory=list)


@dataclass
class Pack:
    target: Spec
    deps: list[Dep]
    unsatisfied: list[Item]
    hash12: str

    def manifest(self) -> dict:
        return {
            "target": self.target.rel,
            "name": self.target.name,
            "kind": self.target.kind,
            "contract_sha256": self.hash12,
            "contract": {
                "exposes": [_item_dict(i) for i in self.target.exposes()],
                "needs": [_item_dict(i) for i in self.target.needs()],
                "constraints": [_item_dict(i) for i in self.target.constraints()],
            },
            "dependencies": [
                {
                    "need": _item_dict(d.need),
                    "provider": d.provider_rel,
                    "provider_name": d.provider_name,
                    "link_to": d.link_dst,
                    "expose": _item_dict(d.expose) if d.expose else None,
                    "provider_constraints": [_item_dict(c) for c in d.provider_constraints],
                }
                for d in self.deps
            ],
            "unsatisfied": [_item_dict(i) for i in self.unsatisfied],
            "instruction": INSTRUCTION.format(name=self.target.name or self.target.rel),
        }


def _item_dict(item: Item | None) -> dict | None:
    if item is None:
        return None
    return {
        "id": item.id,
        "title": item.title,
        "fields": dict(item.fields),
        "body": item.body,
    }


def _show(item: Item) -> str:
    lines = [f"{item.id} {item.title}"]
    for k, v in item.fields.items():
        lines.append(f"    {k}：{v}")
    if item.body.strip():
        for ln in item.body.strip().splitlines():
            lines.append(f"    {ln.strip()}")
    return "\n".join(lines)


def build(project: Project, rel: str) -> Pack:
    spec = project.lookup(rel)
    if spec is None:
        raise KeyError(rel)

    deps: list[Dep] = []
    unsatisfied: list[Item] = []
    for need in spec.needs():
        found: Dep | None = None
        for link in project.links:
            if link.src != spec.rel:
                continue
            for sat in link.satisfies:
                if sat.need != need.id or not sat.expose:
                    continue
                provider = project.lookup(link.dst)
                if provider is None:
                    continue
                expose = provider.find(SEC_EXPOSES, sat.expose)
                if expose is None:
                    continue
                found = Dep(need=need, provider_rel=provider.rel, provider_name=provider.name,
                            link_dst=link.dst, expose=expose,
                            provider_constraints=provider.constraints())
                break
            if found:
                break
        if found is None:
            unsatisfied.append(need)
        else:
            deps.append(found)

    return Pack(target=spec, deps=deps, unsatisfied=unsatisfied, hash12=_hash12(spec))


def _hash12(spec: Spec) -> str:
    return hashlib.sha256(spec.path.read_bytes()).hexdigest()[:12]


def render(pack: Pack) -> str:
    t = pack.target
    out: list[str] = []
    out.append(f"# 实现指令包 · {t.name or t.rel}")
    out.append("")
    out.append(f"- 节点：`{t.rel}`")
    out.append(f"- 契约指纹：`{pack.hash12}`")
    out.append("- 本包只含契约，不含任何代码。语言与结构由实现者自选。")
    if pack.unsatisfied:
        out.append(f"- ⚠ 有 {len(pack.unsatisfied)} 条需求还没有提供方，见「无法实现的部分」一节。")
    out.append("")
    out.append("---")
    out.append("")
    out.append("## 一、目标契约（原文）")
    out.append("")
    out.append(t.raw.strip())
    out.append("")

    out.append("## 二、它需要的外部能力")
    out.append("")
    sec = 3
    if not pack.deps:
        out.append("（无：这个节点的需求已全部满足，或者它本身没有需求。）")
        out.append("")
    for d in pack.deps:
        out.append(f"### {d.need.id} {d.need.title}")
        out.append("")
        out.append(f"需求原文：{d.need.title}")
        for k, v in d.need.fields.items():
            out.append(f"- {k}：{v}")
        if d.need.body.strip():
            out.append("")
            out.append(d.need.body.strip())
        out.append("")
        out.append(f"由 `{d.provider_rel}` 的 "
                   f"{d.expose.id if d.expose else '?'} 满足。下面是它的契约片段：")
        out.append("")
        out.append("```text")
        out.append(_show(d.expose) if d.expose else "（缺失）")
        out.append("```")
        out.append("")
        if d.provider_constraints:
            out.append("提供方的约束项（实现必须让这些继续成立）：")
            out.append("")
            for c in d.provider_constraints:
                out.append("```text")
                out.append(_show(c))
                out.append("```")
                out.append("")

    out.append(f"## {NUM[sec]}、你必须遵守的约束")
    sec += 1
    out.append("")
    cons = t.constraints()
    if not cons:
        out.append("（这个节点没有额外约束项。）")
    for c in cons:
        out.append("```text")
        out.append(_show(c))
        out.append("```")
        out.append("")

    if pack.unsatisfied:
        out.append(f"## {NUM[sec]}、无法实现的部分")
        sec += 1
        out.append("")
        out.append("以下需求在本图中没有连线满足，实现时没有可依据的提供方契约：")
        out.append("")
        for need in pack.unsatisfied:
            out.append(f"- {need.id} {need.title}")
        out.append("")
        out.append("请先把这些需求接到某个提供方，再重新导出。")
        out.append("")

    out.append(f"## {NUM[sec]}、指令")
    out.append("")
    out.append(INSTRUCTION.format(name=t.name or t.rel))
    out.append("")
    return "\n".join(out)


@dataclass
class WholePack:
    project_name: str
    specs: list[Spec]
    edges: list[tuple[str, Item, str, Item | None]]
    unsatisfied: list[tuple[str, Item]]
    hash12: str

    def manifest(self) -> dict:
        return {
            "project": self.project_name,
            "scope": "whole",
            "modules": [
                {
                    "rel": s.rel,
                    "name": s.name,
                    "type": s.node_type or ("class" if s.kind == "class" else "module"),
                    "contract_sha256": _hash12(s),
                    "contract": {
                        "exposes": [_item_dict(i) for i in s.exposes()],
                        "needs": [_item_dict(i) for i in s.needs()],
                        "constraints": [_item_dict(i) for i in s.constraints()],
                    },
                }
                for s in self.specs
            ],
            "edges": [
                {
                    "from": src,
                    "need": _item_dict(need),
                    "to": dst,
                    "expose": _item_dict(expose) if expose else None,
                }
                for src, need, dst, expose in self.edges
            ],
            "unsatisfied": [{"module": rel, "need": _item_dict(need)} for rel, need in self.unsatisfied],
            "instruction": WHOLE_INSTRUCTION.format(name=self.project_name),
        }


WHOLE_INSTRUCTION = (
    "按以上全部契约实现「{name}」这个系统。语言、框架、目录结构、文件划分全部自选；"
    "每个模块只需要满足它自己那三段契约里的暴露项与约束项，模块之间只通过「提供/需要」约定的能力交互；"
    "不需要、也不允许把代码或文件路径回写到图谱。"
)


def _dependency_order(specs: list[Spec], links) -> list[Spec]:
    """被依赖的模块排在前面；有环就退回按路径排序，不报错（环由校验器提示）。"""
    by_rel = {s.rel: s for s in specs}
    deps: dict[str, set[str]] = {s.rel: set() for s in specs}
    for link in links:
        if link.src in by_rel and link.dst in by_rel:
            deps[link.src].add(link.dst)

    order: list[Spec] = []
    seen: set[str] = set()
    visiting: set[str] = set()

    def visit(rel: str) -> None:
        if rel in seen or rel in visiting:
            return
        visiting.add(rel)
        for d in sorted(deps.get(rel, ())):
            visit(d)
        visiting.discard(rel)
        seen.add(rel)
        order.append(by_rel[rel])

    for s in sorted(specs, key=lambda x: ((x.rel or ".").count("/"), x.rel)):
        visit(s.rel)
    return order


def _is_placeholder_root(s: Spec, project: Project) -> bool:
    """「新建项目」自动写的根契约：只是容器占位，不该当成一个模块塞进整图包。"""
    if s.rel != "." or not any(o.rel != "." for o in project.specs.values()):
        return False
    if s.exposes() or s.needs():
        return False
    cons = s.constraints()
    return len(cons) == 1 and cons[0].title.strip() == "真相源"


def build_whole(project: Project) -> WholePack:
    specs = [s for s in project.specs.values() if s.kind in ("module", "class")]
    specs = [s for s in specs if not _is_placeholder_root(s, project)]
    ordered = _dependency_order(specs, project.links)

    edges: list[tuple[str, Item, str, Item | None]] = []
    for s in ordered:
        for need in s.needs():
            for link in project.links:
                if link.src != s.rel:
                    continue
                for sat in link.satisfies:
                    if sat.need != need.id:
                        continue
                    provider = project.lookup(link.dst)
                    expose = provider.find(SEC_EXPOSES, sat.expose) if (provider and sat.expose) else None
                    edges.append((s.rel, need, link.dst, expose))
                    break
                else:
                    continue
                break

    satisfied = {(src, need.id) for src, need, _dst, _e in edges}
    unsatisfied: list[tuple[str, Item]] = []
    for s in ordered:
        for need in s.needs():
            if (s.rel, need.id) not in satisfied:
                unsatisfied.append((s.rel, need))

    blob = "".join(_hash12(s) for s in ordered).encode()
    return WholePack(
        project_name=project.root.name,
        specs=ordered,
        edges=edges,
        unsatisfied=unsatisfied,
        hash12=hashlib.sha256(blob).hexdigest()[:12],
    )


def render_whole(pack: WholePack) -> str:
    out: list[str] = []
    out.append(f"# 实现指令包 · 整图 · {pack.project_name}")
    out.append("")
    out.append(f"- 范围：本图全部 {len(pack.specs)} 个模块")
    out.append(f"- 契约总指纹：`{pack.hash12}`")
    out.append("- 本包只含契约，不含任何代码。模块按依赖顺序排列：被依赖的在前。")
    if pack.unsatisfied:
        out.append(f"- ⚠ 有 {len(pack.unsatisfied)} 条需求还没有提供方，见「无法实现的部分」。")
    out.append("")
    out.append("---")
    out.append("")

    out.append("## 一、模块清单")
    out.append("")
    out.append("| # | 模块 | 标识 | 类型 | 提供 | 需要 | 约束 |")
    out.append("|---|---|---|---|---|---|---|")
    for i, s in enumerate(pack.specs, 1):
        out.append(
            f"| {i} | {s.name or s.rel} | `{s.rel}` | {s.type_label()} | "
            f"{len(s.exposes())} | {len(s.needs())} | {len(s.constraints())} |"
        )
    out.append("")

    out.append("## 二、依赖关系")
    out.append("")
    if not pack.edges:
        out.append("（本图没有任何「需求项 → 提供项」的连线。）")
        out.append("")
    else:
        out.append("这不是调用关系，只说明一条需求由谁的哪条提供项满足。")
        out.append("")
        for src, need, dst, expose in pack.edges:
            out.append(
                f"- `{src}` 的 {need.id}「{need.title}」 ← `{dst}` 的 "
                f"{(expose.id if expose else '?')}「{expose.title if expose else '（缺失）'}」"
            )
        out.append("")

    out.append("## 三、逐模块契约（原文）")
    out.append("")
    for i, s in enumerate(pack.specs, 1):
        out.append(f"### 3.{i} {s.name or s.rel}（`{s.rel}` · {s.type_label()}）")
        out.append("")
        out.append("```markdown")
        out.append(s.raw.strip())
        out.append("```")
        out.append("")

    sec = 4
    if pack.unsatisfied:
        out.append(f"## {NUM[sec]}、无法实现的部分")
        sec += 1
        out.append("")
        out.append("以下需求在本图中没有连线满足，实现时没有可依据的提供方契约：")
        out.append("")
        for rel, need in pack.unsatisfied:
            out.append(f"- `{rel}` 的 {need.id}「{need.title}」")
        out.append("")
        out.append("请先把这些需求接到某个提供方，再重新导出。")
        out.append("")

    out.append(f"## {NUM[sec]}、指令")
    out.append("")
    out.append(WHOLE_INSTRUCTION.format(name=pack.project_name))
    out.append("")
    return "\n".join(out)


def render_whole_manifest(pack: WholePack) -> str:
    return json.dumps(pack.manifest(), ensure_ascii=False, indent=2)


def self_check_whole(pack: WholePack) -> list[str]:
    return _fence_problems(render_whole(pack))


# 包本身用 ```markdown 包契约原文，这些语言标记是「容器」不是代码
_FENCE_OK = {"", "markdown", "md", "text", "txt", "toml", "json", "yaml", "yml"}


def _fence_problems(text: str) -> list[str]:
    problems: list[str] = []
    for m in re.finditer(r"```([A-Za-z0-9_+#.-]*)", text):
        lang = (m.group(1) or "").lower()
        if lang not in _FENCE_OK:
            problems.append(f"指令包里出现了代码块标记 ```{m.group(1)}")
    return problems


def render_manifest(pack: Pack) -> str:
    return json.dumps(pack.manifest(), ensure_ascii=False, indent=2)


def self_check(pack: Pack) -> list[str]:
    """导出包的自检：确认没有把代码塞进去。

    只看「带语言标记的代码围栏」——契约正文里写「function 的语义」是人话，不该报错。
    """
    return _fence_problems(render(pack))