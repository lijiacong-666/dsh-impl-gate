"""8 类校验。输出结构化问题列表，每条都带位置与修复建议。"""

from __future__ import annotations

from dataclasses import dataclass, field as dc_field
from pathlib import Path

from . import detect
from .model import (
    SEC_CONSTRAINTS,
    SEC_EXPOSES,
    SEC_MAP,
    SEC_NEEDS,
    Item,
    Link,
    Project,
    Spec,
    resolve_target,
    sha256_file,
)


@dataclass
class Issue:
    level: str            # error | warning | info
    code: str
    message: str
    fix: str
    node: str = ""
    section: str = ""
    item: str = ""
    file: str = ""
    line: int = 0

    def as_dict(self) -> dict:
        return {
            "level": self.level,
            "code": self.code,
            "node": self.node,
            "section": self.section,
            "item": self.item,
            "message": self.message,
            "fix": self.fix,
            "file": self.file,
            "line": self.line,
        }


@dataclass
class Report:
    issues: list[Issue] = dc_field(default_factory=list)
    stats: dict = dc_field(default_factory=dict)

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "error"]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "warning"]

    @property
    def ok(self) -> bool:
        return not self.errors


def _f(project: Project, spec: Spec) -> str:
    return str(spec.path)


def _children(project: Project, rel: str) -> list[str]:
    """直接的子模块（不是所有后代）。"""
    if rel == ".":
        return sorted(r for r in project.specs if r != "." and "/" not in r)
    return sorted(r for r in project.specs if r.startswith(rel + "/"))


def check(project: Project, whitelist: tuple[str, ...] = ()) -> Report:
    issues: list[Issue] = []

    # ---- 0. 项目级问题
    for p in project.problems:
        issues.append(Issue(level=p.level, code=p.code, message=p.message, fix=p.fix, line=p.line))

    specs = project.all_specs()

    # ---- 1. 说明书格式
    for rel, spec in specs.items():
        path = str(spec.path)
        for p in spec.problems:
            issues.append(Issue(level=p.level, code=p.code, message=p.message, fix=p.fix,
                                node=rel, file=path, line=p.line))

        # ---- 4/5. 实现细节
        for f in detect.scan_spec(spec, whitelist):
            item = spec.item_at(f.line)
            issues.append(Issue(
                level=f.level, code=f.code, message=f.message,
                fix="删掉这段实现描述，改写成「必须满足什么」；确属业务术语时，把它加进 _whitelist.toml 的 allowed_terms。",
                node=rel, section=item.section if item else "", item=item.id if item else "",
                file=path, line=f.line,
            ))

    # ---- 3. 连线两端
    need_owners: dict[tuple[str, str], list[tuple[Link, str]]] = {}
    for idx, link in enumerate(project.links, start=1):
        src = specs.get(link.src)
        dst = specs.get(link.dst)
        where = f"graph.toml 第 {idx} 条 [[link]]（{link.src or '?'} → {link.dst or '?'}）"
        if link.src == link.dst and link.src:
            issues.append(Issue(level="warning", code="SELF_LINK",
                                message=f"{where} 是自引用。",
                                fix="确认这是有意的；自引用通常意味着这个模块内部还有一层没拆出来。",
                                node=link.src))
        if not link.src:
            issues.append(Issue(level="error", code="LINK_NO_SOURCE", message=f"{where} 缺少 from。",
                                fix="补 from = \"模块路径\"（相对于项目根，用 / 分隔）。"))
            continue
        if not link.dst:
            issues.append(Issue(level="error", code="LINK_NO_TARGET", message=f"{where} 缺少 to。",
                                fix="补 to = \"模块路径\"。"))
            continue
        if src is None:
            issues.append(Issue(level="error", code="LINK_UNKNOWN_MODULE",
                                message=f"{where} 的 from 指向不存在的模块「{link.src}」。",
                                fix="确认目录名拼写；模块标识就是文件夹相对路径。", node=link.src))
            continue
        if dst is None:
            issues.append(Issue(level="error", code="LINK_UNKNOWN_MODULE",
                                message=f"{where} 的 to 指向不存在的模块「{link.dst}」。",
                                fix="确认目标模块已建；如果它在项目外，先在 graph.toml 里加一条 [[ref]] 引用它。",
                                node=link.src))
            continue

        for sat in link.satisfies:
            if not sat.need:
                continue
            need_item = src.find(SEC_NEEDS, sat.need)
            expose_item = dst.find(SEC_EXPOSES, sat.expose) if sat.expose else None
            if need_item is None:
                issues.append(Issue(
                    level="error", code="LINK_NEED_UNKNOWN",
                    message=f"{where} 声称满足「{sat.need}」，但「{link.src}」的「需要」段里没有这一条。",
                    fix=f"要么把 need 改成实际存在的需求编号，要么先在 {link.src}/spec.md 里补上这条需求。",
                    node=link.src, section=SEC_NEEDS, item=sat.need, file=str(src.path),
                ))
                continue
            if not sat.expose:
                issues.append(Issue(
                    level="error", code="LINK_EXPOSE_UNKNOWN",
                    message=f"{where} 只勾了需求 {sat.need}，没有说对方用哪条提供项满足它。",
                    fix=f"补 expose = \"对方提供项的编号\"（见 {link.dst}/spec.md 的「提供」段）。",
                    node=link.src, section=SEC_NEEDS, item=sat.need, file=str(src.path),
                ))
                continue
            if expose_item is None:
                issues.append(Issue(
                    level="error", code="LINK_EXPOSE_UNKNOWN",
                    message=f"{where} 说由「{link.dst}」的 {sat.expose} 满足，但对方没有这条提供项。",
                    fix=f"改成 {link.dst} 实际提供的编号，或让对方在说明书里补上。",
                    node=link.dst, section=SEC_EXPOSES, item=sat.expose, file=str(dst.path),
                ))
                continue
            need_owners.setdefault((link.src, sat.need), []).append((link, sat.expose))

    # ---- 2. 每条需求恰好一条连线
    for rel, spec in project.specs.items():
        if spec.kind == "class" and not spec.needs():
            continue
        for need in spec.needs():
            owners = need_owners.get((rel, need.id), [])
            if not owners:
                issues.append(Issue(
                    level="error", code="NEED_UNSATISFIED",
                    message=f"需求项 {need.id}「{need.title}」没有任何连线满足（0 条）。",
                    fix="在 graph.toml 里加一条 [[link]]，从本模块指向能提供它的模块，并写 "
                        "satisfies = [{ need = \"" + need.id + "\", expose = \"对方提供项编号\" }]。",
                    node=rel, section=SEC_NEEDS, item=need.id, file=str(spec.path), line=need.line,
                ))
            elif len(owners) > 1:
                who = "、".join(f"{l.dst}:{e}" for l, e in owners)
                issues.append(Issue(
                    level="error", code="NEED_AMBIGUOUS",
                    message=f"需求项 {need.id}「{need.title}」被 {len(owners)} 条连线同时满足（{who}），属于歧义。",
                    fix="只保留一条生效，其余的删掉或改标注为备选；需要人裁决，不要两个都留。",
                    node=rel, section=SEC_NEEDS, item=need.id, file=str(spec.path), line=need.line,
                ))

    # ---- 6. 父子承接：有子模块就必须显式声明，不能靠"并集"默认
    for rel, spec in project.specs.items():
        kids = _children(project, rel)
        if not kids or not spec.exposes() or spec.has_map_section:
            continue
        issues.append(Issue(
            level="error", code="MAP_MISSING",
            message=f"「{rel}」下面有 {len(kids)} 个子模块（{'、'.join(kids)}），"
                    f"但说明书里没有「## 内部承接」段，父子契约的对应关系没有显式声明。",
            fix="加一段「## 内部承接」，逐条写「- E1 → 子模块名：E1」：左边是本模块的提供项，"
                "右边是承接它的子模块提供项。注意父契约不等于子契约的并集。",
            node=rel, section=SEC_MAP, file=str(spec.path),
        ))

    # ---- 6b. 写了内部承接就逐条校验
    for rel, spec in project.specs.items():
        if not spec.has_map_section:
            continue
        covered: dict[str, int] = {}
        self_made: set[str] = set()
        for m in spec.mapping:
            parent = spec.find(SEC_EXPOSES, m.parent_item)
            if parent is None:
                issues.append(Issue(
                    level="error", code="MAP_PARENT_UNKNOWN",
                    message=f"内部承接里写了 {m.parent_item}，但本模块「提供」段没有这一条。",
                    fix="把左侧改成实际存在的提供项编号。",
                    node=rel, section=SEC_EXPOSES, item=m.parent_item, file=str(spec.path), line=m.line,
                ))
                continue
            if not m.child_rel:
                self_made.add(m.parent_item)
                continue
            child_rel = m.child_rel if rel == "." else f"{rel}/{m.child_rel}"
            child = project.specs.get(child_rel) or project.specs.get(m.child_rel)
            if child is None:
                issues.append(Issue(
                    level="error", code="MAP_CHILD_UNKNOWN",
                    message=f"内部承接里指向子模块「{m.child_rel}」，但项目里没有这个模块。",
                    fix="检查子模块路径；路径按本模块下的相对位置写。",
                    node=rel, section="", item=m.parent_item, file=str(spec.path), line=m.line,
                ))
                continue
            if child.find(SEC_EXPOSES, m.child_item) is None:
                issues.append(Issue(
                    level="error", code="MAP_ITEM_UNKNOWN",
                    message=f"内部承接里说由「{m.child_rel}」的 {m.child_item} 承接，但子模块没有这条提供项。",
                    fix="改成子模块实际提供的编号。",
                    node=child.rel, section=SEC_EXPOSES, item=m.child_item,
                    file=str(child.path), line=m.line,
                ))
                continue
            covered[m.parent_item] = covered.get(m.parent_item, 0) + 1
        for pid, n in covered.items():
            if n > 1:
                issues.append(Issue(
                    level="warning", code="MAP_DUPLICATE",
                    message=f"提供项 {pid} 在内部承接里出现了 {n} 次。",
                    fix="同一条对外能力由一个子模块承接就够了。",
                    node=rel, section=SEC_EXPOSES, item=pid, file=str(spec.path),
                ))
        uncovered = [e.id for e in spec.exposes()
                     if e.id not in covered and e.id not in self_made]
        if uncovered:
            issues.append(Issue(
                level="error", code="MAP_UNCOVERED",
                message=f"提供项 {('、'.join(uncovered))} 既没有下沉给子模块，也没有标注「自实现」，"
                        f"父子契约的承接关系不完整。",
                fix="每条提供项二选一：写「- E1 → 子模块：E1」说明由哪个子模块承接，"
                    "或写「- E1 → 自实现」表明由本模块自己承担。",
                node=rel, section=SEC_EXPOSES, item="、".join(uncovered), file=str(spec.path),
            ))

    # ---- 7. 被引用的契约存在且未被篡改
    for ref in project.refs:
        target_path = resolve_target(project.root, ref.target)
        spec_path = target_path / "spec.md"
        if not spec_path.is_file():
            issues.append(Issue(
                level="error", code="REF_MISSING",
                message=f"引用的契约不存在：{ref.target}（{spec_path}）。",
                fix="检查 target 路径；如果对方已移动，改 target 并重新 pin。",
                node=ref.module,
            ))
            continue
        if not ref.pinned_hash:
            issues.append(Issue(
                level="warning", code="REF_UNPINNED",
                message=f"引用「{ref.target}」还没有钉住版本，无法感知对方变更。",
                fix="运行 specgraph pin 记录当前内容指纹。",
                node=ref.module,
            ))
            continue
        actual = sha256_file(spec_path)
        if actual != ref.pinned_hash:
            issues.append(Issue(
                level="error", code="REF_CHANGED",
                message=f"被引用的契约「{ref.target}」内容已变更（指纹 {ref.pinned_hash[:8]} → {actual[:8]}），需要重新校验。",
                fix=f"确认变更可为 {ref.module} 接受后运行 specgraph pin；若不能接受，请对方改回去。",
                node=ref.module,
            ))

    # ---- 8. 循环引用
    for cyc in _find_cycles(project):
        chain = " → ".join(cyc)
        level = "warning"
        code = "CYCLE"
        issues.append(Issue(
            level=level, code=code,
            message=f"检测到循环访问：{chain}。循环本身不一定非法，但需要人确认。",
            fix="确认这是有意的（互相提供能力确实存在），并在下一版支持「裁决记录」时登记理由。",
            node=cyc[0],
        ))

    # ---- 统计
    n_expose = sum(len(s.exposes()) for s in project.specs.values())
    n_need = sum(len(s.needs()) for s in project.specs.values())
    n_con = sum(len(s.constraints()) for s in project.specs.values())
    stats = {
        "modules": len(project.specs),
        "externals": len(project.externals),
        "exposes": n_expose,
        "needs": n_need,
        "constraints": n_con,
        "links": len(project.links),
        "errors": sum(1 for i in issues if i.level == "error"),
        "warnings": sum(1 for i in issues if i.level == "warning"),
    }
    issues.sort(key=lambda i: (i.file or "~", i.line or 0, i.code))
    return Report(issues=issues, stats=stats)


def _find_cycles(project: Project) -> list[list[str]]:
    adj: dict[str, list[str]] = {}
    for link in project.links:
        if not link.src or not link.dst:
            continue
        adj.setdefault(link.src, []).append(link.dst)
        adj.setdefault(link.dst, [])
    cycles: list[list[str]] = []
    seen: set[frozenset[str]] = set()
    done: set[str] = set()
    for start in sorted(adj):
        if start in done:
            continue
        stack: list[tuple[str, int]] = [(start, 0)]
        path = [start]
        onpath = {start}
        while stack:
            node, pos = stack[-1]
            nxts = adj.get(node, [])
            if pos < len(nxts):
                stack[-1] = (node, pos + 1)
                nxt = nxts[pos]
                if nxt in onpath:
                    cyc = path[path.index(nxt):]
                    key = frozenset(cyc)
                    if len(cyc) > 1 and key not in seen:
                        seen.add(key)
                        cycles.append(cyc + [nxt])
                    continue
                if nxt in done:
                    continue
                stack.append((nxt, 0))
                path.append(nxt)
                onpath.add(nxt)
            else:
                stack.pop()
                onpath.discard(path.pop())
                done.add(node)
    return cycles