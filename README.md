<!-- 写作规范见 playbooks/reference/readme.md；与 README.en.md 保持相同章节。 -->

# Impl Gate

简体中文 | [English](README.en.md)

<!-- npm:start -->[![npm](https://img.shields.io/npm/v/dsh-impl-gate?logo=npm)](https://www.npmjs.com/package/dsh-impl-gate) <!-- npm:end -->[![Maintained with RED](https://img.shields.io/badge/maintained_with-RED-C1121F)](https://github.com/exoticknight/red)

把 IMPL-GATE 的 32 条断言变成三个可调用的 DSH 工具：给一个 spec-graph 根目录，返回 PASS / FAIL / NOT-RUN 和每条的证据。

## 这是什么

- **调用而非重写**：每次检查都 spawn `python -m specgraph check --json`，图的问题按原样返回（`graphIssues` + `graphExitCode`）。
- **32 条逐条裁决**：A（交付物）、B（实现边界）、M（模块/导入）、Q（质量）四组，每条产出 `status` + `evidence`（≤2 KB）；判不了的写 NOT-RUN，不猜。
- **五个工具**：`impl_gate_check` 跑一次并缓存；`impl_gate_report` 读缓存出汇总与勾选表；`impl_gate_verify_contract` 只复核 A1–A5；`impl_gate_compose` 出契约图谱与 SPEC；`impl_gate_init` 出多 AI 并行任务卡。

## 不做什么

- 不建图、不改被测项目的 `spec.md` / `graph.toml`、不生成代码；临时文件只写系统临时目录。
- 不解析被测项目源码（只读 `mapping.md`、勾选表，以及 A5 前后的契约文件哈希）。
- 不联网；Q4（网络阻断）永远 NOT-RUN，不会发起请求。
- 不做 GUI 自动判定：M7 / M10 恒为 NOT-RUN，reason `GUI_REQUIRES_MANUAL_CHECK`。
- 不内联、不读取 specgraph 的内部模块；它不可用时如实返回错误码。

## 最小可跑例子

```sh
# 桌面版把 --profile headless 换成你的 profile（例如 desktop）
dsh plugin --profile headless add dsh-impl-gate
```

然后调用一次（`graphRoot` 换成你的图根）：

```json
{ "graphRoot": "D:\\work\\my-graph", "implRoot": "D:\\work\\my-impl" }
```

真实输出（本机 examples/01 + 测试用 implRoot）：

```text
impl_gate_check run-mw633k0l-6039b086: PASS 10 / FAIL 0 / NOT-RUN 22 (32)
NOT-RUN: B3, B4, B6, M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8, Q9
```

返回值里还有 `passed[]`、`failed[]`、`notRun[]`、`evidence[]`（`{id,text}`）、`graphIssues[]`、`graphExitCode`、`runId`。把 `runId` 交给 report / verify_contract 即可复用同一次运行结果。

<!-- npm:start -->

### 从 npm 安装（推荐）

```sh
dsh plugin --profile headless add dsh-impl-gate
```

<!-- npm:end -->

安装后重启 DSH（桌面版请重启应用），刷新页面。命令会装到你平时使用的 DSH；如果你设置了自己的 `DSH_HOME`，请在同一个环境中运行。从源码安装用于开发调试，见 [docs/development.md](docs/development.md)。

## 实测：会议室预订

给一句话需求「企业级会议室预订」，让未参与开发的模型只读 `playbooks/compose.md` 写 `compose-plan.json`，再经 `impl_gate_compose` 物化，交独立评审判「能不能直接开工」。最终产物：**632 行 SPEC.md / 7 个模块 / 5 个波次 / 36 条 AC / 21 个错误码 / 11 条路由 / 5 张表**。

| 轮次 | 可开工 | blocking | 主要缺口 |
|---|---|---|---|
| 1 | 1/7 | 3 | 身份没进签名、错误构造两参带不了 conflicts、无共同事务 |
| 2 | 1/7 | 1 | 系列展开缺 employeeId 通道 |
| 3 | 3/7 | 0 | 约束整节没渲染（渲染器 bug，已修 G8.1） |
| 4 | 作废 | — | 宿主跑旧构建，产物无 §3.1 |
| 5 | 2/7 | 0 | 字段三套名、白名单缺文件、取消只能消一行 |
| 6 | 1/7 | 8 | 错误通道、取消顺序、跨包外键、校验归属、cron/AC、事务边界 |
| 7 | — | **0** | 修 2 处残留后清零，SPEC 632 行 / 36 AC |

评审由模型自评，blocking 的定义见 [`playbooks/review.md`](playbooks/review.md)，ask 类留给开工会议。

## 输入格式

### 勾选表 `<implRoot>/.impl-gate/checklist.md`

四列表格，32 行，id 不重不漏：

```markdown
| id | status | evidence | reason |
|----|--------|----------|--------|
| A1 | PASS | command: python -m specgraph export 支付服务 --root <graphRoot> --out <tmp>; exit: 0 |  |
| B1 | FAIL | command: python tools/check_mapping.py; exit: 1 |  |
| Q1 | NOT-RUN | file: docs/q1.md:12 | SLOW_CHECK_DISABLED |

示例只列 3 行（真实文件 32 行）。`<graphRoot>`、`<tmp>` 这类尖括号是占位符，重放时跳过：A3 采样和 M/Q 重放都不会执行带占位符的命令。
```

- `status` 只能是 `PASS`、`FAIL`、`NOT-RUN`。
- `evidence` 必须以 `command:` 或 `file:` 开头；`command:` 要带 `exit: <code>`，`file:` 要带 `:line`。A3 会抽 3 条命令复跑并比对声明的退出码。
- `reason` 仅 `NOT-RUN` 时必填，且必须来自下面的 NOT-RUN 码表；其余状态留空。
- NOT-RUN 的条目还要列进 `## 未覆盖` 段，A4 要求两边集合相等。

### 映射表 `<implRoot>/.impl-gate/mapping.md`

三列表格，覆盖图里所有「需要」条目：

```markdown
| 需求ID | 模块 | 条目 |
|--------|------|------|
| N1 | 支付服务 | E1 |
| N2 | 订单服务 | E2 |
```

表头三列名固定；「模块」必须是图里真实存在的节点（文件夹路径），每行都要填满。B5 要求每个模块至少出现一次。

## 工具参数

| 工具 | 参数 | 说明 |
|------|------|------|
| `impl_gate_check` | `graphRoot`（必填）、`implRoot`、`checklistPath`、`slow` | 跑一次；`checklistPath` 缺省 `<implRoot>/.impl-gate/checklist.md` |
| `impl_gate_report` | `root`（必填）、`runId` | 读缓存汇总；无 `runId` 时取该根最近一次运行 |
| `impl_gate_verify_contract` | `root`（必填）、`runId` | 只复核 A1–A5，不重跑其他断言 |
| `impl_gate_compose` | `outDir`（必填）、`requirement`、`name`、`stack`、`mode`、`overwrite`、`specgraphCwd` | `plan` 写 `compose-plan.json` 与 `SPEC-DRAFT.md`；`materialize` 生成图谱、`SPEC.md` 与 `export/` |
| `impl_gate_init` | `outDir`（必填）、`implRoot`、`overwrite` | 按波次生成 `<outDir>/tasks/`：`TASKS.md`、`cards.json`、`wave-<n>/<id>-<dir>.md`；不改图谱、`SPEC.md`、`export/` |

### `impl_gate_compose` 的输出结构

```text
<outDir>/
├── compose-plan.json
├── SPEC.md                    ← 与 graphRoot 同级，不放进图里
├── .impl-gate/ownership.json
├── export/
│   ├── export.md
│   └── manifest.json
└── <name>/                    ← graphRoot
    ├── graph.toml
    └── <模块目录>/spec.md
```

`SPEC.md` 放在 `outDir` 根而不是图根：spec-graph 在 Windows 上大小写不敏感，图根里的 `SPEC.md` 会被当成根节点 `spec.md`，触发 `SECTION_MISSING`、`IMPL_LANGUAGE` 等误报。`ownership` 会登记它，spec-graph 的 `check` 看不到它（预期），见偏离 D-13。

### 配置

| 键 | 默认值 | 说明 |
|----|--------|------|
| `enabled` | `true` | 启用插件。 |
| `specgraphCommand` | `python -m specgraph` | 调 specgraph 的命令；一般不用改。 |
| `pythonPath` | 空 | 替换命令首个 python 词元的解释器绝对路径。 |
| `specgraphCwd` | 空 | specgraph 子进程的 cwd；从源码用时指向 spec-graph 仓库。 |
| `timeoutMs` | `30000` | 单次 specgraph 调用超时；超时杀进程并返回 `E_TIMEOUT`。 |
| `implRoot` | 空 | 实现根缺省值；为空时等于 `graphRoot`。 |
| `slow` | `false` | 是否运行 slow 断言（Q1）。 |
| `allowCommandReplay` | `false` | 是否按证据命令重放 M/Q 断言（≤5 条、超时 120 s、首词限 `python`/`pnpm`/`node`、cwd 限 `implRoot`）。 |

**`pythonPath` 优先级**：配置的 `pythonPath` > PATH 上的 `python`。配置了且 `specgraphCommand` 首词是 python 时用它替换首词；否则原样调用。DSH 捆绑解释器不自动探测，需要时把它的绝对路径填进 `pythonPath`。

`specgraphCwd` 留空时会从 `graphRoot` 上溯查找 `specgraph/__init__.py`，找到就把该目录注入子进程的 `PYTHONPATH`（D-06）；解析到的路径写进 A1 证据。

## 错误码与 NOT-RUN 原因

| 错误码 | 含义 |
|--------|------|
| `E_ROOT_MISSING` | 根目录不存在或不是目录 |
| `E_PYTHON_MISSING` | 解释器找不到（spawn ENOENT） |
| `E_SPAWN_DENIED` | 无权限启动子进程（EPERM / EACCES） |
| `E_TIMEOUT` | 超过 `timeoutMs`，进程已杀 |
| `E_BAD_JSON` | specgraph 输出不是合法 JSON |
| `E_NO_PRIOR_RUN` | 无缓存：没跑过、跨了根目录，或插件热重载清空了缓存 |
| `E_RUN_EXPIRED` | 缓存超过 10 分钟 |
| `E_INTERNAL_INCONSISTENT` | 32 条分区不干净，或未覆盖集合与 NOT-RUN 不一致 |
| `PYTHON_ENV_MISSING` | 解释器导入不了 specgraph（compose 写盘前 preflight 失败；check/export 返回非 JSON 失败） |
| `PLAN_HAS_CYCLE` | `impl_gate_init`：plan 的模块依赖成环；由 `validatePlan` 的环检测转出，`code` 是原因串而非 §5 错误码，message 带 `A → B → A` |

| NOT-RUN reason | 触发场景 |
|----------------|----------|
| `MISSING_INSTRUCTION_PACKAGE` | A1：图里没有可导出的节点 |
| `CHECKLIST_NOT_PROVIDED` | A2–A4：勾选表缺失 |
| `IMPL_ROOT_NOT_PROVIDED` | B 组与 Q5–Q7：没给 `implRoot` 且无法与图根区分 |
| `LANGUAGE_UNSUPPORTED` | Q2：实现语言不在支持范围 |
| `SLOW_CHECK_DISABLED` | Q1：`slow=false` |
| `NETWORK_BLOCK_UNSUPPORTED` | Q4：本工具不联网 |
| `SCHEMA_UNAVAILABLE` | Q8：找不到可校验的 schema |
| `D4_GRAPH_INVALID` | 图不合法：32 条全 NOT-RUN，`graphIssues` 原样返回 |
| `GUI_REQUIRES_MANUAL_CHECK` | M7 / M10：需人工看 GUI |
| `NOT_IMPLEMENTED` | 该 id 还没有实现落点 |
| `MANUAL_REVIEW_REQUIRED` | B4：裁决记录由人维护 |
| `MAPPING_TABLE_NOT_PROVIDED` | B1：没有 `mapping.md` |
| `EXEC_DISABLED` | M/Q：未开 `allowCommandReplay`，或本轮 5 条预算用尽 |
| `HUMAN_PROCESS_REQUIRED` | B6：流程项（发布说明/提交信息）由人核对 |
| `EVIDENCE_TOKEN_UNSPECIFIED` | B3/重放：证据不是可执行命令 |

## 边界

- 缓存只在本进程内存里，按 `runId` + 规范化根目录存，TTL 10 分钟；插件热重载会清空，此时 `E_NO_PRIOR_RUN` 属正常，重跑一次 `impl_gate_check` 即可。
- `allowCommandReplay` 默认关闭，M/Q 共 15 条默认 `EXEC_DISABLED`；打开后也只跑前 5 条，其余标 `EXEC_DISABLED`（证据里 `skipped=replay_budget_exhausted`）。
- B3 / B4 / B6 恒 NOT-RUN（D-10）；B1 / B2 / B5 / B7 用的是可机械判定的代理口径（D-11），见下面「人工核对项」。
- Q4 不联网；M7 / M10 不做 GUI 自动判定。
- 图不合法时整份 32 条全 NOT-RUN，`graphExitCode` 非 0，`graphIssues` 原样返回（样例 02 即如此）。

## 偏离登记

与执行清单或任务书不一致的实现决定统一登记在 [docs/deviations.md](docs/deviations.md)（D-01 … D-16），README 只列结论。

## 人工核对项

清单原文里有四条偏流程/语义的断言，v1 不做机械判定，由人核对（D-11）：

1. 映射表行数 = manifest 条目总数（B1 原文）。
2. 实现里的导出符号 / 路由表 ⊆ 指令包暴露项集合（B2 原文）。
3. git 历史中每个模块提交后 1 次内出现对应测试运行记录（B5 原文）。
4. 任取一条 FAIL，其复现命令可原样执行，输出与报告一致（B7 原文）。

v1 的机械代理分别是：B1 检查 `mapping.md` 覆盖所有「需要」条目、B2 检查勾选表 id ⊆ checks.json id、B5 检查 mapping 每模块至少 1 行、B7 检查 FAIL 行带 `repro:`。代理项通过不等于原文四条已满足，交付时两者都要过。

## 更新、回滚与卸载

版本列表见 [npm 版本页](https://www.npmjs.com/package/dsh-impl-gate?activeTab=versions)。

更新或回滚时请写明版本号，然后重启 DSH（新版本发布后 24 小时内，不带版本号的安装命令可能仍会装到旧版本）：

<!-- npm:start -->

```sh
dsh plugin --profile headless add dsh-impl-gate@X.Y.Z
```

<!-- npm:end -->

卸载：

```sh
dsh plugin --profile headless remove dsh-impl-gate
```

卸载后不留下配置或数据；缓存随进程退出消失。

## 隐私与数据

- 不发起网络请求（Q4 也据此恒 NOT-RUN）。
- 读：`graphRoot` 下的 `spec.md` / `graph.toml`、`<implRoot>/.impl-gate/checklist.md`、`mapping.md`。
- 写：只写系统临时目录（导出指令包、A5 副本），结束即删；不写被测项目。
- 不保存凭据、不读环境里的密钥。

## 兼容性

见 [docs/compatibility.md](docs/compatibility.md)。

## 开发

```sh
pnpm install
pnpm verify        # typecheck → build lib/ → node --test → 包内容检查
```

源码安装时插件通过 `dsh plugin add <repo>` 以 link 方式挂进 profile。改完代码执行 `pnpm verify` 后，**热加载不会自动发生**：需要让 profile 重新 reconcile 一次，最稳妥的是在 GUI 的插件页把 `dsh-impl-gate` 关掉再打开；只改文件或只改 mtime 不会触发重载。重载后先确认工具列表里有 `impl_gate_check` / `impl_gate_report` / `impl_gate_verify_contract`，再调用。

更多细节见 [docs/development.md](docs/development.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)。使用 AI agent 开发、发布或维护时，让它先读 [AGENTS.md](AGENTS.md)。

## 许可证

[Apache License 2.0](LICENSE)