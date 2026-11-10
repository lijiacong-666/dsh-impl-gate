# 实测：药箱提醒（盲测，六轮评审）

一次「只给一句需求」的完整实验。作者只看 `playbooks/compose.md` 与 `src/host/compose/plan.ts`，
不知道本仓库的测试与实现；评审看 `playbooks/review.md` 与 `SPEC.md`，不看 plan。

## 输入

> 家庭药箱：记录药品、库存、有效期，按计划提醒吃药，打卡记录，按时段统计，导出 CSV。

作者看了手册后自己定的边界：单用户、本机、SQLite、原生 JS + Fastify、3 个页面（药箱 / 药品详情 / 提醒）。

## 产出

| 项 | 数值 |
|---|---|
| 模块 | 9（M1 core / M2 catalog / M3 inventory / M4 reminders / M5 plans / M6 checkins / M7 reports / M8 web / M9 pages） |
| 波次 | 6（1: M1,M9｜2: M2｜3: M3,M4,M5｜4: M6｜5: M7｜6: M8） |
| 路由 | 22（16 JSON + 6 页面与静态资源） |
| 验收断言 | 44 条，全部带可执行命令 |
| `SPEC.md` | 1114 行 / 72 KB |
| 任务卡 | 10 张（含 `TASKS.md`） |
| `mapping.md` | 77 行 |
| `checklist.md` | 47 行（32 条 gate + 需求覆盖） |
| 结构警告 | 0（唯一剩的是 3 条 `OPEN_QUESTIONS_PENDING`） |
| 评审 | 六轮，最终 9/9 可开工、blocking 0 |

## 六轮发生了什么

| 轮 | ready | clarify | blocked | blocking | 根因（一句话） |
|---|---|---|---|---|---|
| 1 | 2 | 6 | 1 (M8) | 2 | 详情页的 HTML 要含药名，但渲染函数只吃 id；页面 404 语义两处相反 |
| 2 | 2 | 5 | 2 (M3,M8) | 4 | 我上一轮的补丁自己引入矛盾（`E_MEDICINE_DELETED` 的 when 没改干净）；`HtmlResponse` 没有状态通道 |
| 3 | 6 | 2 | 1 (M8) | 2 | M8 调了 `getPlan` / `planOccursOn` / `nowIso`，requires 里没有 |
| 4 | 8 | 1 (M8) | 0 | 0 | 详情页拿不到「该药品的提醒」的取数通道（`MedicineDetail.reminders` 无来源） |
| 5 | — | — | 2 (M4,M8) | 2 | 我把 `medicineId` 只补进了约束与查询参数，**没补进 `§4.2 ReminderQuery` 的字段表** |
| 6 | 9 | 0 | 0 | 0 | 通过，可分发 |

值得记的两点：

- **第 4 轮 blocking 已经归零**，第 5 轮又冒出来——因为评审换了一双眼睛，也因为「散文里有、类型表里没有」这种
  半修复最容易被忽略。这正是 `CONSTRAINT_FIELD_UNKNOWN`（0.3.16）要机检的东西。
- 第 2 轮的耳朵是「我修出来的」：补丁改了一处、没改引用它的另一处。工具能查引用闭合，查不了「同一句话的两个副本」。

## 这一路加进插件的警告（都由它触发）

| 警告 | 这一路的样子 |
|---|---|
| `AC_STATUS_CONTRADICTION` | 药箱第 1 轮前：AC 说 201、`http[]` 说 200 |
| `OPEN_QUESTIONS_PENDING` | 3 条未决：撤销打卡、周统计是否按计划拆分、导出是否要筛选 |
| `CONSTRAINT_FIELD_UNKNOWN` | 第 5 轮：`ReminderQuery.medicineId` 只在散文里 |
| `TOOLING_UNOWNED` | 第 1 轮：没有模块拥有 `package.json` |
| `LIST_ORDER_UNDEFINED` / `HTTP_ROUTE_UNCOVERED` / `BOUNDARY_UNUSED` | 第 1 轮各 2 条，0.3.15 降噪后归零 |

## 实现切片：M1 core 真的写出来了

评审通过后，把 `tasks/wave-1/M1-core.md` 交给一个只读任务卡与 SPEC 的实现者（5 分 21 秒，未参与设计）：

- 写出 9 个白名单文件（`core/{db,types,errors,clock,migrate-cli}.js`、`core/migrations/001_init.sql`、
  `core/tests/core.test.js`、`package.json`、`vitest.config.js`），没有越界文件。
- 四条验收命令全部实测通过（`core-migrate` / `core-rollback` / `core-date` / `core-text`，各 1 passed / 4 skipped 是被 `-t` 过滤的同文件用例）。
- `impl_gate_record modules=["M1"]` → **PASS 4 / FAIL 0**，`impl_gate_check` → `PASS 10` +
  `implementation evidence: PASS 4` + `review: round 6 … blocked 0`——设计、评审、实现、证据四段第一次在药箱上串起来。
- 它自己拍板了 14 处文档没写的细节（`migrate` 返回值语义、`newId` 长度、`assertText` 返回值、库路径优先级、
  嵌套事务复用、哪些列建 FK 等），全部列进了报告；这类「实现者被迫做的小决定」正是下一步要往契约里收的东西。

## 复现

```bash
# 1. 写 plan（或让助手照 playbooks/compose.md 写）
# 2. 物化
impl_gate_compose outDir=D:\...\pillbox mode=materialize
# 3. 独立评审（另起一个只读 SPEC 的会话）
impl_gate_review outDir=D:\...\pillbox reviewer="judge (read SPEC only)" round=6 verdicts=[...]
# 4. 看警告与未决项
impl_gate_compose outDir=D:\...\pillbox mode=materialize   # 幂等，重跑会保留已填证据
# 5. 分发
impl_gate_init outDir=D:\...\pillbox
```

## 结论

- 「一句需求 → 可开工的详细设计文档」这条链在药箱这种家用领域成立了：9/9 模块可开工、0 blocking、
  每张卡都带文件白名单与可执行验收命令。
- 成立的前提是**有评审环**：六轮里有四轮的 blocking 是评审看出来的，不是工具算出来的。
- 工具的价值在于「不让同一类错过夜」：这一路四次把评审发现的模式固化成机检（0.3.12–0.3.16），
  代价是每轮都要压误报——四类警告的排查口径都写进了 `playbooks/compose.md` 的「warnings 怎么读」。