"""specgraph · 规格图谱

图的唯一真相源是文件夹里的三段式契约（spec.md）和访问关系（graph.toml）。
系统不生成、不保存、不追踪代码；代码由外部按契约一次性实现。
"""

__version__ = "0.9.2"

from .checks import Issue, Report, check  # noqa: F401
from .model import Project, Spec, load_project  # noqa: F401

__all__ = ["Issue", "Report", "check", "Project", "Spec", "load_project", "__version__"]


