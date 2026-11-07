<!-- 写作规范见 playbooks/reference/readme.md；与 README.en.md 保持相同章节。 -->

# Impl Gate

简体中文 | [English](README.en.md)

<!-- npm:start -->[![npm](https://img.shields.io/npm/v/dsh-impl-gate?logo=npm)](https://www.npmjs.com/package/dsh-impl-gate) <!-- npm:end -->[![CI](https://github.com/mofei/dsh-impl-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/mofei/dsh-impl-gate/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/mofei/dsh-impl-gate?sort=semver)](https://github.com/mofei/dsh-impl-gate/releases/latest) [![License](https://img.shields.io/github/license/mofei/dsh-impl-gate)](LICENSE) [![Maintained with RED](https://img.shields.io/badge/maintained_with-RED-C1121F)](https://github.com/exoticknight/red)

<!-- Listing badges: add a row here only after each listing is confirmed. See playbooks/reference/badges.md. -->

TODO：一句话说明插件为用户做什么（与 package.json description 含义一致）。

## 功能

- TODO：**用户得到的好处**：具体怎么做到。3–6 条，只写已经实现的功能。

## 安装

模板不声明 DSH 安装版本门槛；插件使用的 API 是否可用，请以兼容性记录中的实际验证为准。使用 `headless` profile。

<!-- npm:start -->

### 从 npm 安装（推荐）

```sh
dsh plugin --profile headless add dsh-impl-gate
```

<!-- npm:end -->

### 从 GitHub 安装

固定到某个 Release tag：

```sh
dsh plugin --profile headless add github:mofei/dsh-impl-gate#v0.1.0
```

安装后重启 DSH（桌面版请重启应用），刷新页面。命令会装到你平时使用的 DSH；如果你设置了自己的 `DSH_HOME`，请在同一个环境中运行。

从源码安装用于开发调试，见 [docs/development.md](docs/development.md)。

## 使用

1. TODO：首次使用的步骤，写出界面上真实的中文名称，例如 **设置 → 插件 → Impl Gate**。

## 勾选表格式

交付的勾选表默认位于 `<implRoot>/.impl-gate/checklist.md`，必须是四列表格：

| id | status | evidence | reason |
|---|---|---|---|
| A1 | PASS | command: python -m specgraph export 支付服务 --root <graphRoot> --out <tmp>; exit: 0 |  |

- `status` 只能是 `PASS`、`FAIL`、`NOT-RUN`。
- `evidence` 必须以 `command:` 或 `file:` 开头；`command:` 要带 `exit: <code>`，`file:` 要带 `:line`。
- `reason` 仅在 `NOT-RUN` 时必填，且取自错误码表；其余状态留空。
- 共 32 行，id 不重不漏；未通过的条目还要列进 `## 未覆盖` 段。

完整说明在 Step 6 补齐。

## 人工核对项

清单原文里有四条偏流程/语义的断言，v1 不做机械判定，由人核对（见 `docs/deviations.md` D-11）：

1. 映射表行数 = manifest 条目总数（B1 原文）。
2. 实现里的导出符号 / 路由表 ⊆ 指令包暴露项集合（B2 原文）。
3. git 历史中每个模块提交后 1 次内出现对应测试运行记录（B5 原文）。
4. 任取一条 FAIL，其复现命令可原样执行，输出与报告一致（B7 原文）。

v1 的机械代理分别是：B1 检查 `mapping.md` 覆盖所有「需要」条目、B2 检查勾选表 id ⊆ checks.json id、B5 检查 mapping 每模块至少 1 行、B7 检查 FAIL 行带 `repro:`。代理项通过不等于原文四条已满足，交付时两者都要过。

## 缓存与重跑

`impl_gate_report` 与 `impl_gate_verify_contract` 复用 `impl_gate_check` 留在进程内的结果（按 runId + 规范化根目录，TTL 10 分钟）。插件热重载会清空缓存，此时返回 `E_NO_PRIOR_RUN` 属于正常现象——重跑一次 `impl_gate_check` 即可。

## 配置

| 键        | 默认值 | 说明       |
| --------- | ------ | ---------- |
| `enabled` | `true` | 启用插件。 |
| `allowCommandReplay` | `false` | 是否按证据命令重放 M/Q 断言（≤5 条、120s、首词限 `python/pnpm/node`、cwd 限 `implRoot`）。 |

TODO：说明配置保存在哪里；如有 API Key，说明它保存在 DSH 凭据域并脱敏显示。

## 更新、回滚与卸载

版本变更与升级说明见 [更新日志](https://github.com/mofei/dsh-impl-gate/releases)。

更新或回滚时请写明版本号，然后重启 DSH（新版本发布后 24 小时内，不带版本号的安装命令可能仍会装到旧版本）：

<!-- npm:start -->

```sh
dsh plugin --profile headless add dsh-impl-gate@X.Y.Z
```

<!-- npm:end -->

```sh
dsh plugin --profile headless add github:mofei/dsh-impl-gate#vX.Y.Z
```

卸载：

```sh
dsh plugin --profile headless remove dsh-impl-gate
```

TODO：卸载后会留下什么（设置、浏览器存储、文件）；没有就写“不留下任何数据”。

## 隐私与数据

TODO：插件访问哪些网络地址、写入哪些文件、保存哪些凭据；没有就明确写“无”。

## 兼容性

见 [docs/compatibility.md](docs/compatibility.md)。

## 偏离登记

与执行清单或任务书不一致的实现决定统一登记在 [docs/deviations.md](docs/deviations.md)。

## 开发

见 [docs/development.md](docs/development.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)。使用 AI agent 开发、发布或维护时，让它先读 [AGENTS.md](AGENTS.md)。

## 许可证

[Apache License 2.0](LICENSE)
