# 案例：一句话需求 → 7 个模块的实现（run-log）

> 这是一次完整 dogfood：需求由用户提出，契约、任务卡、代码、验收全部由本插件与独立实现者产生，没有任何人工编辑契约文件。
> 产物目录：`D:\ruanjian\deepharness\run-log`（不在本仓库内）。

## 1 输入

一句需求：

> 个人跑步打卡：记录每次跑步（日期、距离、时长、备注），支持修改与删除；按周统计总距离、时长、配速，连续打卡天数，个人最佳（最长单次、最快配速、单周最大累计）；按月看日历热力图；设置每周目标并显示完成百分比；把记录导出为 CSV；三个页面（记录、统计、目标）。

技术栈由计划固定为 Node 22 + Fastify 5 + better-sqlite3 + 原生 JS 页面。

## 2 契约规模

| 项 | 数量 |
| --- | --- |
| 模块 | 7（storage / run-log / stats / goals / export-csv / http-shell / web-ui） |
| 波次 | 4（1: M1｜2: M2,M3,M4,M7｜3: M5｜4: M6） |
| 类型 | 26 |
| 错误码 | 7 |
| 路由 | 24 |
| 页面 | 3 |
| 验收断言 | 21（每条都带可执行命令） |
| SPEC.md | 约 47 KB |

## 3 谁写了什么

- 契约：`impl_gate_compose mode:"plan"` 出模板，模型填 `compose-plan.json`，`materialize` 生成 SPEC、checklist、mapping、导出包，并刷新任务卡。
- 实现：6 个模块由独立子智能体只读「任务卡 + SPEC 对应章节」完成（M1/M2/M3/M4/M5/M7），HTTP 外壳（M6）由协调者写。
- 每个实现者都被要求：只改白名单文件、用例名精确匹配、用 `npx vitest run … -t …` 自证。

## 4 证据

```
impl_gate_record → PASS 21 / FAIL 0 / SKIPPED 0 (total 21)
impl_gate_check  → PASS 10 / FAIL 0 / NOT-RUN 22
                   implementation evidence: PASS 21 / FAIL 0 (21 AC)
```

`impl_gate_check` 的 NOT-RUN 22 条是执行类断言（17 条重放壳、3 条占位、3 条不适用），与实现无关，见 README 的「已知缺口」。

## 5 实现者暴露的留白（评审没抓到）

这些是「文档没写、只能自己拍板」的问题，五轮评审都没提，只有照着写才会撞上：

| # | 现象 | 后来怎么处理 |
| --- | --- | --- |
| 1 | 非法 `week` 该用哪个错误码（码表里 `E_MONTH_INVALID` 归 M3） | 写进 M3/M4 约束：复用该码、M4 只抛不改 |
| 2 | `fastest_pace` 全是 <1000m 记录时返回什么 | 仍靠实现者约定（`value=0, achievedOn=null`），未入契约 |
| 3 | `most_weekly_distance.achievedOn` 取周周一还是最后一条 | 从示例反推，未入契约 |
| 4 | `GoalInput.weekStart` 类型必填、约束却说缺省本周一 | 类型改成 `string \| undefined` |
| 5 | `achieved` 用 `>=` 还是 `>` | 仍靠实现者判断，未入契约 |
| 6 | `X-Row-Count` 不在 §4.4 响应头清单 | 用 `http[].resHeaders` 登记进契约 |
| 7 | M5 直接写头发字符串，M6 约束却写「onSend 识别 CsvFile」 | 改 M6 约束：路由自装配，M6 不二次包装 |
| 8 | `uiFiles()` 该放哪个文件，白名单没说 | 在 expose 的 note 里写明「由浏览器脚本导出」 |
| 9 | SPEC §9 声称有 `tsconfig.json`，实际没有 | 未处理（交付清单与实际不一致） |

第 1、4、6、7、8 条已回灌契约，重新 materialize 后**实现代码零改动**，`record` 仍是 21/21 PASS——这是「契约改对、实现不返工」的证据。

## 6 顺带修掉的工具缺陷

- `impl_gate_init` 重建 `tasks/` 时把 `impl_gate_record` 写的 `tasks/EVIDENCE.md` 当外来文件，导致 materialize 的卡片刷新静默失败，卡片停在旧的验收命令（`pnpm test … --grep`，vitest 没有 `--grep`）。0.3.10 修：把 `EVIDENCE.md` 视为自己的文件。
- `engines.node` 下限高于宿主运行时（22.19 vs 22.14），一直报 `Unsupported engine`。0.3.10 放宽到 `>=22.14.0`。

## 7 结论

- 「结构」已经可以机器判定：引用闭合、表归属、migration、not-null、路由覆盖、状态码、鉴权声明。
- 「语义」仍不可判定：口径、边界、异常路径只能靠实现者写一遍暴露，或评审者逐轮追问。
- 任务卡里的验收命令必须可执行，且与 plan 同步——这是本轮最贵的一课（旧卡片让实现者多花了一轮）。

## 8 复现

```bash
# 1 写 plan
#    按 playbooks/compose.md 填 <项目>/compose-plan.json
# 2 物化
#    impl_gate_compose mode:"materialize" outDir:"<项目>"
# 3 分发
#    impl_gate_init outDir:"<项目>"
# 4 实现（每个模块一个会话，只读自己的卡）
# 5 证据与复验
#    impl_gate_record outDir:"<项目>"
#    impl_gate_check graphRoot:"<项目>/<图名>" implRoot:"<项目>"
```

## 9 冒烟快照能提前抓到什么（0.4.23）

`pnpm smoke` 会把这四份真实 plan 的输出压成一份快照。run-log 这一份的六条警告里，有三条正是第一次盲审（五轮评分、8/8 判可开工）**完全没有提到**的：

- `STATUS_DEFAULTED`：更新接口没写成功状态码
- `LIST_ORDER_UNDEFINED`：列表接口没写排序
- `PATCH_NULLABLE_AMBIGUOUS`：PATCH 的字段全是可空，分不清「不改」和「改成空」

这三条现在既是机检项，也在快照里——如果有人把判定逻辑改窄（比如只认 POST 不认 PUT），单测可能照绿，快照会立刻漂移。反过来说，如果哪天快照里少了这三条，先怀疑检查器退化了，而不是文档变好了。
