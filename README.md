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

## 配置

| 键        | 默认值 | 说明       |
| --------- | ------ | ---------- |
| `enabled` | `true` | 启用插件。 |

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
