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
| D-08 | `repository` 字段暂指向不存在的 GitHub 仓库 | GitHub 443 不通，未建远程 | 待 Step 8 处置（删或改占位） |

## 维护规则

1. 新增偏离：在本表加一行，同时在任务书 §10 加同一行；两处必须同步。
2. 只记录**已生效**的决定；尚未落地的想法写在任务书正文，不进本表。
3. 每条偏离都要写清「与什么不一致」和「为什么」，裁决列写「已批」或「待处置」。