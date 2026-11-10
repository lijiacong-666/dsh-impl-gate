# 实测：90 行任务卡，一个从没看过对话的实现者

这页记录一次最小端到端：**需求 → plan → SPEC → 任务卡 → 另一个人写代码 → 证据回填 → gate 复验**。
目的不是证明插件多强，而是看「文档到底够不够」以及「哪里只能靠人」。

## 输入

`_e2e/mini/compose-plan.json`：单模块 M1（工作项核心）、1 张表、2 条路由、3 条 AC、1 个错误码。
materialize 后得到 `SPEC.md`（约 100 行）与 `tasks/wave-1/M1-core.md`（90 行，白名单 3 个文件）。

## 实现者

一个**没读过本仓库、没读过 plan** 的子智能体，只给任务卡 + SPEC 的 3/4/5/6 节。
它写了 `core/work.mjs`、`core/migrations/001_work_items.sql`、`test/work.test.mjs`，
`node --test test/work.test.mjs` → **5/5 通过**，没有越界文件。

## 证据链

```text
impl_gate_record  → PASS 3 / FAIL 0 / SKIPPED 0   （.impl-gate/ac-evidence.json）
impl_gate_check   → PASS 10 / FAIL 0 / NOT-RUN 22
                    implementation evidence: PASS 3 / FAIL 0 / SKIPPED 0 (3 AC)
```

FAIL 路径也验过：在临时副本里故意加一条失败断言，record 报 `PASS 0 / FAIL 3`，每条都带退出码与日志尾部。

## 它提出的 5 个「文档没写」问题

| # | 问题 | 现在谁来兜 |
|---|---|---|
| 1 | AC-M1-3 只说「按 createdAt 升序」，同毫秒 tie-break 只在 §5 约束里 | 人：AC 文本弱于约束，机检分不清 |
| 2 | 类型要求「由某文件定义并导出」，但 `.mjs` 没有类型工件 | `TYPE_OWNER_NO_SOURCE`（owner 的文件全是 .sql 时会报） |
| 3 | §2 声明 sqlite，卡片却要求内存表，两者没对齐 | `BOUNDARY_UNUSED`（依赖全篇再没出现时报警） |
| 4 | `handleCreate` 只返回 body，201 由谁写没规定 | 人：单模块项目里属实现细节 |
| 5 | 非字符串/缺 title 的入参没规定 | `WRITE_NO_VALIDATION_ERROR`（写路由没有 400/422 时报警） |

其中 3 条现在是机检警告，2 条只能靠评审或开工会上问。

## 这次实测抓到的插件 bug

- **B5 误判**：单模块、没有任何 `requires` 的项目，mapping 自然 0 行，旧规则却判 FAIL。已改为只判空单元与未知模块名。
- **Q10 误判**：删除 `spec.md` 在单节点图上不制造错误（空目录被跳过），退出码仍是 0。已改为把 `graph.toml` 写成非法 TOML，稳定拿到退出码 1。

## 结论

- 90 行卡片能让一个陌生实现者写出可跑的代码——结构层（签名、表、错误码、白名单）确实够用。
- 留白集中在「语义与所有权」：排序口径、依赖是否真用、校验错误归谁。机检能覆盖一部分，剩下的必须写进 `constraints` 或留到评审。
- 这页的产物在 `_e2e/mini/`（不进 npm 包）。