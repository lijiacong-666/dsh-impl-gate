# 偏离登记（Deviations）

本文件是偏离的**唯一维护位置**；`TASK-dsh-impl-gate-v1.md` §10 的表与这里内容必须一致，只改一处视为不合格。

| # | 偏离 | 理由 | 裁决 |
|---|---|---|---|
| D-01 | v1 不暴露清单 §6.1 的 specgraph 四工具 | 门禁层与适配层分离，v1 只做三个门禁工具 | 已批 |
| D-02 | 一致性测试落 `tests/checks-consistency.test.mjs`（非 `.ts`） | 模板测试跑 `node --test`，Node 22 不能直跑 TS；为保零依赖不引入 tsx | 已批 |
| D-03 | `dsh --profile desktop --dump-config` 不可用，改用 scratch-home 等价 dump + 活载 Inspect | 宿主 `rejectElectronProfile` 对 profile 名 `desktop` 名称级拦截 | 已批，标注 `ENV_LIMIT_PROFILE_GUARD` |
| D-04 | 新增 reason `MAPPING_TABLE_NOT_PROVIDED`（B1）、`MANUAL_REVIEW_REQUIRED`（B4） | §5 码表缺这两个场景 | 已批 |
| D-05 | Q4 为 `mode:notrun`，reason `NETWORK_BLOCK_UNSUPPORTED` | 插件无法屏蔽宿主网络，人工也核不出断网行为 | 已批 |
| D-06 | `specgraphCwd` 留空时从 `graphRoot` 上溯找 `specgraph/__init__.py` 并注入 `PYTHONPATH` | 源码态否则 `No module named specgraph` | 已批；解析到的路径必须写进 evidence |
| D-07 | 勾选表格式锁为四列 `id \| status \| evidence \| reason` | A2–A4 需要确定性解析 | 已批；Step 6 写进 README |
| D-08 | `package.json` 现已填真实 repository/homepage/bugs；README 仍不提供 GitHub 安装与 Release 链接 | 建仓后才有真实地址 | 已解决：本地仓库已填真实地址；npm 0.1.0 tarball 早于该字段，下个版本生效 |
| D-09 | `allowCommandReplay` 默认 `false`；M1–M6/M8/M9、Q2/Q3/Q5–Q9 默认 NOT-RUN `EXEC_DISABLED`；开启后 ≤5 条、120s、首词限 `python/pnpm/node`、cwd 限 `implRoot` | 重放证据命令有执行风险，默认关；重放是对这类断言唯一可机械判定的证据 | 已批（用户 m01090） |
| D-10 | B3/B4/B6 固定 NOT-RUN，reason 依次 `EVIDENCE_TOKEN_UNSPECIFIED` / `MANUAL_REVIEW_REQUIRED` / `HUMAN_PROCESS_REQUIRED` | 语义检索、裁决记录、流程纪律无法机械判定 | 已批（用户 m01090） |
| D-11 | B1/B2/B5/B7 判定口径改为：mapping.md 覆盖全部「需要」条目 / 勾选表 id ⊆ checks.json id / mapping 每模块≥1 行且模块真实 / FAIL 行带 `repro:` | 清单原文 B1/B2/B5/B7 的最低断言偏流程（导出符号、git 历史），v1 取可机械判定的代理口径 | 已批（用户 m01090） |
| D-12 | `pythonPath` 优先级实际为 配置 > PATH；DSH 捆绑解释器不自动探测，需在 `pythonPath` 手填绝对路径 | 宿主未暴露稳定的捆绑解释器路径，自动回退可能选错解释器 | 已按实际行为关闭 |
| D-13 | `SPEC.md` 位于 `<outDir>/SPEC.md` 而非 graphRoot 内；ownership 会登记它，spec-graph 的 check 看不到它 | Windows 大小写不敏感，graphRoot 内的 `SPEC.md` 会被当成根节点 `spec.md`，触发 SECTION_MISSING / IMPL_LANGUAGE 等 9 条误报 | 已按实际行为关闭 |
| D-14 | `types` / `errors` / `http` / `openQuestions` 与 `data[].owner` 为 v1 增量字段，schemaVersion 不变；旧 plan 不引用这些字段时仍可 materialize | 盲测显示只读 SPEC.md 无法开工：类型只有名字、错误码无目录、HTTP 面缺路径/响应体；增量字段保持向后兼容 | 已批（用户 m02531） |
| D-15 | G7 新增的三类校验（`data[].rowWriters`、AC 路由闭合、`errors[].shape`）只判「结构自洽」，不判「语义正确」，版本不升 | 工具能查「表有没有运行时写入方、AC 里的路由有没有声明、错误码有没有响应体形状」，查不出「写入方是否真被调用、路由语义是否实现、形状是否贴合业务」；后者仍需人工审阅 SPEC | 已批（用户 G7 指令） |
| D-16 | G8 的必填列覆盖校验是启发式：列名 snake_case→camelCase 后，只在该表 `rowWriters` 模块的 `exposes[].signature` 里找同名字段（对象类型的 `fields` 或参数名本身） | 只能证明「签名里有这个字段的入口」，不能证明实现真的把它写进 INSERT；嵌套 input 类型不展开、`Omit`/`Partial` 包装按严格处理，因此可能**低估**缺口；但含 `default` 的列直接豁免，不会误伤 `created_at` 这类由数据库填值的列；反向也可能**误报**——由代码显式填值却没有 `default` 的列（如 `synced_at`），校验器看不到代码，需在入参类型或 `default` 里声明 | 已批（用户 G8 指令） |

| D-17 | `impl_gate_compose` 的 `plan` 模式不再覆盖已有 `compose-plan.json`：未传 `overwrite:true` 返回 `E_PLAN_EXISTS`；新增 `mode:"draft"` 只刷新 `SPEC-DRAFT.md`；`overwrite:true` 先写 `compose-plan.backup-<时间戳>.json` | 0.3.0 前 `plan` 会直写空模板，配合 playbook「plan 已存在也能调 plan」的旧写法，实际等于删掉用户已填的设计（改进清单 1.1，`tools.ts:619/635`） | 已按实际行为关闭 |
| D-18 | 有 `owner` 的表要求 owner 模块的 `files` 里出现 `migrations/*.sql`，否则 `PLAN_INVALID` | 0.3.0 前迁移归属只写在 playbook，`grep -r migration src/host/compose/*.ts` 为 0 处；盲测显示建表 DDL 无人认领、六个模块各写一份 | 已按实际行为关闭 |

| D-19 | `impl_gate_check` 把每次运行记录写到 `<graphRoot>/.impl-gate/runs/<runId>.json`，磁盘记录保留 24 小时；内存缓存仍是 10 分钟 | 改进清单 2.9：runId 只活 10 分钟、插件热重载即 `E_NO_PRIOR_RUN`；但「验收」本身应在一次实现回合内完成，24 小时只是让 reload 后能复核，不是长期归档 | 已批（0.3.0 自定） |

| D-20 | materialize 重跑不重置 `PASS`/`FAIL` 行，旧 `checklist.md` 先备份为 `.impl-gate/checklist.md.bak-<时间戳>` | 改进清单 1.1：重跑会把已填证据清空、A1 从 PASS 回退 NOT-RUN。选择「保留 + 备份」而不是「重置 + 计数」，因为验收证据是人工/外部进程写入的，工具无权丢弃；代价是改 plan 后保留行可能过期，靠 `stale design` 与人工复核兜底 | 已批（0.3.1 自定） |
| D-21 | `ownership.json` 记 `plan_sha256`/`generated_at`/真实版本号；`impl_gate_check` 检测不一致时只打 `stale design` 警告，不 FAIL | 改进清单 1.2：版本写死 `@0.2`、无 plan 哈希。只警告是因为「设计改了但还没重跑」属于流程中间态，直接判 FAIL 会让第一次 check 无法用 | 已批（0.3.1 自定） |
| D-23 | `review.json` 按 `round` 追加、同轮拒绝覆盖，不与 `plan_sha256` 绑定；评审只写证据，不改 plan/SPEC/图谱 | 评审是过程证据，「哪一轮评的是哪版 plan」靠 `round` 与 `stale design` 提示，绑定哈希会让读旧轮次变得麻烦 | 已批（0.3.1 自定） |
| D-22 | A3 重放时剥掉 `exit:N` 标记（此前会被当作命令参数，导致 `replayed exit 2`） | 改进清单未列，实测发现：`command:python -m specgraph check … exit:0` 重放 argv 多一个 `exit:0`，python 报 `unrecognized arguments` 判 FAIL | 已按实际行为关闭 |

## 维护规则

1. 新增偏离：在本表加一行，同时在任务书 §10 加同一行；两处必须同步。
2. 只记录**已生效**的决定；尚未落地的想法写在任务书正文，不进本表。
3. 每条偏离都要写清「与什么不一致」和「为什么」，裁决列写「已批」或「待处置」。

| D-24 | 签名里声明的泛型参数（`runInTransaction<T>(…)` 的 `T`）不视为未声明类型；只认单字母/单字母加数字形式 | 作者被迫用 `<t>` 这类非惯用写法来绕过类型扫描；`Array<Exercise>` 里的 `Exercise` 仍应被校验，所以不能把尖括号里的内容整体豁免 | 已批（0.3.1 自定） |

## D-25 impl_gate_record 只跑 plan 的验收命令

- gate 的 32 条断言里 command 是符号名（impl-gate:*），不可执行；impl_gate_record 因此改为执行 modules[].acceptance[].test。
- 首词白名单之外的命令一律 SKIPPED/RUNNER_NOT_ALLOWED，不提供 --allow-any 开关。
- 产物 .impl-gate/ac-evidence.json 与 	asks/EVIDENCE.md 不登记进 ownership.json，materialize 不会把它们当冲突。
| D-26 | 删除 `slow` 开关；Q1 改为 `mode: notrun` + 原因码 `IMPLEMENTATION_ONLY` | 实测 `slow=true` 对结果无影响：Q1 的命令是符号名，永远过不了重放白名单；文档承诺的行为不存在，比没有参数更糟。Q1 语义是目标项目的依赖审计，属实现方 CI，不归本工具跑 | 已批（0.4.40 自定） |