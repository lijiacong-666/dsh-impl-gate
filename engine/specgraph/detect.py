"""实现细节检测。

这条规则天生是启发式的：只能做到「高置信度硬拦，可疑项提示」。
- error：代码块、函数/方法签名、类型声明、控制流、导入语句、文件路径
- warning：语言名、框架/中间件名
白名单：项目根目录 _whitelist.toml 的 allowed_terms 里出现的词，命中整行则放过。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

LANGUAGES = (
    "Go", "Golang", "Python", "Java", "JavaScript", "TypeScript", "Rust", "Kotlin",
    "Swift", "Scala", "Haskell", "Erlang", "Elixir", "Dart", "Lua", "Perl",
    "C++", "C#", "Objective-C", "VB.NET", "PHP", "Ruby",
)

FRAMEWORKS = (
    "Spring", "SpringBoot", "Spring Boot", "Django", "Flask", "FastAPI", "React", "Vue",
    "Angular", "Node.js", "Express", "Rails", "Laravel", "MyBatis", "Hibernate",
    "gRPC", "GraphQL", "Redis", "Kafka", "RabbitMQ", "MySQL", "PostgreSQL", "MongoDB",
    "Docker", "Kubernetes", "Nginx", "Netty", "Dubbo", "RocketMQ",
)

SIGNATURE_RULES = (
    (r"\bdef\s+\w+\s*\(", "函数定义（def）"),
    (r"\bfunction\s+\w*\s*\(", "函数定义（function）"),
    (r"\b(class|interface|struct|enum|trait)\s+[A-Za-z_]\w*\s*[\(\{:<]?", "类型声明"),
    (r"\b(public|private|protected|static|final|abstract)\s+[\w<>\[\],\s]+\s+\w+\s*[\(;=]", "带修饰符的成员声明"),
    (r"\)\s*->\s*[\w<>\[\]]+", "返回类型标注"),
    (r"^\s*(import|from|using|#include|require)\s+[\w\.\"'/<>{}\-]+", "导入语句"),
    (r"\breturn\s+[^。\n]{4,}", "返回语句"),
)

CLASS_STEP_RULES = (
    (r"\bif\s*\(", "条件分支语句"),
    (r"\bfor\s*\(", "循环语句"),
    (r"\bwhile\s*\(", "循环语句"),
    (r"\bswitch\s*\(", "分支语句"),
    (r"^\s*(var|let|const|val|int|string|bool)\s+\w+", "变量声明"),
    (r"=\s*(new\s+)?\w+\([^)]*\)", "实例化语句"),
)

PATH_RULE = re.compile(
    r"(?<![\w:/])[\w\-.]+(?:[/\\][\w\-.<>]+)+\.(py|pyi|ts|tsx|js|jsx|java|go|rs|cs|kt|swift|php|rb|c|cc|cpp|h|hpp|vue|sql|json|yaml|yml|toml)\b",
    re.IGNORECASE,
)
FENCE_RE = re.compile(r"^\s*```")


@dataclass
class Finding:
    code: str
    level: str
    message: str
    line: int


def _lang_re(word: str) -> re.Pattern[str]:
    return re.compile(rf"(?<![A-Za-z]){re.escape(word)}(?![A-Za-z])", re.IGNORECASE)


LANG_RES = tuple((_lang_re(w), w) for w in LANGUAGES)
FW_RES = tuple((_lang_re(w), w) for w in FRAMEWORKS)


def detect_line(line: str, *, strict_class: bool = False, whitelist: tuple[str, ...] = ()) -> list[Finding]:
    """对一行正文做检测。行号由调用方补。"""
    if not line.strip():
        return []
    for term in whitelist:
        if term and term in line:
            return []
    out: list[Finding] = []

    if FENCE_RE.match(line):
        out.append(Finding("IMPL_CODE_BLOCK", "error", "说明书里出现了代码块（```）。", 0))
        return out

    if PATH_RULE.search(line):
        out.append(Finding("IMPL_FILE_PATH", "error",
                           "说明书正文里出现了具体文件路径；路径若确实需要，请写进文件头的 file: 定位字段。", 0))

    for pattern, label in SIGNATURE_RULES:
        if re.search(pattern, line):
            out.append(Finding("IMPL_SIGNATURE", "error", f"说明书里出现了{label}，属于实现细节。", 0))
            break

    if strict_class:
        for pattern, label in CLASS_STEP_RULES:
            if re.search(pattern, line):
                out.append(Finding("IMPL_STEP", "error",
                                   f"类级节点里出现了{label}，属于实现步骤。只写它要满足什么，不写怎么做。", 0))
                break

    for rx, word in LANG_RES:
        if rx.search(line):
            out.append(Finding("IMPL_LANGUAGE", "error",
                               f"说明书里出现了具体语言「{word}」，实现语言由实现者自选。", 0))
            break

    for rx, word in FW_RES:
        if rx.search(line):
            out.append(Finding("IMPL_FRAMEWORK", "warning",
                               f"说明书里出现了框架/中间件「{word}」，建议只写要满足的约束。", 0))
            break

    return out


def scan_spec(spec, whitelist: tuple[str, ...] = ()) -> list[Finding]:
    """按原始行扫描，行号保持与文件一致；跳过文件头与标题行。"""
    findings: list[Finding] = []
    lines = spec.raw.splitlines()
    start = spec.fm_end_line  # 0 基即下一行
    strict = spec.kind == "class"
    for idx in range(start, len(lines)):
        line = lines[idx]
        if line.startswith("## ") or line.startswith("### "):
            # 标题里也可能藏着语言名，单独扫一遍但不做文件路径判断
            for rx, word in LANG_RES:
                if rx.search(line):
                    findings.append(Finding("IMPL_LANGUAGE", "error",
                                            f"标题里出现了具体语言「{word}」。", idx + 1))
                    break
            continue
        for f in detect_line(line, strict_class=strict, whitelist=whitelist):
            f.line = idx + 1
            findings.append(f)
    return findings