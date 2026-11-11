# materialize 的 warnings 怎么读

`impl_gate_compose mode:"materialize"` 会返回一组 `warnings`：**它们不拦截生成**，只说明「文档能生成，但这里还有洞」。
0.4.36 共 38 类，按「消掉它要做什么」分三组。

| 组 | 含义 | 处理方式 |
|---|---|---|
| A 契约没闭合 | 结构上缺东西，任何实现者都会在这里分叉 | 改 plan（几分钟） |
| B 决定没做 | 文档没给答案，实现者只能猜一个 | 改 plan 或开工会上问一句 |
| C 可能误报 | 启发式，有的计划里留着也合理 | 看情况，写清理由即可 |

## A 组：契约没闭合（改 plan）

| code | 触发 | 怎么消 |
|---|---|---|
| `COVERAGE_GAP` | 某个 goal 没有任何验收断言 `covers` 它 | 给 AC 加 `covers:"G<n>"` |
| `ERROR_OWNER_MISSING` | 错误码没有 `by` | 给 `errors[]` 补 `by:"M<n>"` |
| `AUTH_UNSPECIFIED` | 路由没写 `auth` | 补 `auth:"public" \| "session" \| "admin"` |
| `FILE_OWNERSHIP_OVERLAP` | 两个模块的文件路径相同或只差大小写 | 挪文件或改归属 |
| `CONSTRAINT_HAS_PATH` | 约束里写了具体文件路径（`app.js`、`src/x.ts`） | 路径只放 `modules[].files`，散文里删掉 |
| `TYPE_OWNER_MISSING` | 类型被 ≥2 个模块引用却没有 `owner` | 补 `owner:"M<n>"` |
| `TYPE_OWNER_NO_SOURCE` | 类型有 owner，但该模块没有任何源码后缀文件 | 在 `files` 里加 `.ts`/`.js` 等 |
| `TYPE_UNUSED` | `types[]` 里声明了一个类型，但签名、路由的 req/res、查询参数、其它类型的字段都没提到它 | 删掉它，或者把它接进某个签名；externals 不参与 |
| `CONSTRAINT_FIELD_UNKNOWN` | 散文写了 `Type.field`，但该类型字段表里没有 | 补字段或改措辞 |
| `QUERY_PARAM_UNMAPPED` | 路由声明了查询参数，handler 的参数类型没有同名字段 | 给类型补字段 |
| `AC_TEST_UNRUNNABLE` | 验收命令首词不在 `impl_gate_record` 白名单，或没写命令 | 换成 `npx vitest run …` 这类可执行命令 |
| `AC_TEST_NODE_FLAG_LATE` | `node --test file.mjs --test-name-pattern=…`：node 只在位置参数之前解析自己的 flag，写在文件后面的选择器会被忽略，整份文件一起跑 | 把 `--test-name-pattern` 挪到文件之前，或换 `-t` 放在 vitest 后面 |
| `TOOLING_UNOWNED` | 有验收命令，但没有模块拥有 `package.json` 之类的工具链文件 | 让宿主模块拥有它 |
| `IN_MEMORY_VS_TABLE` | 表有 `rowWriters`，但写入模块的散文说「内存表/进程内」 | 二者对齐 |
| `PAGINATION_MODE_CONFLICT` | 同一路由同时声明 `page` 与 `cursor` 两套分页 | 只留一套 |
| `LIST_PAGINATION_UNDECLARED` | 响应带 `total`/`hasMore`，路由却没有分页参数 | 补 `page`/`pageSize`，或去掉 `total` |
| `AC_STATUS_CONTRADICTION` | 断言写「返回 201」，同路由 `http[]` 声明 200 | 二选一 |
| `AC_FIELD_UNKNOWN` | 断言读 `body.x`，响应类型没有 `x` | 改断言或补字段 |
| `AC_SHELL_LATER` | 断言调用了别的模块的路由，而那个模块还没到波次 | 调波次或改成单元级断言 |
| `AC_HTTP_OUTSIDE_SHELL` | 模块自己没有路由，却在 AC 里断言 HTTP 调用 | 交给 shell 模块断言 |
| `PLAN_TEXT_MOJIBAKE` | plan 文本出现连续 `???` 或 U+FFFD | 用 UTF-8 重写那段文本（通常是用 ascii 写脚本落盘的） |
| `UNIT_MISSING` | 数值字段名像量（duration/weight/quantity…），既没 `unit` 也没在名字里带单位 | 给字段加 `unit`（如「分钟」「片」），或把单位写进字段名（`distanceM`） |
| `ENV_KEY_UNDECLARED` | `runtime.start` 等命令里写了 `NAME=…`，但 `globals.envKeys` 没列这个键 | 把它加进 `envKeys`，或从命令里删掉 |
| `UNIT_INCONSISTENT` | 同一个数值字段名在不同类型里单位不一致（含一边没写） | 统一单位；确属不同粒度就改名（`durationMin` / `durationSec`） |
| `HTTP_NO_HOST` | 声明了 `http[]` 路由，却没有模块提供 `listen`/`buildServer`/`createApp` 入口 | 让壳模块提供入口，或在 `runtime` 里写清宿主 |
| `HTTP_RES_MISMATCH` | 路由声明的 `res` 与处理函数返回类型不一致（`WorkItem` vs `WorkItem[]`） | 改 `res` 或改签名；注册器（`register*`）不参与比对 |
| `HTTP_REQ_MISMATCH` | POST/PUT/PATCH 的 `req` 与处理函数唯一参数类型不一致 | 改 `req` 或改参数类型；GET/DELETE 的 `req` 请改写成 `query` |
| `AC_TEST_SELECTOR_OVERLAP` | 同一测试文件的两条 AC，`-t` 选择器一个是另一个的前缀 | 改用例名（如 `origin-blocked` 而不是 `web-origin`），否则一条失败会连带另一条 |

## B 组：决定没做（改 plan 或开工会上问一句）

| code | 触发 | 怎么消 |
|---|---|---|
| `STATUS_DEFAULTED` | 写路由没写 `status`，渲染时按 200/204 兜底 | 显式写 `status` |
| `LIST_ORDER_UNDEFINED` | 响应是集合，但没有任何排序约定 | 在产出方约束里写排序，或加 `orderBy` 参数 |
| `PATCH_NULLABLE_AMBIGUOUS` | PATCH 请求类型的字段全可空，分不清「不改」与「置空」 | 用 `undefined` 表示不改，`null` 表示置空，并写进约束 |
| `QUERY_DEFAULT_UNSTATED` | 可选查询参数没有 `note`，也没有一句写缺省/上限 | 补 `note` 或约束 |
| `WRITE_NO_VALIDATION_ERROR` | 整份 plan 一个 400/422 都没有，却带写路由 | 补校验错误码，或说明为何不需要 |
| `OPEN_QUESTIONS_PENDING` | `openQuestions` 还有未决项 | 开工会上逐条定，或删掉已定的 |

## C 组：可能误报（写清理由即可留）

| code | 为什么可能是误报 |
|---|---|
| `ERROR_UNUSED` | 预留错误码、由客户端触发的码，本计划里确实没人抛 |
| `BOUNDARY_UNUSED` | 边界描述的是部署环境（「离线」「本机数据库」），不一定要在正文再出现 |
| `HTTP_ROUTE_UNCOVERED` | 静态资源、健康检查、或由 `flows`/`ui` 覆盖但断言写在别处 |
| `AC_AUTH_UNSTATED` | 鉴权由 shell 统一处理，单元级断言本来就不带 Origin |

## 每条警告的最小复现

下面的测试里各有一到两个构造好的坏例子（搜警告码即可定位），可以对照自己的 plan：

| 警告码 | 最小复现（测试文件） |
|---|---|
| `COVERAGE_GAP` | warnings.test.mjs |
| `ERROR_OWNER_MISSING` | warnings.test.mjs |
| `AUTH_UNSPECIFIED` | warnings.test.mjs |
| `ERROR_UNUSED` | warnings.test.mjs |
| `FILE_OWNERSHIP_OVERLAP` | warnings.test.mjs |
| `CONSTRAINT_HAS_PATH` | warnings.test.mjs |
| `AC_AUTH_UNSTATED` | warnings.test.mjs |
| `HTTP_ROUTE_UNCOVERED` | warnings.test.mjs |
| `TYPE_OWNER_MISSING` | type-owner.test.mjs |
| `TYPE_UNUSED` | warnings.test.mjs |
| `AC_HTTP_OUTSIDE_SHELL` | warnings.test.mjs |
| `AC_SHELL_LATER` | warnings.test.mjs |
| `STATUS_DEFAULTED` | warnings.test.mjs |
| `LIST_ORDER_UNDEFINED` | warnings.test.mjs |
| `LIST_PAGINATION_UNDECLARED` | warnings.test.mjs |
| `PAGINATION_MODE_CONFLICT` | warnings.test.mjs |
| `QUERY_PARAM_UNMAPPED` | warnings.test.mjs |
| `PATCH_NULLABLE_AMBIGUOUS` | warnings.test.mjs |
| `BOUNDARY_UNUSED` | warnings.test.mjs |
| `WRITE_NO_VALIDATION_ERROR` | warnings.test.mjs |
| `TYPE_OWNER_NO_SOURCE` | warnings.test.mjs |
| `CONSTRAINT_FIELD_UNKNOWN` | warnings.test.mjs |
| `IN_MEMORY_VS_TABLE` | warnings.test.mjs |
| `TOOLING_UNOWNED` | warnings.test.mjs |
| `AC_STATUS_CONTRADICTION` | warnings.test.mjs |
| `PLAN_TEXT_MOJIBAKE` | warnings.test.mjs |
| `OPEN_QUESTIONS_PENDING` | warnings.test.mjs |
| `AC_TEST_UNRUNNABLE` | warnings.test.mjs |
| `AC_TEST_NODE_FLAG_LATE` | node-flag-late.test.mjs |
| `AC_TEST_SELECTOR_OVERLAP` | warnings.test.mjs |
| `QUERY_DEFAULT_UNSTATED` | warnings.test.mjs |
| `AC_FIELD_UNKNOWN` | warnings.test.mjs |
| `UNIT_MISSING` | warnings.test.mjs |
| `ENV_KEY_UNDECLARED` | warnings.test.mjs |
| `UNIT_INCONSISTENT` | warnings.test.mjs |
| `HTTP_NO_HOST` | warnings.test.mjs |
| `HTTP_RES_MISMATCH` | warnings.test.mjs |
| `HTTP_REQ_MISMATCH` | warnings.test.mjs |

## 一份 plan 的典型收敛顺序

## 一份 plan 的典型收敛顺序

1. 先消 A 组——大多数是补一个字段，一分钟一条；
2. B 组要么改 plan，要么记进开工会议题（`OPEN_QUESTIONS_PENDING` 至少要在会上过一遍）；
3. C 组如果留着，在 `openQuestions` 或约束里写一句「为什么可以留」，评审就不会反复问。
