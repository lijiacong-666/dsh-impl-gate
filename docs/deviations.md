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
| D-08 | v1 不写 repository/homepage/bugs，README 也不提供 GitHub 安装与 Release 链接 | GitHub 443 不通，未建远程；不写假地址 | 已结案（v1 不写假地址） |
| D-09 | `allowCommandReplay` 默认 `false`；M1–M6/M8/M9、Q2/Q3/Q5–Q9 默认 NOT-RUN `EXEC_DISABLED`；开启后 ≤5 条、120s、首词限 `python/pnpm/node`、cwd 限 `implRoot` | 重放证据命令有执行风险，默认关；重放是对这类断言唯一可机械判定的证据 | 已批（用户 m01090） |
| D-10 | B3/B4/B6 固定 NOT-RUN，reason 依次 `EVIDENCE_TOKEN_UNSPECIFIED` / `MANUAL_REVIEW_REQUIRED` / `HUMAN_PROCESS_REQUIRED` | 语义检索、裁决记录、流程纪律无法机械判定 | 已批（用户 m01090） |
| D-11 | B1/B2/B5/B7 判定口径改为：mapping.md 覆盖全部「需要」条目 / 勾选表 id ⊆ checks.json id / mapping 每模块≥1 行且模块真实 / FAIL 行带 `repro:` | 清单原文 B1/B2/B5/B7 的最低断言偏流程（导出符号、git 历史），v1 取可机械判定的代理口径 | 已批（用户 m01090） |
| D-12 | `pythonPath` 优先级实际为 配置 > PATH；DSH 捆绑解释器不自动探测，需在 `pythonPath` 手填绝对路径 | 宿主未暴露稳定的捆绑解释器路径，自动回退可能选错解释器 | 已按实际行为关闭 |

## 维护规则

1. 新增偏离：在本表加一行，同时在任务书 §10 加同一行；两处必须同步。
2. 只记录**已生效**的决定；尚未落地的想法写在任务书正文，不进本表。
3. 每条偏离都要写清「与什么不一致」和「为什么」，裁决列写「已批」或「待处置」。
