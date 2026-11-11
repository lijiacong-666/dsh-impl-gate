# specgraph 引擎：随插件自带（0.4.45 起）

`dsh-impl-gate` 不重写契约图的校验器——它每次都用 `python -m specgraph check --json` 把图交给 specgraph，按原样返回错误。

从 **0.4.45** 起，npm 包里带了一份固定版本的引擎（`engine/specgraph/`），所以：

- **安装插件后只需要 Python ≥ 3.11**，不必另外 `pip install` 或 clone 仓库；
- 物化与验收（`impl_gate_compose mode:"materialize"`、`impl_gate_check`）开箱即用；
- 引擎只在 `python -c "import specgraph"` 失败时启用——你本地已有的 spec-graph 检出**优先**，不会悄悄换版本。

## 1. 确认 Python

```sh
python --version
```

要求 **Python ≥ 3.11**（引擎只用标准库 `tomllib`，无第三方依赖）。Windows 上如果 `python` 指向应用商店占位符，请把真实解释器的绝对路径填进 `pythonPath`。

## 2. 什么都不用装

第一次 `impl_gate_compose(mode:"materialize")` 会自动找到插件自带的引擎：

```
<profile>/node_modules/dsh-impl-gate/engine/specgraph/
```

`A1` 的证据行会带 `specgraph_home=<路径>`；其中 `…/node_modules/dsh-impl-gate/engine` 就是自带引擎。

## 3. 想用别的 specgraph（可选）

优先级从高到低：

| 方式 | 用法 |
|---|---|
| 工具参数 | `impl_gate_compose(..., specgraphCwd: "D:/path/to/spec-graph")` |
| 配置项 | `specgraphCwd`（插件设置里填绝对路径） |
| 环境变量 | `SPECGRAPH_HOME=<目录>` |
| 自动上溯 | 从 `outDir` 逐级向上找 `specgraph/`、`spec-graph/specgraph/`、`specgraph/specgraph/` |
| 自带引擎 | 随 npm 包发布的 `engine/`（最后兜底） |

显式指定的目录会注入 `PYTHONPATH`，所以未安装的源码检出也能直接用。

## 4. 常见报错

| 现象 | 含义 | 处理 |
|---|---|---|
| `PYTHON_ENV_MISSING` | 探测到的 Python 里 `import specgraph` 失败，且自带引擎也没跑起来 | 装 Python ≥ 3.11；或用 `pythonPath` 指向真实解释器；或显式 `specgraphCwd` |
| `graphExitCode` 非 0 + `graphIssues` | 图本身不合法（specgraph 的判定，不是插件） | 按 issue 的 `code`/`node`/`item` 改 `spec.md` 或 `graph.toml` |
| `E_ROOT_MISSING` | `graphRoot` 不存在或指错层 | 指向含 `graph.toml` 的目录 |

## 5. 为什么仍然保留「外部 specgraph」的位置

specgraph 是独立的规格校验器，有自己的版本与语义。插件带的是**一份固定的、随插件升级的副本**；如果你在跟进上游改动，显式指 `specgraphCwd` 即可覆盖，判定口径仍然只来自 specgraph 本身——插件只编排、不重写。