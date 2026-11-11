# 常见问题

## 它替我写代码吗？

不写。它产出的是**详细设计文档**（`SPEC.md`）、契约图谱、多张任务卡和验收表；写代码的是人或别的 agent。工具不解析、不生成、也不修改你的源码。

## 为什么还要装 Python 和 specgraph？

契约图谱的校验（`check` 子命令）由本地 [specgraph](https://github.com/lijiacong-666/dsh-impl-gate) 完成，它是 Python 包。装法见 [install-specgraph.md](install-specgraph.md)；没装时 `impl_gate_compose` 会直接报 `PYTHON_ENV_MISSING`，不会写半个文件。

## `check` 里 22 条 NOT-RUN 是不是失败了？

不是。`M*` / `Q*` 是实现侧门禁断言（要读源码才能判），本工具设计上不读源码，所以永远 NOT-RUN；`B3/B4/B6` 需要人工判断。真正说明状态的是这一行：

```
readiness: ready to hand over
```

## `check`、`report`、`verify_contract` 有什么区别？

| 工具 | 回答的问题 |
|---|---|
| `check` | 契约检查 + 实现证据 + 评审轮次 + 能不能交付（日常用这个） |
| `report` | 同一次运行的结构化报告（含逐条 PASS/FAIL/NOT-RUN） |
| `verify_contract` | 只判 A1–A5（契约格式），不重跑检查 |

## 评审必须人来做了吗？

不必。把 `impl_gate_compose` 输出里的 `review.prompt` 原样粘给任何一个只看 `SPEC.md` 的 agent，让它回 JSON，再用 `impl_gate_review` 写回即可。关键是**只让它读 SPEC**——读了 plan 或代码，它就会替文档回答文档没写的东西。

## 我改了 plan，接下来做什么？

```
mode:"draft"      → 刷新 SPEC-DRAFT.md（不动 plan）
改 compose-plan.json
mode:"materialize" → 覆盖 SPEC.md / checklist / mapping / tasks
impl_gate_init     → 重出任务卡
impl_gate_record   → 重跑验收命令，刷新证据
impl_gate_review   → 重审一轮（否则 check 会报 stale）
```

漏掉最后一步，`check` 会明确告诉你「评审是针对旧 plan 的」并把 `readiness` 判成 not ready。

## `readiness` 为什么不是 ready？

看它列的原因，通常四种：没评审、没证据、评审与证据对不上（旧 plan/旧 SPEC/有 FAIL）、证据覆盖不全（比如 49 条 AC 只录了 47 条）。

## 36 类警告太多了，从哪开始？

先看 [WARNINGS.md](WARNINGS.md) 的分组：A 组（契约没闭合）必须改；B 组（决定没做）开会问一句；C 组（可能误报）在约束里写清理由就可以留。收敛顺序文档末尾有。

## 能用在已有项目上吗？

可以。`materialize` 只写它自己生成的文件（`SPEC.md`、`.impl-gate/*`、图谱目录、`tasks/`、`export/`），遇到不属于它的文件会拒绝覆盖，不会碰你的源码。

## 0.x 会不会经常不兼容？

会。`compose-plan.json` 的 schema 在 1.0 前还会变；锁版本用 `dsh-impl-gate@0.4.x`，升级前看 `docs/release-notes/`。

## 为什么不直接生成代码？

因为「结构可判、语义不可判」：签名、表、错误码、路由这些能机器校验；「库存按片还是盒」「重复提交算不算幂等」只有人（或读文档的 agent）能定。生成代码会把没定的事悄悄定死，后面更难改。