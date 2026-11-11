# 安装 specgraph（`impl_gate_compose` / `impl_gate_check` 的前置依赖）

`dsh-impl-gate` 不重写契约图的校验器——它每次都用 `python -m specgraph check --json` 把图交给 specgraph，按原样返回错误。所以：

- **只做评审 / 证据**（`impl_gate_review`、`impl_gate_record`、`impl_gate_report`）不需要 specgraph；
- **物化与验收**（`impl_gate_compose mode:"materialize"`、`impl_gate_check`）需要。

## 1. 确认 Python

```sh
python --version
```

要求 **Python ≥ 3.11**（只用到标准库 `tomllib`，不装依赖）。Windows 上如果 `python` 指向应用商店占位符，请填绝对路径到 `pythonPath` 配置项。

## 2. 拿到 specgraph

```sh
git clone https://github.com/ruanjian/spec-graph   # 换成你实际可用的来源
cd spec-graph
python -m specgraph check examples/05-用户中心
```

最后一条能打印模块/提供/需要/连线数即为可用。

## 3. 告诉插件它在哪

三种方式，优先级从高到低：

| 方式 | 用法 |
|---|---|
| 工具参数 | `impl_gate_compose(..., specgraphCwd: "D:/path/to/spec-graph")` |
| 配置项 | `specgraphCwd`（插件设置里填绝对路径） |
| 自动上溯 | 不填时，从 `outDir` 逐级向上找 `specgraph/`、`spec-graph/specgraph/`、`specgraph/specgraph/`，找到即注入 `PYTHONPATH` |

自动上溯命中后，`A1` 的证据里会带 `specgraph_home=<路径>`，便于复核。

## 4. 常见报错

| 现象 | 含义 | 处理 |
|---|---|---|
| `PYTHON_ENV_MISSING` | 探测到的 Python 里 `import specgraph` 失败 | 用上面的三种方式指定 `specgraphCwd`，或把源码目录加进 `PYTHONPATH` |
| `graphExitCode` 非 0 + `graphIssues` | 图本身不合法（specgraph 的判定，不是插件） | 按 issue 的 `code`/`node`/`item` 改 `spec.md` 或 `graph.toml` |
| `E_ROOT_MISSING` | `graphRoot` 不存在或指错层 | 指向含 `graph.toml` 的目录 |

## 5. 为什么不做成内置

specgraph 是独立的规格校验器，有自己的版本与语义；把它内联进插件会让「谁判定的」变模糊，也违背 `dsh-impl-gate` 的边界（只编排、不重写）。插件能保证的是：**specgraph 不可用时如实报错，不假装通过**。