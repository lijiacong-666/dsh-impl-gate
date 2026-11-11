"""命令行入口。

    specgraph check [项目根] [--json]
    specgraph list [--root]
    specgraph export <节点> [--root] [--out 目录] [--json]
    specgraph pin [--root] [--module M] [--target T] [--dry-run]
    specgraph new <节点路径> [--root] [--name] [--kind class] [--class C] [--file F]
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from . import canvas, checks, export, report
from .model import (
    GRAPH_FILE,
    SPEC_FILE,
    SEC_CONSTRAINTS,
    SEC_EXPOSES,
    SEC_NEEDS,
    audit_refs,
    find_graphs,
    load_project,
    load_whitelist,
    normalize_rel,
    sha256_file,
)

STATE_LABEL = {
    "ok": "✓ 内容未变",
    "changed": "⚠ 内容已变更 · 需要重新校验",
    "missing": "✗ 目标不存在",
    "unpinned": "⚠ 未钉版本 · 感知不到变更",
}

TEMPLATE = """---
name: {name}
kind: {kind}
status: draft
{extra}---

## {sec_e}

（暂无。写「### E1 名称」+「- 语义：…」，讲清楚对外提供什么。）

## {sec_n}

（无。有需求时写成「### N1 名称」+「- 约束要求：…」。）

## {sec_c}

（无。写这个模块在任何实现下都必须成立的规则。）
"""


def _out(text: str) -> None:
    sys.stdout.write(text if text.endswith("\n") else text + "\n")


def cmd_check(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    project = load_project(root)
    whitelist = load_whitelist(root)
    rep = checks.check(project, whitelist)
    if args.json:
        _out(report.to_json(rep, project))
    else:
        _out(report.render(rep, project, name=root.name))
    return 0 if rep.ok else 1


def cmd_list(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    project = load_project(root)
    if not project.specs:
        _out(f"（{root} 下没有找到任何说明书）")
        return 0

    children: dict[str, list[str]] = {}
    roots: list[str] = []
    for rel in sorted(project.specs):
        if rel == ".":
            roots.append(".")
            continue
        parent = rel.rsplit("/", 1)[0] if "/" in rel else "."
        if parent in project.specs:
            children.setdefault(parent, []).append(rel)
        else:
            roots.append(rel)

    lines = [str(root), ""]

    def walk(rel: str, depth: int) -> None:
        spec = project.specs[rel]
        pad = "  " * depth
        mark = "◇" if spec.kind == "class" else "▸"
        name = spec.name or rel.rsplit("/", 1)[-1]
        where = "项目根" if rel == "." else rel
        extra = f"  [class · {spec.class_name}]" if spec.kind == "class" else ""
        lines.append(f"{pad}{mark} {name}{extra}   ({where})")
        lines.append(f"{pad}   提供 {len(spec.exposes())} · 需要 {len(spec.needs())} "
                     f"· 约束 {len(spec.constraints())}")
        for child in children.get(rel, []):
            walk(child, depth + 1)

    for rel in roots:
        walk(rel, 0)

    if project.externals:
        lines.append("")
        lines.append("外部引用：")
        for rel, spec in sorted(project.externals.items()):
            lines.append(f"  ↪ {spec.name}   ({rel})")
    lines.append("")
    _out("\n".join(lines))
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    project = load_project(root)
    whitelist = load_whitelist(root)
    rep = checks.check(project, whitelist)
    rel = normalize_rel(args.node)
    spec = project.lookup(rel)
    if spec is None:
        _out(f"没有这个节点：{rel}\n先用 specgraph list 看看有哪些。")
        return 2

    if not rep.ok and not args.force:
        detail = "\n".join(
            f"  {i.code}  {i.node or '-'}  {i.message}" for i in rep.errors[:10]
        )
        if len(rep.errors) > 10:
            detail += f"\n  …还有 {len(rep.errors) - 10} 条"
        _out(export.BLOCKED.format(detail=detail))
        _out("（校验不过的图不能导出实现指令；确实要导，加 --force。）")
        return 2

    pack = export.build(project, rel)
    text = export.render(pack)
    problems = export.self_check(pack)
    if problems:
        _out("导出包自检没过：\n  " + "\n  ".join(problems))
        return 2

    if args.json:
        _out(export.render_manifest(pack))
        return 0

    if args.out:
        outdir = Path(args.out).resolve()
        outdir.mkdir(parents=True, exist_ok=True)
        stem = (spec.name or rel.replace("/", "-"))
        md = outdir / f"{stem}-指令包.md"
        js = outdir / f"{stem}-manifest.json"
        md.write_text(text, encoding="utf-8")
        js.write_text(export.render_manifest(pack), encoding="utf-8")
        _out(f"已写出：\n  {md}\n  {js}")
        if pack.unsatisfied:
            _out(f"注意：有 {len(pack.unsatisfied)} 条需求没有提供方，包里已单列。")
        return 0

    _out(text)
    return 0


def cmd_canvas(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    project = load_project(root)
    rep = checks.check(project, load_whitelist(root))
    outdir = Path(args.out).resolve() if args.out else root / ".canvas"
    path = canvas.write(project, rep, outdir)
    errs = len(rep.errors)
    _out(f"已生成画布：{path}")
    _out(f"  节点 {len(project.specs)} 个 · 连线 {len(project.links)} 条"
         + (f" · 图不合法（{errs} 个错误，画布上标了缺口）" if errs else " · 校验通过"))
    if args.open:
        import webbrowser
        webbrowser.open(path.as_uri())
        _out("已在浏览器里打开。")
    return 0


# --------------------------------------------------------------------------- 复用审计

def cmd_refs(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    uses = audit_refs(root)
    if not uses:
        _out(f"「{root.name}」没有引用任何外部契约（graph.toml 里没有 [[ref]]）。")
        return 0
    _out(f"「{root.name}」引用的外部契约：")
    for u in uses:
        _out("")
        _out(f"  {STATE_LABEL[u.state]}")
        _out(f"    引用方节点：{u.module or '?'}")
        _out(f"    引用写法：{u.target}")
        _out(f"    实际位置：{u.target_dir}")
    bad = [u for u in uses if u.state in ("changed", "missing")]
    _out("")
    if bad:
        _out(f"{len(bad)} 处需要处理：changed 先确认对方改了什么，接受后 specgraph pin；missing 找回目标或删掉这条引用。")
        return 1
    _out("全部引用与钉住的版本一致。")
    return 0


def _default_scan(target: Path) -> list[Path]:
    """默认扫描契约的上一级目录（通常放着共享契约和用它的各个图）。"""
    base = target.parent
    if len(base.parts) > 2:  # 不往上爬到盘符根
        return [base.parent]
    return [base]


def cmd_usage(args: argparse.Namespace) -> int:
    target = Path(args.contract).resolve()
    scan = [Path(p) for p in (args.scan or [str(p) for p in _default_scan(target)])]
    key = os.path.normcase(str(target))

    graphs: dict[str, Path] = {}
    hits = []
    for base in scan:
        for g in find_graphs(base):
            graphs.setdefault(os.path.normcase(str(g)), g)
            for u in audit_refs(g):
                if os.path.normcase(str(u.target_dir)) == key:
                    hits.append(u)

    _out(f"契约：{target}")
    if not hits:
        _out(f"没有被任何图引用（扫描了 {len(graphs)} 张图）。")
        return 0
    seen: set[str] = set()
    for u in hits:
        tag = f"{os.path.normcase(str(u.graph_root))}|{u.module}"
        if tag in seen:
            continue
        seen.add(tag)
        _out("")
        _out(f"  {STATE_LABEL[u.state]}")
        _out(f"    图：{u.graph_root}")
        _out(f"    节点：{u.module or '?'}   ← {u.target}")
    _out("")
    changed = [u for u in hits if u.state in ("changed", "missing")]
    if changed:
        _out(f"{len(changed)} 处引用已经失效，对应的图需要重新校验。")
        return 1
    return 0


# --------------------------------------------------------------------------- pin

def _rewrite_pins(text: str, updates: dict[int, str]) -> str:
    """updates: 行索引(0 基) → 新的 pinned_hash 行内容。"""
    lines = text.splitlines()
    for idx, newline in updates.items():
        lines[idx] = newline
    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")


def cmd_pin(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    graph = root / GRAPH_FILE
    if not graph.is_file():
        _out(f"没有 {GRAPH_FILE}，无从 pin。")
        return 2
    text = graph.read_text(encoding="utf-8-sig")
    lines = text.splitlines()

    starts = [i for i, ln in enumerate(lines) if ln.strip() == "[[ref]]"]
    if not starts:
        _out("graph.toml 里没有 [[ref]]。")
        return 0

    updates: dict[int, str] = {}
    done: list[str] = []
    for k, start in enumerate(starts):
        end = starts[k + 1] if k + 1 < len(starts) else len(lines)
        for j in range(start + 1, end):
            if lines[j].lstrip().startswith("[["):
                end = j
                break
        module = target = ""
        hash_line = -1
        last_body = start
        for j in range(start + 1, end):
            s = lines[j].strip()
            if s.startswith("module") and "=" in s:
                module = normalize_rel(s.split("=", 1)[1].strip().strip('"'))
            elif s.startswith("target") and "=" in s:
                target = normalize_rel(s.split("=", 1)[1].strip().strip('"'))
            elif s.startswith("pinned_hash"):
                hash_line = j
            if s and not s.startswith("#"):
                last_body = j
        if args.module and module != normalize_rel(args.module):
            continue
        if args.target and target != normalize_rel(args.target):
            continue
        if not target:
            _out(f"第 {start + 1} 行的 [[ref]] 没有 target，跳过。")
            continue
        spec_path = (root / target) / SPEC_FILE
        if not spec_path.is_file():
            _out(f"[跳过] {module or '?'} → {target}：目标没有 {SPEC_FILE}。")
            continue
        new_hash = sha256_file(spec_path)
        line = f'pinned_hash = "{new_hash}"'
        if hash_line >= 0:
            updates[hash_line] = line
        else:
            updates[last_body] = lines[last_body] + "\n" + line
        done.append(f"{module or '?'} → {target}  {new_hash[:12]}")

    if not done:
        _out("没有匹配的 [[ref]]。")
        return 0
    if args.dry_run:
        _out("将要钉住（--dry-run，未写盘）：")
        for d in done:
            _out("  " + d)
        return 0
    graph.write_text(_rewrite_pins(text, updates), encoding="utf-8")
    _out("已钉住：")
    for d in done:
        _out("  " + d)
    return 0


# --------------------------------------------------------------------------- new

def cmd_new(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    target = (root / args.path).resolve()
    if root not in target.parents and target != root:
        _out("节点必须在项目根目录里面。")
        return 2
    if (target / SPEC_FILE).exists() and not args.force:
        _out(f"{target / SPEC_FILE} 已存在。要覆盖加 --force。")
        return 2
    target.mkdir(parents=True, exist_ok=True)
    name = args.name or target.name
    kind = "class" if args.kind == "class" else "module"
    extra = ""
    if kind == "class":
        extra = f"class: {args.klass or name}\n"
        if args.file:
            extra += f"file: {args.file}\n"
    text = TEMPLATE.format(
        name=name, kind=kind, extra=extra,
        sec_e=SEC_EXPOSES, sec_n=SEC_NEEDS, sec_c=SEC_CONSTRAINTS,
    )
    (target / SPEC_FILE).write_text(text, encoding="utf-8")
    _out(f"已创建 {target / SPEC_FILE}")
    if not (root / GRAPH_FILE).is_file():
        _out(f"提示：项目根还没有 {GRAPH_FILE}，先建一个，再写 [[link]]。")
    return 0


def cmd_app(args: argparse.Namespace) -> int:
    from .app import load_projects, looks_like_project, serve

    root = Path(args.root).resolve()
    # 双击 exe 时 cwd 是 exe 所在目录，通常不是项目：退回到最近打开过的那个
    if not (root.is_dir() and looks_like_project(root)):
        recent = [Path(p["path"]) for p in load_projects() if Path(p["path"]).is_dir()]
        if recent:
            root = recent[0]
    if not root.is_dir():
        _out(f"项目根不存在：{root}")
        return 2

    serve(root, port=args.port, open_window=not args.no_window)
    return 0


def cmd_version(_: argparse.Namespace) -> int:
    _out("specgraph 0.9.2  ·  图是契约，代码是实现产物")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="specgraph",
        description="规格图谱：文件夹 + 三段式契约是唯一真相源；校验先于画布。",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("check", help="校验整张图")
    c.add_argument("root", nargs="?", default=".", help="项目根目录")
    c.add_argument("--json", action="store_true", help="输出结构化 JSON")
    c.set_defaults(func=cmd_check)

    ls = sub.add_parser("list", help="列出模块树")
    ls.add_argument("--root", default=".")
    ls.set_defaults(func=cmd_list)

    e = sub.add_parser("export", help="导出 AI 实现指令包")
    e.add_argument("node", help="目标节点（文件夹相对路径）")
    e.add_argument("--root", default=".")
    e.add_argument("--out", help="输出目录；不给就打印到标准输出")
    e.add_argument("--json", action="store_true", help="输出 manifest JSON")
    e.add_argument("--force", action="store_true", help="图不合法也导出（不推荐）")
    e.set_defaults(func=cmd_export)

    cv = sub.add_parser("canvas", help="把图渲染成可下钻的画布（静态 HTML，离线可开）")
    cv.add_argument("--root", default=".")
    cv.add_argument("--out", help="输出目录；默认 <项目根>/.canvas")
    cv.add_argument("--open", action="store_true", help="生成后用浏览器打开")
    cv.set_defaults(func=cmd_canvas)

    ap = sub.add_parser("app", help="打开桌面画布（可拖拽、可新建、可连线）")
    ap.add_argument("--root", default=".")
    ap.add_argument("--port", type=int, default=0, help="端口；0 = 随机挑一个空闲的")
    ap.add_argument("--no-window", action="store_true", help="只起服务、不弹窗（调试用）")
    ap.set_defaults(func=cmd_app)

    rf = sub.add_parser("refs", help="看这张图引用了哪些外部契约、是否还一致")
    rf.add_argument("--root", default=".")
    rf.set_defaults(func=cmd_refs)

    us = sub.add_parser("usage", help="反查：这份契约被哪些图、哪些节点引用")
    us.add_argument("contract", help="契约所在的文件夹路径")
    us.add_argument("--scan", action="append", help="在这些目录里找图；可重复。默认找它的兄弟目录")
    us.set_defaults(func=cmd_usage)

    pn = sub.add_parser("pin", help="钉住被引用契约的当前版本")
    pn.add_argument("--root", default=".")
    pn.add_argument("--module", help="只更新这个模块的引用")
    pn.add_argument("--target", help="只更新指向这个目标路径的引用")
    pn.add_argument("--dry-run", action="store_true")
    pn.set_defaults(func=cmd_pin)

    n = sub.add_parser("new", help="按模板新建一个节点的说明书")
    n.add_argument("path", help="节点文件夹（相对项目根）")
    n.add_argument("--root", default=".")
    n.add_argument("--name")
    n.add_argument("--kind", choices=["module", "class"], default="module")
    n.add_argument("--class", dest="klass", help="类级节点的类名")
    n.add_argument("--file", help="类级节点所属文件的定位字段")
    n.add_argument("--force", action="store_true")
    n.set_defaults(func=cmd_new)

    v = sub.add_parser("version", help="版本")
    v.set_defaults(func=cmd_version)

    return p


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    argv = list(sys.argv[1:] if argv is None else argv)
    commands = {"check", "list", "export", "pin", "new", "refs", "usage", "canvas", "app", "version"}
    # 双击 exe 或只给 `--root X` 时默认进桌面应用，不必记住子命令
    if not argv or (argv[0] not in commands and argv[0] not in ("-h", "--help")):
        argv = ["app"] + argv
    if argv[:1] == ["app"] and "--root" not in argv:
        argv += ["--root", str(Path.cwd())]
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())


