# 实测：药箱提醒（盲测：六轮收敛 + 五轮增量 + 全量实现）

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
| 评审 | 前六轮把文档收敛到 9/9，后续增量评审 round 10–14 再确认；最终 9 个模块全部 ready、blocking 0 |

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
## 追加：分页改动怎么把 blocking 从 0 拉回 3（第 7–9 轮）

第 6 轮判 9/9 可开工之后，实际实现 M2 时暴露出一个真问题：`GET /api/medicines` 返回 `MedicineList`，
里面有 `total`，但没有任何分页参数——`total` 只能等于「查到的全部行数」。这条被 0.3.20 的
`LIST_PAGINATION_UNDECLARED` 抓到，于是回去补契约：给路由加 `page`/`pageSize`、给
`MedicineList.total` 写清「符合筛选条件的总条数」、给 M2 加一条 `catalog-pagination` 验收。

补完重评（第 7 轮）：**blocking 3**。根因是同一处——我只改了约束、`http[].query`、AC 三处，
`types[MedicineQuery].fields` 忘了加 `page`/`pageSize`，而 `listMedicines(tx, query: MedicineQuery)`
是唯一入口。评审还顺带指出：M4 用 `listMedicines` 取全量药品做计数，会被缺省 20 条截断。

修完（类型补字段、M4 改依赖 `listActiveMedicines`）重评第 8 轮：**blocking 1**。这次剩下的是
`§5.1 F5` 的第 3 步还写着 `listMedicines`——散文与约束相反。改完第 9 轮：9/9 ready、0 blocking。

这次事故的产出比「修好」本身值钱：

- 0.3.21 `PAGINATION_MODE_CONFLICT`：同一路由同时声明 page 与 cursor 两套分页。
- 0.3.22 `QUERY_PARAM_UNMAPPED`：查询参数在 handler 的参数类型里没有同名字段。把上面那份 plan 还原成
  「类型少两个字段」的状态重跑，工具会自己报
  `GET /api/medicines declares page, pageSize but MedicineQuery has no such field`——正好是第 7 轮人工抓到的
  那条 blocking。也就是说，这类「改了 3 处漏 1 处」从人力问题变成了机检问题。
- 仍未机检的部分：散文（`flows[].steps[].note`、约束里的兜底句）与契约相反——第 8 轮那条就是它。

## 实现切片（M1 + M2）

- M1（core）由独立实现者写 9 个文件，4 条 AC 全过；M2（catalog）3 个文件、5 条 AC 全过（含分页）。
- `impl_gate_record modules=["M1","M2"]` → `PASS 9 / FAIL 0`，`.impl-gate/ac-evidence.json` 里
  `AC-M1-1…AC-M2-5` 与 SPEC §6 编号逐条对应（0.3.19 的 `ref` 字段）。
- 两名实现者各自拍板了 14 与 16 处文档没写的细节（长度上限、patch 的 undefined 语义、非法 id 用 404、
  LIKE 转义、软删除不刷 `updated_at`……），这些正是「文档还不够厚」的清单，可回灌成约束或机检。

## 实现切片（M3 + M4 + M5）

三个模块并行交给三个互不通气的实现者，都只读自己的任务卡与 SPEC 对应章节：

| 模块 | 文件 / 行数 | 用例 | 自行拍板 |
|---|---|---|---|
| M3 inventory | 3 个 / 791 行 | 7 个（4 条 AC + 校验/上限/软删） | 10 条 |
| M4 reminders | 3 个 / 582 行 | 6 个（5 条 AC，home 拆两条） | 9 条 |
| M5 plans | 3 个 / 969 行 | 6 个（6 条 AC），全库 32 用例 | 16 条 |

`impl_gate_record modules=["M1"…"M5"]` → **PASS 24 / FAIL 0**。三个实现者报的「文档没写」高度同质，
四类反复出现：① 长度上限与缺省值；② `null` 与「字段缺失」的语义区别；③ 聚合计数在过滤前还是过滤后；
④ 时区/自然日的算法。这四类的共同点是**文档里只有名词、没有边界**，所以机器能查「有没有写」，
查不出「写得够不够具体」——这也是 0.3.20–0.3.22 三条分页警告能落地、而「长度上限」至今无法机检的原因。

一个具体的跨模块连锁：M4 最初用 `M2.listMedicines` 取全量，分页落地后会被 20 条截断；
改用 `M2.listActiveMedicines` 后，`§5.1 F5` 的散文还写着旧函数名，于是第 8 轮又被判 1 条 blocking。
契约里同一件事散落在 `types[].fields`、`constraints`、`http[].query`、`flows[].steps` 四处，
改一处就会留下三处不一致——目前只有前两处有机检。

## 实现切片（9 个模块全量）

| 模块 | 文件 | 行数 | 用例 |
|---|---|---|---|
| M1 core | 6 | 571 | 5 |
| M2 catalog | 3 | 866 | 7 |
| M3 inventory | 3 | 705 | 7 |
| M4 reminders | 3 | 598 | 7 |
| M5 plans | 3 | 875 | 6 |
| M6 checkins | 3 | 650 | 4 |
| M7 reports | 4 | 731 | 6 |
| M8 web | 5 | 1186 | 11 |
| M9 pages | 5 | 298 | 2 |

合计 35 个源文件、6,480 行、48 条 AC。`impl_gate_record modules=["M1"…"M9"]` → **PASS 48 / FAIL 0**；
`impl_gate_check` → `PASS 10 / NOT-RUN 22` + `implementation evidence: PASS 48`。

### 一个实现跑到契约前面的例子

M8 的实现者按安全直觉加了「写方法校验浏览器来源」：带外站 `Origin` 的请求返回 403。但 §4.3 没有这个错误码、
§3.1 M8 也没写这条规则——代码比文档更严格，验收却看不见它。

这里 Machine 帮不上忙：plan 内部闭合（码有没有声明、类型有没有字段）能查，**代码里多出来的行为查不出**。
处理方式是「契约优先」的两步：把 `E_ORIGIN_FORBIDDEN`(403) 补进 §4.3、把规则补进 §3.1 M8、再补一条
`web-origin` AC（外站 403 / 不带 Origin 仍 201），重物化后 48 条 AC 一起重录。

这也解释了为什么第 6 轮之后还要再做一次增量评审：契约一改，之前那条 round 就被 `check` 标成
`this review was recorded against an older compose-plan.json`——**评审结论跟着 plan 哈希走**，不能沿用。

## 九个模块全部实现之后（0.4.0）

上面停在 M1 的「四段闭环」。后续把 M2–M8 也按任务卡交给独立实现者，M9 由我补：

| 模块 | 文件 | 行数 | 拍板决定数 |
| --- | --- | --- | --- |
| M1 core | 9 | 571 | 14 |
| M2 catalog | 3 | 866 | 16 |
| M3 inventory | 3 | 705 | 10 |
| M4 reminders | 3 | 598 | 9 |
| M5 plans | 3 | 875 | 16 |
| M6 checkins | 3 | 650 | 8 |
| M7 reports | 4 | 731 | 8 |
| M8 web | 5 | 1186 | 12 |
| M9 pages | 5 | 298 | 6 |

合计 35 个文件、6,480 行、49 条 AC：

```
impl_gate_check  → PASS 10 / FAIL 0 / NOT-RUN 22
implementation evidence: PASS 49 / FAIL 0 / SKIPPED 0
review: ready 9 / clarify 0 / blocked 0
```

### 增量评审（round 10–14）暴露的三件事

1. **改一处要改四处**：加分页时改了约束、`http[].query`、AC，漏了 `types[].fields`；评审判 blocking 3，`QUERY_PARAM_UNMAPPED`（0.3.22）随后把同一处错误变成机检。
2. **散文与契约相反，只有评审能抓**：F5 流程里仍写 `listMedicines`，而 §3.1 已改成 `listActiveMedicines`。
3. **允许集合为空时，负向断言会假绿**：`AC-M8-11` 只断言「外站 403 / 不带 Origin 201」，如果实现把 loopback 也拒了，测试仍然绿。补 `web-origin-allow`：真 listen 到端口 0，再带 `http://127.0.0.1:<实际端口>` 的 POST，必须 201。

### 两个测试自身的坑（与产品无关，但值得记）

- 用固定参照日 `2026-11-10` 造数据、而实现读真实当天，隔一夜就集体偏移一天。改成 `const TODAY = today()` 后用 `Date.UTC` 做偏移，测试才与运行时间无关。
- `npx vitest run x.test.js -t "reminder-home"` 会匹配到 `reminder-home-limit`，两个用例共享同一套计数断言就互相污染。选择器要写成只有一条用例能命中的名字。

## 四份真实 plan 的警告分布（0.4.1 回归）

`node _probe/regression.mjs` 会对仓库里四份真实 plan 跑 `validatePlan` + `collectWarnings`：

| plan | 模块 | AC | 结构问题 | 警告条目（类别数） |
| --- | --- | --- | --- | --- |
| mini | 1 | 3 | 0 | 6（5） |
| fitness | 8 | 41 | 0 | 36（7） |
| run-log | 7 | 21 | 0 | 14（6） |
| pillbox | 9 | 49 | 0 | 3（1） |

药箱只剩 `OPEN_QUESTIONS_PENDING`，是因为其余类别都在六轮评审里逐条改掉了；fitness 那份是早期产物，从没按警告回灌过。
这张表也说明一件事：**警告数量反映的是 plan 的成熟度，不是工具的好坏**——同一个工具在四份 plan 上给出 5 到 7 类信号，差的是作者的修缮程度。
