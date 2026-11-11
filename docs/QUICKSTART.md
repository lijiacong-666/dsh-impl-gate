# 五分钟上手

目标：把一句需求变成「另一个 AI 能直接开工」的详细设计文档。

## 0. 前提

- 宿主里装了 `dsh-impl-gate`，并且 `python` 能 `import specgraph`（装法见仓库 `spec-graph` 项目；插件会自己向上找，也可以显式配 `specgraphCwd`）。
- 确认工具在：问宿主「列一下 impl_gate 的工具」，应当看到 7 个：`check` / `report` / `verify_contract` / `compose` / `init` / `review` / `record`。

## 1. 让 AI 写 plan（不用手写 JSON）

把下面这段丢给任意一个 AI（它不需要读过本仓库，只需要能调用工具）：

```text
你是 impl-gate 的 plan 作者。先读 playbooks/compose.md（在 dsh-impl-gate 包里），
再读 src/host/compose/plan.ts 里的类型定义。

需求：<把你的一句话需求粘贴在这里>

按 playbook 的要求，把需求拆成 compose-plan.json，写到 <项目目录>/compose-plan.json。
写完先调用 impl_gate_compose（mode="plan"）确认它能被接受，再调用 mode="materialize"。
遇到 PLAN_INVALID 就按 JSON Pointer 修正，不要改工具。
```

它产出的是 `compose-plan.json`：模块、提供/需要、表、类型、错误码、路由、流程、页面、验收断言。

## 2. 物化

宿主里调用：

```text
impl_gate_compose outDir=<项目目录> mode=materialize
```

产物：

- `SPEC.md`——九节说明书（目标、边界、模块、数据、连线、验收、波次、约定、交付）
- `<name>/`——契约图谱（spec-graph 格式，可单独 `specgraph check`）
- `export/`——给实现者的指令包
- `.impl-gate/checklist.md` + `mapping.md`——验收表骨架
- `tasks/`——如已存在会自动刷新

看完 `SPEC.md`，先读最后的 warnings。它是「能生成但该被看见」的清单：

- `STATUS_DEFAULTED` / `LIST_ORDER_UNDEFINED` / `PATCH_NULLABLE_AMBIGUOUS`：决定没做，补进 `http[].status`、`query.orderBy`、`types` 的 nullable
- `CONSTRAINT_FIELD_UNKNOWN` / `QUERY_PARAM_UNMAPPED`：散文和类型表对不上
- `AC_SHELL_LATER` / `AC_HTTP_OUTSIDE_SHELL` / `TOOLING_UNOWNED`：波次与归属安排错了
- `OPEN_QUESTIONS_PENDING`：还没决定的事，开工会上要问

## 3. 评审（必须独立）

```text
impl_gate_review outDir=<项目目录> reviewer="judge-1" verdicts=[{module:"M1",status:"ready"}, ...]
```

判定只有三档：`ready` / `clarify` / `blocked`。过线条件是 **blocked 为 0 且 blocking 为 0**。
评审者必须只读 `SPEC.md`，不要读 plan，也不要读作者的解释——否则它会替作者补脑。

## 4. 分发

```text
impl_gate_init outDir=<项目目录>
```

每张卡带文件白名单、要提供的契约、要依赖的契约、验收命令。把卡分给不同的 AI，一次一波。

## 5. 回收证据

```text
impl_gate_record outDir=<项目目录> implRoot=<项目目录>
```

它会跑每条 AC 的验收命令、把退出码和日志尾部写进 `.impl-gate/ac-evidence.json` 与 `tasks/EVIDENCE.md`。
只跑部分模块也可以：`modules=["M2","M3"]`，其它模块的证据会保留。

最后：

```text
impl_gate_check graphRoot=<项目目录>/<name> implRoot=<项目目录>
```

`check` 会把实现证据和评审结论一起回显。32 条里 10 条能在设计/实现阶段判定，其余 22 条要么需要跑慢检查、要么是人工项——不要把 `PASS 10` 当成「做完了」。

## 常见问题

**plan 写不进去？** 报 `E_PLAN_EXISTS` 是保护：已填的 plan 不会被覆盖。想刷草稿用 `mode="draft"`；确实要重写用 `overwrite=true`（会先备份）。

**改了 plan，SPEC 没变？** 再跑一次 `mode="materialize"`；`impl_gate_check` 会提示 `stale design`。

**证据丢了？** 同一个 plan 下 `record` 会合并，不同 plan 哈希才会重置。改过 plan 就要重录。

**没有 specgraph 怎么办？** 先装它；插件不会替你装 Python 包。

**为什么评审说不能开工，工具却没说？** 工具查结构（引用闭合、归属、类型字段），查不了「这句话到底该不该这么写」。评审环节不能省。