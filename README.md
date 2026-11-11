<!-- 写作规范见 playbooks/reference/readme.md；与 README.en.md 保持相同章节。 -->

# Impl Gate

简体中文 | [English](README.en.md)

<!-- npm:start -->[![npm](https://img.shields.io/npm/v/dsh-impl-gate?logo=npm)](https://www.npmjs.com/package/dsh-impl-gate) <!-- npm:end -->[![Maintained with RED](https://img.shields.io/badge/maintained_with-RED-C1121F)](https://github.com/exoticknight/red)

把 IMPL-GATE 的 32 条断言变成三个可调用的 DSH 工具：给一个 spec-graph 根目录，返回 PASS / FAIL / NOT-RUN 和每条的证据。

## 这是什么

> 第一次用？直接看 [五分钟上手](docs/QUICKSTART.md)：一句需求 → SPEC → 评审 → 任务卡 → 证据。

- **调用而非重写**：每次检查都 spawn `python -m specgraph check --json`，图的问题按原样返回（`graphIssues` + `graphExitCode`）。
- **32 条逐条裁决**：A（交付物）、B（实现边界）、M（模块/导入）、Q（质量）四组，每条产出 `status` + `evidence`（≤2 KB）；判不了的写 NOT-RUN，不猜。
- **七个工具**：`impl_gate_check` 跑一次并缓存；`impl_gate_report` 读缓存出汇总与勾选表；`impl_gate_verify_contract`（额外给 `delivery`：B1/B2/B5/B7） 只复核 A1–A5；`impl_gate_compose` 出契约图谱与 SPEC；`impl_gate_init` 出多 AI 并行任务卡；`impl_gate_review` 把「每个模块能不能直接开工」的评审落到 `.impl-gate/review.json`；`impl_gate_record` 跑 plan 里的验收命令，把实现证据写进 `.impl-gate/ac-evidence.json`。

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

返回值里还有 `passed[]`、`failed[]`、`notRun[]`、`evidence[]`（`{id,text}`）、`graphIssues[]`、`graphExitCode`、`runId`；录过评审与实现证据后还会带上 `review`、`implementation` 和 `consistency`（两者矛盾时逐条说明，0.4.4）。把 `runId` 交给 report / verify_contract 即可复用同一次运行结果；`report` 还会给出 `readiness`（这份文档能不能交出去、不能的话卡在哪，0.4.5）。

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
- `evidence` 必须以 `command:` 或 `file:` 开头；`command:` 要带 `exit: <code>`，`file:` 要带 `:line`。A3 会抽 3 条命令复跑并比对声明的退出码；`file:` 指向的文件若存在，还会检查行号不超过该文件行数（文件不存在则跳过，允许引用尚未写出的实现文件）。
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
| `impl_gate_verify_contract`（额外给 `delivery`：B1/B2/B5/B7） | `root`（必填）、`runId` | 只复核 A1–A5，不重跑其他断言 |
| `impl_gate_compose` | `outDir`（必填）、`requirement`、`name`、`stack`、`mode`、`overwrite`、`specgraphCwd` | `plan` 写 `compose-plan.json` 与 `SPEC-DRAFT.md`（plan 已存在则 `E_PLAN_EXISTS`，不会覆盖）；`draft` 只按现有 plan 刷新 `SPEC-DRAFT.md`，从不写 plan；`materialize` 生成图谱、`SPEC.md`、`export/`、`.impl-gate/checklist.md` 与 `.impl-gate/mapping.md` |
| `impl_gate_init` | `outDir`（必填）、`implRoot`、`overwrite` | 按波次生成 `<outDir>/tasks/`：`TASKS.md`、`cards.json`、`wave-<n>/<id>-<dir>.md`；不改图谱、`SPEC.md`、`export/` |
| `impl_gate_review` | `outDir`（必填）、`reviewer`（必填）、`round`、`verdicts`（必填） | 追加一轮评审到 `<outDir>/.impl-gate/review.json`：每模块 `ready`/`clarify`/`blocked`，`blocked` 带 `blocking[]`；同轮重复提交拒绝 |
| `impl_gate_record` | `outDir`（必填）、`implRoot`、`modules`、`timeoutMs`、`dryRun` | 执行 plan 里每条 AC 的 `test` 命令（只认白名单首词），把 PASS/FAIL、退出码、日志尾部写进 `.impl-gate/ac-evidence.json`；`tasks/` 存在时同时刷新 `tasks/EVIDENCE.md`。同一 plan 下多次调用会累积证据：只带 `modules` 重跑某几个模块时，其他模块上次的记录保留 |

### 实现证据（0.3.6）

评审判的是文档，`impl_gate_record` 判的是代码对文档的执行结果。

```text
impl_gate_record({ outDir: "D:/proj/order-service", implRoot: "D:/code/order-service", dryRun: true })
impl_gate_record({ outDir: "D:/proj/order-service", implRoot: "D:/code/order-service", modules: ["M2"] })
```

- 命令来自 plan 的 `modules[].acceptance[].test`，不是 gate 的 32 条断言（后者是符号名，不可执行）
- 只执行首词在白名单里的命令（`pnpm`/`npm`/`node`/`python`/`git`/…），其余记 `SKIPPED` + `RUNNER_NOT_ALLOWED`
- 结果写 `.impl-gate/ac-evidence.json`（结构与 `summary`/`items` 同工具输出），`tasks/EVIDENCE.md` 是人类可读版
- 失败不中断：每条都跑，最后给 `PASS/FAIL/SKIPPED` 汇总；失败项的日志尾部直接进渲染
- 这是「实现进度」的证据，不改变 gate 的 32 条判定，也不自动勾选 `.impl-gate/checklist.md`
- `impl_gate_check` 会读这份文件并多打一行 `implementation evidence: PASS x / FAIL y / SKIPPED z (n AC)`；若证据是在旧 plan 上跑的，会提示重跑
- 同一份 plan 下多次调用会累积：只带 `modules` 补跑某几个模块时，其他模块上次的证据保留；plan 改过则整体重来（0.3.11）

### 评审留痕（0.3.1）

`SPEC.md` 好不好，不能只看机器校验通没通——机器查引用闭合、表归属、路由声明，查不出「这个模块照着文档能不能直接写」。所以把「评审」变成一个可留痕的动作：

```
impl_gate_review({
  "outDir": "D:/work/account-service",
  "reviewer": "reviewer-agent-3",
  "verdicts": [
    { "module": "M1", "status": "ready" },
    { "module": "M3", "status": "blocked", "blocking": ["createBooking 没拿到 employeeId"] }
  ]
})
```

- 三态：`ready`（能直接开工）、`clarify`（开工会上问一句就能开工）、`blocked`（照文档写不出来）。
- 过线标准是 **`blocked == 0 且 blocking == 0`**，不是「比例好看」；同一份文档换评审者分数会差很多，比例不可复现。
- 每轮写一行到 `.impl-gate/review.json`，按 `round` 递增、同轮拒绝覆盖；换评审者/换轮次都留痕。
- 每轮同时记下 `compose-plan.json` 与 `SPEC.md` 的 sha256（0.3.5），下一轮 sha 变了才说明评审的是新版；返回值还带 `blocking vs 上一轮` 的增减。
- 每条 verdict 可带 `evidence: "SPEC.md:<行号>"`（0.3.5），把结论钉到原文；指不到行号等于没查。
- 评审只写证据，不改 `SPEC.md`、plan 或图谱；要改的是 plan，改完重跑 materialize，再评下一轮。
- `impl_gate_check` 会回显最新一轮（0.3.14）：`review: round N by … — ready a / clarify b / blocked c (blocking d)`；若这一轮评审时的 plan 与当前 `compose-plan.json` 不同，追加一行提示重评。

### `impl_gate_compose` 的输出结构

```text
<outDir>/
├── compose-plan.json
├── SPEC.md                    ← 与 graphRoot 同级，不放进图里
├── .impl-gate/
│   ├── checklist.md           ← 32 行骨架，materialize 生成
│   └── ownership.json
├── export/
│   ├── export.md
│   └── manifest.json
└── <name>/                    ← graphRoot
    ├── graph.toml
    └── <模块目录>/spec.md
```

`SPEC.md` 放在 `outDir` 根而不是图根：spec-graph 在 Windows 上大小写不敏感，图根里的 `SPEC.md` 会被当成根节点 `spec.md`，触发 `SECTION_MISSING`、`IMPL_LANGUAGE` 等误报。`ownership` 会登记它，spec-graph 的 `check` 看不到它（预期），见偏离 D-13。

**填 plan 的安全循环**：`mode:"plan"` 只在目录为空时生成模板；第二次调用会返回 `E_PLAN_EXISTS` 而不是覆盖。要边写边看草稿，用 `mode:"draft"`——它按现有 plan 重写 `SPEC-DRAFT.md`，从不写 plan。确实要从头再来时才用 `plan` + `overwrite:true`，旧的 plan 会先备份成 `compose-plan.backup-<YYYYMMDDTHHMMSS>.json`。

**迁移文件归属**：每张有 `owner` 的表，其 owner 模块的 `files` 里必须出现一个 `migrations/*.sql`（如 `user-service/migrations/001_users.sql`），否则 `validatePlan` 报 `/data/<i>/owner: owner module "M2" of table "users" has no migration file`。这保证建表 DDL 有唯一归属，不会被六个模块各写一份。

**目标编号与覆盖缺口**：`SPEC.md` 第 1 节把每个目标渲染成 `G1…`，模块验收条目用 `acceptance[].covers:"G3"` 指回来；有 goal 没被任何 AC 覆盖时，第 6 节表格下方会打印「覆盖缺口：G3 没有验收断言对应的 `covers`」，方便开工会上补。

**运行与部署、接口示例（0.3.1）**：`runtime`（`port`/`start`/`health`/`migrate`/`rollback`）渲染到 `SPEC.md` 8.1 节，缺省会写明「开工会上确认」；`http[].reqExample`/`resExample` 必须是合法 JSON，渲染到 4.4 节每条路由下。

**关键流程（0.3.1）**：`flows[]` 写跨模块调用顺序——`{id:"F1",name,trigger,steps:[{module,action,note?}],success,failure?}`。`action` 必须是该模块某条 expose 签名的首标识符，`failure` 里的码必须在 `errors` 中声明；生成后出现在 `SPEC.md` 5.1 节，任务卡 4.2 节会写「你在第几步」。

**契约字段（0.3.0）**：`http[].auth` 三选一 `public|session|admin`（缺省按 `public` 渲染）、`res:"void"` 渲染成「204（无响应体）」；`errors[].by` 写抛出模块 id，4.3 打印「归属模块」列，模块不存在会报 `/errors/<i>/by: module "M9" does not exist`。

**成功状态码与响应头（0.3.2）**：`http[].status` 写成功状态码（不写默认 200，`res:"void"` 默认 204；写了 204 却不是 `void`、或 `void` 写了非 204，都会 `PLAN_INVALID`）；`http[].resHeaders` 写属于契约的响应头（如 `{"X-Row-Count":"<int>"}`），4.4 节单独列出「响应头（契约的一部分）」。GET/DELETE 的 `reqExample` 现在标成「查询参数示例」，不再冒充请求体。

**验收表骨架**：materialize 会按 `checks/impl-gate.checks.json` 写 `.impl-gate/checklist.md`——32 行、全是 `NOT-RUN / NOT_IMPLEMENTED`、evidence 指向 `SPEC.md:1`，并带 `## 未覆盖` 段。用 `impl_gate_check` 配 `implRoot=<outDir>` 跑一次，设计阶段能判的 A1–A5、B2、B7、Q10 会直接给出结论（实测 `PASS 8 / FAIL 0 / NOT-RUN 24`）；其余行等实现证据。

**重跑不丢证据（0.3.1）**：改 plan 后再次 `materialize` 只重写 `NOT-RUN` 行；已填 `PASS`/`FAIL` 的行连同 evidence 原样保留，旧文件先备份到 `.impl-gate/checklist.md.bak-<时间戳>`，结果里带 `checklistPreserved` 与 `checklistBackupPath`。注意 `impl_gate_check` 只看 `NOT-RUN` 与 `## 未覆盖` 是否对称——保留行不会因为 plan 改了而被判失效，这是有意的：改 plan 后请人工复核保留行的 evidence 是否仍成立。

**warnings**：`materialize` 会返回一组「能生成、但这里还有洞」的提示，共 30 类，**不拦截生成**。按「改 plan 才能消 / 开工会上问一句 / 可能误报可留」三组整理在 [docs/WARNINGS.md](docs/WARNINGS.md)，每类都写了触发条件与消法。

- `STATUS_DEFAULTED`：POST/PATCH/PUT/DELETE 没写 `status`，渲染时只能按 200 兜底（`res:"void"` 除外）；这类默认值是猜的，不是决定
- `LIST_ORDER_UNDEFINED`：返回列表类类型（`XxxList`/`XxxPage`/数组字段就是载荷）却既没有 `query` 里的 `orderBy`/`sortBy`，模块约束里也没写排序口径
- `PATCH_NULLABLE_AMBIGUOUS`：PATCH 的请求类型每个字段都可空，实现者无法区分「没提供」与「显式置空」
- `BOUNDARY_UNUSED`：`boundaries` 里声明了某个外部依赖，但技术栈、约束、文件与交付物里再没出现过它
- `WRITE_NO_VALIDATION_ERROR`：POST/PATCH/PUT 带请求体，而整份 plan 一个 400/422 都没有——参数错了回什么只能靠实现者猜（集中式校验、错误码归壳模块的情况不算）
- `TYPE_OWNER_NO_SOURCE`：类型写了 `owner`，但该模块的白名单里没有一个源码文件（只有 `.sql`/`.md`），实现者没地方「定义并导出」它
- `IN_MEMORY_VS_TABLE`：库表声明某模块负责写，该模块的职责/约束却说「在内存里存」——两边都像真的，实现者只能二选一
- `TOOLING_UNOWNED`：验收写了可执行命令，却没有任何模块拥有 `package.json`（或 `pyproject.toml`/`go.mod` 等清单）——第一个实现者只能自己发明工具链
- `AC_STATUS_CONTRADICTION`：AC 里写「返回 201」，而同一路由在 `http[]` 声明的是 200（或反过来）——一处说成功码 201、一处按 200 兜底，实现者只能二选一
- `OPEN_QUESTIONS_PENDING`：plan 的 `openQuestions` 还有未决项——它们会被渲染到附录 A，但开工时没人翻附录；materialize 时把条数与内容提出来，评审会上先拍板
- `AC_TEST_UNRUNNABLE`：验收命令的首词不在 `impl_gate_record` 的白名单里（或干脆没写命令）——它跑起来会成为一条 `RUNNER_NOT_ALLOWED` 的 SKIPPED，等于没有证据；常见写法是 `npx vitest run …` 而不是 `人工核对`

（`AC_SHELL_LATER` 0.3.8 起只报「调用了别的模块的路由」；模块自己拥有那条路由时，测试可以自己挂 app，不再误报。）

**实测（最小 e2e）**：单模块、90 行任务卡，交给没读过 plan 的实现者，写出 3 个文件、5/5 测试通过；impl_gate_record 出 PASS 3，impl_gate_check 回显同一份证据。它提出的 5 个「文档没写」问题、以及这次暴露的两个 gate 误判，都记在 [docs/CASE-STUDY-mini.md](docs/CASE-STUDY-mini.md)。
**实测（完整项目）**：同一句需求生成的 7 模块、24 路由、47 KB SPEC，由 6 个独立实现者只读任务卡写成，`impl_gate_record` 一次 21/21 PASS，`impl_gate_check` 回显同一份证据；实现者暴露的 9 个留白里有 5 个已回灌契约且代码零改动。过程与数字见 [docs/CASE-STUDY-run-log.md](docs/CASE-STUDY-run-log.md)。
**实测（盲测 + 六轮评审）**：一句家用需求（药箱提醒）生成 9 模块、22 路由、1114 行 SPEC；六轮独立评审把 blocking 从 2 压到 0，最终 9/9 模块可开工；其中三类「散文与类型表不一致」被固化成了机检警告。过程与数字见 [docs/CASE-STUDY-pillbox.md](docs/CASE-STUDY-pillbox.md)。


**共享类型归属（0.3.3）**：`types[].owner` 写「哪个模块的文件定义并导出它」，渲染成类型块下的「归属：M1」。跨模块共用的类型没有 `owner` 时 materialize 会出 `TYPE_OWNER_MISSING` 警告——这正是「六个 DTO、六份各不相同的形状」的来源。

**错误对象契约（0.3.3）**：`SPEC.md` §8 的接口约定固定写死一条——抛出的值必须是 `instanceof Error`，带 `code: string`（取自 §4.3）与可选 `details: unknown`，不要另造裸对象。AC 里断言 `err.code` 时按这条实现。

**查询参数（0.3.4）**：`http[].query` 写 `{name, type, required?}`（不写 `required` 视为可选），4.4 节单独列出「查询参数（契约的一部分）」；`type` 若是大写开头的自定义类型，必须已在 `types` 声明，否则 `/http/<i>/query/<j>/type: unknown type "Nope"`。

**陈旧产物检测（0.3.1）**：`ownership.json` 现在记 `plan_sha256`、`generated_at` 与真实版本号（`managedBy: dsh-impl-gate@<version>`）。改了 `compose-plan.json` 但没重跑 materialize / init 时，`impl_gate_check` 会多打一行 `stale design: …`，提示 SPEC、验收表与任务卡都过期。

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
| `E_NO_PRIOR_RUN` | 无缓存：没跑过、跨了根目录，且 `<graphRoot>/.impl-gate/runs/` 里也没有这个 runId |
| `E_RUN_EXPIRED` | 内存缓存超过 10 分钟，磁盘上也没有可用的记录 |
| `E_INTERNAL_INCONSISTENT` | 32 条分区不干净，或未覆盖集合与 NOT-RUN 不一致 |
| `PYTHON_ENV_MISSING` | 解释器导入不了 specgraph（compose 写盘前 preflight 失败；check/export 返回非 JSON 失败） |
| `PLAN_HAS_CYCLE` | `impl_gate_init`：plan 的模块依赖成环；由 `validatePlan` 的环检测转出，`code` 是原因串而非 §5 错误码，message 带 `A → B → A` |
| `E_PLAN_EXISTS` | `impl_gate_compose` 的 `plan` 模式：`compose-plan.json` 已存在且未传 `overwrite:true`。用 `mode:"draft"` 刷新草稿，或显式 `overwrite:true`（会先写 `compose-plan.backup-<时间戳>.json`） |
| `PLAN_INVALID` | plan 没填或填错；`problems[]` 逐条带 JSON Pointer，例如 `/stack must be a non-empty string`、`/data/0/owner must be a non-empty string` |
| `PLAN_MISSING` | `materialize` 与 `init` 找不到 `compose-plan.json` |
| `GRAPH_INVALID` | 物化出的图没过 spec-graph 的 check，`graphIssues` 原样返回 |
| `EXPORT_REFUSED` | 图不合法，或 `init` 的目标目录已存在（加 `overwrite:true`） |

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

- 运行记录按 `runId` + 规范化根目录存两处：内存 10 分钟，`<graphRoot>/.impl-gate/runs/<runId>.json` 保留 24 小时；插件热重载后 report / verify_contract 仍能按 runId 或「该根最近一次」读回。
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

源码安装时插件通过 `dsh plugin add <repo>` 以 link 方式挂进 profile。改完代码执行 `pnpm verify` 后，**热加载不会自动发生**：需要让 profile 重新 reconcile 一次，最稳妥的是在 GUI 的插件页把 `dsh-impl-gate` 关掉再打开；只改文件或只改 mtime 不会触发重载。重载后先确认工具列表里有 `impl_gate_check` / `impl_gate_report` / `impl_gate_verify_contract`（额外给 `delivery`：B1/B2/B5/B7），再调用。

更多细节见 [docs/development.md](docs/development.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)。使用 AI agent 开发、发布或维护时，让它先读 [AGENTS.md](AGENTS.md)。

## 许可证

[Apache License 2.0](LICENSE)




