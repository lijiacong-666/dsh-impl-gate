# 发布队列：批哪一个

这一页是给「最后一步点 Approve 的人」看的，不是给开发者看的。开发者看 `docs/release-notes/`。

## 结论

**只批最新一版，其余 Reject。** 当前最新是 `0.4.44`——stage 列表里没有版本号，id 最大的那个就是它。

理由：npm 的 `latest` 只能指向一个版本；每个版本的 tarball 都包含此前全部改动，批十个等于把审核页拖长十倍、且中间版本永远不会有独立价值。

## 审批前核对三件事（30 秒）

```bash
npm view dsh-impl-gate version      # 仍是 0.3.11 → 说明还没批
node scripts/release-check.mjs      # 版本/tag/notes/tarball 全对才输出 preflight ok
```

`release-check` 会拦住我们已经踩过的四类事故：

| 事故 | 检查方式 |
| --- | --- |
| 版本 bump 了但没写 release notes | `docs/release-notes/v<version>.md` 必须存在 |
| 版本 bump 了但没重新构建 | `lib/index.js` 里必须出现当前版本号 |
| 同版本重复 stage | `npm stage publish` 会 `E409`，所以先 bump |
| tarball 带上了 `tests/` 或漏了 `docs/` | 解析 `npm pack --dry-run --json` 的文件表 |

## 顺序

1. 在 npmjs **Staged Packages** 里 Reject 掉旧于最新一版的那些（可选，只是清理）
2. Approve 最新一版（`0.4.44`），通过通行密钥验证
3. 核对：`npm view dsh-impl-gate version dist.shasum` 应为 `0.4.44` + 本地 `node scripts/release-check.mjs` 打印的 tarball 信息
4. 桌面 profile 升级：`dsh plugin --profile desktop add dsh-impl-gate@0.4.44`
5. 重载后确认工具列表里有七个 `impl_gate_*`，并跑一次 `impl_gate_check`

## 为什么队列会这么长

每次 `npm stage publish` 都留在服务端等审批，而 CLI 完成不了 passkey 验证（`npm stage approve` 需要 6 位 OTP，账号开的是 Security Key）。所以「发一版」实际是「stage 一版 + 人点一次」；开发过程中每轮都 stage，就攒成了二十多个。

从 0.4.44 起，`release-check` 只做本地核对，不再自动 stage——**攒够一批再 stage 一次**，队列不会继续膨胀。

## GitHub

`github.com:443` 目前不可达，本地 tag 已到 `v0.4.43`，`main` 停在 `f82782b` 之后未推。网络恢复后：

```bash
git push origin main
git push origin --tags
```

早于 `v0.3.5` 的 tag 推送不会自动触发 Release（工作流当时还没加上），必要时用 API 补建。