# compose 操作手册：从一句需求到可分发的任务卡

本手册面向第一次使用 `dsh-impl-gate` 的模型或工程师。只依赖本文件与工具描述，不需要读插件源码。

## 什么时候用

- 需求已经详细到**能拆出模块与契约**时用；典型是三段以上、有外部依赖、需要多人/多 AI 并行。
- 只有一句话也能用，但必须先在 plan 里补 `goals`、`data`、`boundaries`；补不出来就先访谈需求方，不要硬编。
- 只是改一个文件、修一个 bug、加一个字段：不要用 compose，直接改代码再跑 `impl_gate_check`。

## 五步流程

### 第 1 步：plan 模式拿空槽模板

```
impl_gate_compose({
  "outDir": "D:/work/account-service",
  "requirement": "企业级登录：微信扫码 + 手机验证码，登录后签发 7 天 token",
  "name": "account-service",
  "stack": "node22+typescript+postgres",
  "mode": "plan"
})
```

产物：`<outDir>/compose-plan.json`（内容唯一来源）与 `<outDir>/SPEC-DRAFT.md`（补槽草稿，带显式空槽注释）。
返回里的 `missingSlots` 形如 `["plan: goals, data", "M1: exposes, acceptance"]`；两级都要清零才算填完。

### 第 2 步：填 plan

只改 `compose-plan.json`，不要改草稿。字段写法见下一节。填完可用 plan 模式重跑一次 `overwrite: true` 刷新草稿，或直接进第 3 步（materialize 会先校验）。

### 第 3 步：materialize 出图谱、SPEC 与导出

```
impl_gate_compose({
  "outDir": "D:/work/account-service",
  "mode": "materialize"
})
```

产物：

```
<outDir>/
├── compose-plan.json
├── SPEC.md                 ← 与 graphRoot 同级，不放进图里
├── account-service/
│   ├── graph.toml
│   ├── shared/spec.md
│   ├── user-service/spec.md
│   └── auth-api/spec.md
└── export/
    ├── export.md
    └── manifest.json
```

返回 `graphRoot`、`specMd`、`packageMd`、`manifestPath`、`waves`、`overlaps`。
`graphIssues` 非空说明图不合法，按条改 plan，不要手改生成的 spec.md。

### 第 4 步：init 出任务卡

```
impl_gate_init({
  "outDir": "D:/work/account-service",
  "implRoot": "D:/work/account-service/account-service"
})
```

产物：`<outDir>/tasks/TASKS.md`、`cards.json`、`wave-1/M1-shared.md` … 波次直接来自 materialize 的同一套规划，不重新计算。

### 第 5 步：gate 回收

```
impl_gate_check({
  "graphRoot": "D:/work/account-service/account-service",
  "implRoot": "D:/work/account-service/account-service"
})
```

拿到 `runId` 后读汇总：

```
impl_gate_report({ "root": "D:/work/account-service/account-service", "runId": "<runId>" })
impl_gate_verify_contract({ "root": "D:/work/account-service/account-service", "runId": "<runId>" })
```

## 怎么写 compose-plan.json

### 顶层字段

| 字段 | 含义 | 好例子 | 坏例子 |
|---|---|---|---|
| `schemaVersion` | 固定 `1` | `1` | `"1.0"` |
| `name` | 项目名，小写连字符 | `account-service` | `AccountService` |
| `title` | 中文标题 | `团队账号服务` | `todo` |
| `summary` | 一段话说清做什么、不做什么 | `登录与账号生命周期，不含权限模型` | `登录` |
| `stack` | 技术栈，具体到版本 | `node22+typescript+postgres16` | `web` |
| `goals` | 可验收的目标，至少 1 条 | `用户可用手机验证码登录` | `做好登录` |
| `nonGoals` | 明确不做的事 | `不接企业微信` | `无` |
| `boundaries` | 外部依赖及失败策略 | `{dependency:"postgres",purpose:"存用户",fallback:"启动失败并报错"}` | `{dependency:"db"}` |
| `globals` | 全局约定/禁止/envKeys，可给统一 `errorShape` | `envKeys:["DATABASE_URL"]` | 省略 envKeys |
| `data` | 表、字段、建表模块与运行时写入方，至少 1 张 | 见 `playbooks/examples/login.md` | `[]` |
| `types` | 契约里用到的类型定义（可选） | `{name:"User",kind:"object",fields:[…]}` | 只写类型名不写字段 |
| `errors` | 错误码目录（可选，但被引用就必须声明） | `{code:"E_AUTH_INVALID",status:401,when:"密码错误",shape:"{\"error\":{\"code\",\"message\"}}"}` | 只写 `E_` 前缀 |
| `http` | 对外路由（可选） | `{method:"POST",path:"/login",module:"M1",handler:"login",res:"TokenPair"}` | 路径不写 `/` |
| `openQuestions` | 自己拿不准、需要人裁决的点 | `["token 是否要支持刷新"]` | 用注释代替 |
| `modules` | 模块数组，至少 1 个 | 见下 | 没有模块 |
| `deliverables` | 交付树与文件清单 | `{tree:"...",files:[{path,purpose}]}` | 只写 tree |

### 模块字段

| 字段 | 含义 | 好例子 | 坏例子 |
|---|---|---|---|
| `id` | `M1`…`M99` | `M2` | `user` |
| `dir` | 目录名，相对实现根 | `user-service` | `D:/work/user-service` |
| `responsibility` | 这个模块只负责什么 | `创建与读取用户` | `用户相关都做` |
| `exposes` | **对外契约，必须写签名** | `createUser(phone: string): Promise<User>` | `createUser` |
| `requires` | 依赖谁的哪条契约 | `{module:"M1",item:"Db"}` | `{module:"数据库"}` |
| `constraints` | 实现约束，至少 1 条 | `邮箱唯一，冲突返回 409` | `写得好一点` |
| `files` | 文件白名单，路径相对实现根 | `["user-service/create.ts"]` | `["src/*"]` |
| `acceptance` | 可执行验收 | `{id:"user-create",assertion:"重复邮箱返回 409",test:"pnpm test user-service"}` | `能创建用户` |

### 三条硬规则

1. **`exposes` 写签名，不写动词。** `login` 是坏例子，下游无法按它调用；`login(account: string, password: string): Promise<TokenPair>` 才是契约。
2. **`requires[].item` 必须与对方 `exposes[].signature` 逐字相等。** 差一个空格都会在 materialize 时报 `PLAN_INVALID`，并给出 JSON Pointer。
3. **`acceptance` 必须可执行。** 写清命令或脚本路径，例如 `{test:"pnpm test auth-api -- login"}`；不要写“已实现”。

## 类型、错误码与接口面

盲测的失败点几乎都在这三块：签名只写了类型名、错误码没有目录、HTTP 面没有路径与响应体。下面三段是可直接抄的最小写法。

### types：把类型名变成可实现的字段表

```json
"types": [
  { "name": "Member", "kind": "object",
    "fields": [
      { "name": "id", "type": "string" },
      { "name": "wechatOpenId", "type": "string | null" }
    ] },
  { "name": "LoginInput", "kind": "object",
    "fields": [
      { "name": "account", "type": "string" },
      { "name": "code", "type": "string" }
    ] },
  { "name": "TokenPair", "kind": "object",
    "fields": [
      { "name": "accessToken", "type": "string" },
      { "name": "expiresAt", "type": "string" }
    ] },
  { "name": "Role", "kind": "enum", "values": ["admin", "member"] },
  { "name": "Pool", "kind": "external", "source": "pg" }
]
```

规则：`object` 必须有 `fields`；`enum`/`union` 必须有 `values`；`external` 必须写 `source`。签名里出现的每个大写标识符都要在 `types` 里，或属于内置白名单（`Promise`、`Array`、`Record`、`Date`、`Error`、`Map`、`Set`、`Buffer` 等）。

### errors：先定错误体，再写状态码

```json
"globals": {
  "conventions": ["错误码使用 E_ 前缀"],
  "forbidden": [],
  "errorShape": "{\"error\":{\"code\",\"message\"}}"
},
"errors": [
  { "code": "E_AUTH_INVALID", "status": 401, "when": "账号不存在或验证码错误" },
  { "code": "E_TOKEN_EXPIRED", "status": 401, "when": "accessToken 过期" },
  { "code": "E_DB_CONNECT", "status": 500, "when": "启动时连不上数据库",
    "shape": "{\"error\":{\"code\",\"message\",\"detail\"}}" }
]
```

规则：`code` 形如 `E_[A-Z0-9_]+` 且全 plan 唯一；内部错误也写 `500`；`constraints` 与 `acceptance.assertion` 里出现的每个 `E_` 码都必须在这里声明。**每个错误码都要有响应体形状**：逐条写 `errors[].shape`，或只在 `globals.errorShape` 写一次默认值；两者都没有时 materialize 报 `/errors/<i>/shape must be a non-empty string`。4.3 的「响应体」列逐行打印，不会再出现「—」。

### http：路由必须落到某个模块的 http 签名

```json
"http": [
  { "method": "POST", "path": "/auth/login", "module": "M3", "handler": "login",
    "req": "LoginInput", "res": "TokenPair" },
  { "method": "GET", "path": "/users/:id", "module": "M2", "handler": "getUser",
    "res": "Member" }
]
```

规则：`module` 必须存在且该模块有 `kind:"http"` 的 expose；`handler` 必须等于该签名开头的标识符；`req`/`res` 必须是 `types` 里声明过的类型；同一 `method+path` 只能出现一次。**验收断言里写到的路由也必须先在这里声明**：`acceptance[].assertion` 里出现 `GET /bookmarks/:id`，`http[]` 就要有同 `method+path` 的条目，否则报 `acceptance references undeclared route "GET /bookmarks/:id" at /modules/<i>/acceptance/<j>（已声明：…）`。断言里的 query string（`GET /bookmarks?scope=team`）、句尾标点（`GET /bookmarks,`）和包裹引号（`GET “/bookmarks”`）不参与路由比对；但 `:param` 名称不同仍算不同路由，不会模糊匹配。

`kind:"http"` 的 expose 必须写成函数签名式，`handler` 才等于签名开头的标识符：

```json
"exposes": [
  { "kind": "http", "signature": "login(input: LoginInput): Promise<SessionToken>" }
]
```

上面这条签名的 `handler` 是 `login`；只写 `login`（动词）或 `POST /auth/login`（路由）都不是签名，materialize 会报 `handler "login" does not match the leading identifier of any kind:"http" signature`。请求体用 `input: LoginInput` 这种带类型名的参数，`types` 里就要有 `LoginInput` 的字段表，评审环节会逐字段问「谁提供、空值怎么办」。

路由与签名齐了之后，别直接分发：先按 [`review.md`](review.md) 的评审环逐模块判定「可开工 / 需澄清 / 不可开工」，通过线是 ≥80% 可开工且无不可开工；不合格的条目回灌成 plan 字段、重跑 materialize，最多 3 轮。

### 表归属与运行时写入方

每张表都要写 `owner`（建表模块 id）与 `rowWriters`（允许在运行时插入/更新该表的模块 id 列表，至少 1 个），且 owner 的文件白名单里应有 migration 文件：

```json
{ "table": "members", "owner": "M1", "rowWriters": ["M1", "M2"], "columns": [ … ] }
```

```json
"files": ["user-service/migrations/001_members.sql", "user-service/member.ts"]
```

`owner` 只回答“谁建表”，`rowWriters` 回答“谁写入”。`rowWriters` 为空、或引用了未声明的模块，materialize 都报 `PLAN_INVALID`。被外键引用的表尤其要想清楚：`bookmarks.owner_id references members(id)` 意味着 `members` 必须有人在运行时写行；当写入方与 owner 不同时，4.1 会在字段表后打印 `写入方：M1, M2`，引用方必须能调到这些写入方。

## 怎么判断 SPEC.md 够不够

逐条打勾，任何一条不过就回 plan 改，不要改 SPEC.md：

1. 每个模块的 `exposes` 都是签名级，不是动词。
2. 每个 `requires` 都能在对方 `exposes` 里找到，连线闭合，`graphIssues` 为空。
3. 每条需求（N）都有对应的验收断言（AC），没有留空项。
4. 每条 AC 都能用命令行或脚本跑，不依赖人工观察。
5. 波次无环，且同波次模块之间没有共享文件（有则 `overlaps` 会报）。
6. 文件白名单互不重叠，且都相对实现根。
7. 全局约定里有 `envKeys`，需要配置的变量都列了。
8. `boundaries` 写的是外部依赖，不是内部模块。
9. `nonGoals` 明确写了不做的事，避免范围蔓延。
10. `deliverables.tree` 与 `files` 能对上每个模块的白名单。
11. 签名里出现的每个类型都在 `types` 里；`kind:"external"` 的写了 `source`。
12. 每张表都有 `owner` 与至少一个 `rowWriters`，且 owner 的白名单里有 migration 文件、写入方的 `exposes` 里能插入/更新行。
13. 每个 `E_` 码都在 `errors` 里；同一状态码不对应两个语义相同的码。
14. 需要“整批原子”的操作，其签名能拿到事务句柄，或该模块自己拥有写入权。
15. `http` 面覆盖所有对外路由，每条 AC 里出现的路由都能在 `http[]` 找到同 `method+path`；`errors[].shape` 与 §8 的错误体一致。
16. 每个 `not null` 且无 `default` 的列，在 `rowWriters` 的入参类型里都有同名字段（`employee_no`→`employeeNo`）；由代码固定填值的列（如 `synced_at`）要么写进入参类型，要么在列上给 `default`——校验器不推断代码行为，别指望它认。
17. 下一节「自洽性」8 条全部打勾。

## 自洽性

结构齐全（字段都在）不等于能开工（plan 自己说得通）。materialize 只查得出前五条里的机械部分，其余必须人来判；每条后面都写了不查会怎样：

1. **身份模型写进契约。** 谁创建 `members`/`users` 行？请求头里的 id 凭什么保证存在？→ 把写入方写进该表 `data[].rowWriters`，并在对应模块 `exposes` 给出可调用的写入/校验签名（如 `ensureMember(openId: string): Promise<Member>`）。否则实现者只能相信一个从不存在的用户，外键与鉴权同时落空。
2. **`openQuestions[]` 里不许留“本期按 X 处理”。** 做了决定就必须落进 `types`/`data`/`http` 字段，落不进去就删掉这条问题。→ 附录里的临时决定不进入任何模块契约，各实现者会各自发明一套。
3. **每张表都要有运行时写入方，不只是建表方。** `owner` 回答“谁建表”，`rowWriters` 回答“谁插入/更新”；空数组直接 `PLAN_INVALID`。→ 只有 migration 没有写路径的表，查询永远为空。
4. **每条 AC 里的 HTTP 路由必须先在 `http[]` 声明。** 断言写 `GET /bookmarks/:id`，就必须有同 `method+path` 的条目。→ 否则实现者照 AC 写测试，第一次运行就是 404。
5. **每个错误码都要有响应体形状。** 逐条写 `errors[].shape`，或用 `globals.errorShape` 给统一默认值；4.3 的「响应体」列不允许出现「—」。→ 客户端无法解析错误，也说明错误码只是装饰。
6. **全文搜索用同一个 `tsvector` 配置。** 建触发器的模块与写查询的模块必须约定同一个配置（如 `simple`），并写进双方的 `constraints`。→ 配置不一致时 `@@` 查询用不上索引，结果静默变空。
7. **上传形态写进类型与限流归属。** JSON 内联 html 还是 multipart，要落到 `http[].req` 的类型，并写明哪个模块负责 `bodyLimit`。→ 形态不写清，实现者会同时写两套解析，限流也无人认领。
8. **标签语义写进签名或类型。** 追加还是替换、`updated_by` 有没有列，必须可判定（写进签名参数、类型字段或 `constraints`）。→ “打标签”在实现层至少有四种互不兼容的行为。

## 怎么分发

1. 打开 `tasks/TASKS.md`，按波次推进；**同波次可并行，每波全部 PASS 再进下一波**。
2. 同波次若出现 `M2 与 M3 都写 src/x.ts —— 必须串行或拆分文件`，先拆文件或改波次，不要硬并行。
3. 把每张卡单独交给一个实现者。实现者**只读第 2/3/4/6 节**：白名单、要提供什么、依赖什么、怎么验收。
4. 卡片第 2 节第一行写明了路径相对谁；实现产物只能落在该根下，往 graphRoot 或 `tasks/` 写代码视为失败。
5. 实现者按第 8 节五段回报；回报里没有“实际命令 + 输出”的证据，视为未完成。

## 怎么回收

`impl_gate_check` 的三态：

- **PASS**：断言有证据且成立。看 `evidence` 里的命令/文件行，不要只看颜色。
- **FAIL**：先判性质再改：
  - 证据指向契约矛盾（签名不匹配、连线不闭合、AC 写错）→ **改 plan，重跑 materialize 与 init**；不要改生成的 spec.md。
  - 证据指向实现缺失（文件没写、测试没过）→ **改实现**，然后只重跑 `impl_gate_check`。
- **NOT-RUN**：不是通过。读 `reason`：`CHECKLIST_NOT_PROVIDED` 补勾选表；`EXEC_DISABLED` 是本轮没开命令重放；`GUI_REQUIRES_MANUAL_CHECK` 必须人工看界面；`D4_GRAPH_INVALID` 先修图。

团队约定：FAIL 判定为“契约错”时，禁止在实现侧打补丁绕过；判定为“实现错”时，禁止改 AC 降标准。

## 常见坑

1. **`exposes` 写成动词**（`login`）：下游只能猜参数。→ 写成完整签名。
2. **`requires.item` 与签名差一个空格/大小写**：materialize 报 `PLAN_INVALID /modules/…/requires/0/item`。→ 从对方 `exposes[].signature` 原样复制。
3. **把 SPEC.md 放进 graphRoot**：specgraph 会把它当节点 `spec.md`，报 `SECTION_MISSING`/`IMPL_LANGUAGE`。→ SPEC.md 留在 `<outDir>/SPEC.md`，图里只放模块。
4. **手改生成的 spec.md 或卡片**：下次 materialize/init 会覆盖，且破坏确定性。→ 改 plan 后重跑。
5. **路径相对谁没写清**：实现者把文件建到进程 cwd 或 graphRoot。→ 看卡片第 2 节的“路径相对 …”行，只在该根下写。
6. **单模块波次也当并行**：读起来像可以拆给多人，实际只有一个模块。→ TASKS.md 会标“（独立）”；按标注分发。
7. **`data` 留空**：materialize 直接 `PLAN_INVALID`。→ 至少写一张表，哪怕只有 `id` 与业务键。
8. **`acceptance` 只写“功能正常”**：gate 无法复现，只能 FAIL。→ 写命令、断言与预期退出码。