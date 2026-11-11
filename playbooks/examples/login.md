# 案例：企业级登录（微信扫码 + 手机验证码）

本案例给出一个**能直接 materialize** 的三模块骨架，以及真实跑出来的产物。所有命令与工具名都是本插件实际提供的：图谱与导出由 `impl_gate_compose` 生成，任务卡由 `impl_gate_init` 生成，回收由 `impl_gate_check` 完成。

## 需求原文

> 企业级登录：支持微信扫码与手机验证码两种方式；登录成功后签发 7 天有效的 token；用户首次登录时自动建号；邮箱作为可选绑定；不接企业微信，不做权限模型。

## 最小 plan 骨架

把下面内容存成 `<outDir>/compose-plan.json`（`<outDir>` 任意绝对路径，例如 `D:/work/login-demo`），直接跑 `impl_gate_compose` 的 `materialize` 即可。

```json
{
  "schemaVersion": 1,
  "name": "login-demo",
  "title": "企业级登录",
  "summary": "微信扫码与手机验证码登录，首次登录自动建号，签发 7 天 token。",
  "stack": "node22+typescript+postgres16",
  "goals": [
    "手机验证码可登录",
    "微信扫码可登录",
    "首次登录自动建号"
  ],
  "nonGoals": [
    "不接企业微信",
    "不做权限模型",
    "不做找回密码"
  ],
  "boundaries": [
    {
      "dependency": "postgres",
      "purpose": "持久化用户与登录记录",
      "version": "16",
      "fallback": "启动失败并报错"
    },
    {
      "dependency": "wechat-oauth",
      "purpose": "扫码换 openid",
      "fallback": "微信通道降级为不可用，验证码通道不受影响"
    }
  ],
  "globals": {
    "conventions": [
      "错误码使用 E_ 前缀",
      "时间统一 UTC"
    ],
    "forbidden": [
      "不在日志里打印验证码与 token"
    ],
    "envKeys": [
      "DATABASE_URL",
      "WECHAT_APP_ID",
      "WECHAT_SECRET",
      "TOKEN_TTL_DAYS"
    ]
  },
  "data": [
    {
      "table": "users",
      "owner": "M2",
      "rowWriters": [
        "M2"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "constraints": [
            "主键"
          ]
        },
        {
          "name": "phone",
          "type": "text",
          "constraints": [
            "唯一"
          ]
        },
        {
          "name": "email",
          "type": "text",
          "constraints": [
            "可空",
            "唯一"
          ]
        },
        {
          "name": "openid",
          "type": "text",
          "constraints": [
            "可空",
            "唯一"
          ]
        }
      ],
      "indexes": [
        "users_phone_idx"
      ],
      "notes": "手机号与 openid 至少一个非空；由 M2 user-service 建表并 upsert，其他模块只读"
    }
  ],
  "types": [
    {
      "name": "Pool",
      "kind": "external",
      "source": "pg"
    },
    {
      "name": "User",
      "kind": "object",
      "fields": [
        {
          "name": "id",
          "type": "string"
        },
        {
          "name": "phone",
          "type": "string | null"
        },
        {
          "name": "email",
          "type": "string | null"
        },
        {
          "name": "openid",
          "type": "string | null"
        }
      ],
      "owner": "M2"
    },
    {
      "name": "TokenPair",
      "kind": "object",
      "fields": [
        {
          "name": "accessToken",
          "type": "string"
        },
        {
          "name": "expiresAt",
          "type": "string"
        },
        {
          "name": "expiresInSeconds",
          "type": "number",
          "unit": "秒"
        }
      ],
      "owner": "M3"
    }
  ],
  "errors": [
    {
      "code": "E_AUTH_INVALID",
      "status": 401,
      "when": "验证码错误或已过期",
      "shape": "{\"error\":{\"code\",\"message\"}}",
      "by": "M3"
    }
  ],
  "http": [
    {
      "method": "POST",
      "path": "/auth/login",
      "module": "M3",
      "handler": "login",
      "res": "TokenPair",
      "auth": "public",
      "status": 200
    },
    {
      "method": "GET",
      "path": "/auth/me",
      "module": "M3",
      "handler": "me",
      "res": "User",
      "auth": "session",
      "status": 200
    }
  ],
  "modules": [
    {
      "id": "M1",
      "dir": "shared",
      "title": "共享层",
      "responsibility": "提供数据库连接与公共错误类型",
      "exposes": [
        {
          "kind": "fn",
          "signature": "openDb(url: string): Promise<Pool>",
          "note": "数据库连接池"
        }
      ],
      "requires": [],
      "constraints": [
        "连接池全局唯一"
      ],
      "files": [
        "shared/db.ts",
        "package.json",
        "tsconfig.json"
      ],
      "acceptance": [
        {
          "id": "shared-db",
          "assertion": "openDb 能连上 postgres",
          "test": "pnpm test shared",
          "covers": "G1"
        }
      ]
    },
    {
      "id": "M2",
      "dir": "user-service",
      "title": "用户服务",
      "responsibility": "按手机号或 openid 建号与查号",
      "exposes": [
        {
          "kind": "fn",
          "signature": "createUser(phone: string): Promise<User>",
          "note": "首次登录建号"
        }
      ],
      "requires": [
        {
          "module": "M1",
          "item": "openDb(url: string): Promise<Pool>",
          "why": "写 users 表"
        }
      ],
      "constraints": [
        "手机号唯一",
        "邮箱冲突返回 409"
      ],
      "files": [
        "user-service/create.ts",
        "user-service/migrations/001_users.sql"
      ],
      "acceptance": [
        {
          "id": "user-create",
          "assertion": "重复手机号返回已有用户，不新建",
          "test": "pnpm test user-service",
          "covers": "G2"
        }
      ]
    },
    {
      "id": "M3",
      "dir": "auth-api",
      "title": "鉴权 API",
      "responsibility": "暴露验证码登录与微信登录两条入口",
      "exposes": [
        {
          "kind": "http",
          "signature": "login(phone: string, code: string): Promise<TokenPair>",
          "note": "POST /login"
        },
        {
          "kind": "http",
          "signature": "me(): Promise<User>"
        },
        {
          "kind": "fn",
          "signature": "startServer(port: number): Promise<void>"
        }
      ],
      "requires": [
        {
          "module": "M2",
          "item": "createUser(phone: string): Promise<User>",
          "why": "首次登录时建号"
        }
      ],
      "constraints": [
        "不返回密码",
        "token 有效期 7 天",
        "微信扫码通道通过 wechat-oauth 换取 openid；该通道失败时降级为不可用，验证码通道必须不受影响"
      ],
      "files": [
        "auth-api/login.ts",
        "auth-api/server.ts",
        "auth-api/me.ts"
      ],
      "acceptance": [
        {
          "id": "auth-login",
          "assertion": "正确验证码返回 token，错误验证码返回 401",
          "test": "pnpm test auth-api",
          "covers": "G1"
        },
        {
          "id": "auth-me",
          "assertion": "未登录访问 GET /auth/me 返回 401；登录后返回当前用户的 id 与手机号",
          "test": "pnpm test auth-api",
          "covers": "G3"
        }
      ]
    }
  ],
  "deliverables": {
    "tree": "login-demo/\n  shared/\n  user-service/\n  auth-api/",
    "files": [
      {
        "path": "package.json",
        "purpose": "工作区清单（脚本与依赖）"
      },
      {
        "path": "shared/db.ts",
        "purpose": "数据库连接池"
      },
      {
        "path": "user-service/create.ts",
        "purpose": "建号与查号"
      },
      {
        "path": "auth-api/login.ts",
        "purpose": "登录入口与 token 签发"
      }
    ]
  },
  "flows": [
    {
      "id": "F1",
      "name": "手机验证码登录",
      "trigger": "POST /auth/login",
      "steps": [
        {
          "module": "M3",
          "action": "login",
          "note": "校验验证码并查询用户"
        },
        {
          "module": "M2",
          "action": "createUser",
          "note": "首次登录时建号"
        },
        {
          "module": "M1",
          "action": "openDb",
          "note": "复用连接池"
        }
      ],
      "success": "返回 7 天有效的 TokenPair，并写入登录记录",
      "failure": [
        "E_AUTH_INVALID"
      ]
    }
  ],
  "ui": [
    {
      "id": "P1",
      "title": "登录页",
      "route": "/login",
      "module": "M3",
      "shows": [
        "手机号输入框",
        "验证码输入框",
        "获取验证码按钮",
        "登录按钮",
        "微信扫码入口"
      ],
      "calls": [
        "POST /auth/login"
      ],
      "states": {
        "error": "表单上方显示错误文案"
      }
    }
  ],
  "runtime": {
    "port": 8080,
    "start": "pnpm start",
    "health": "/healthz",
    "migrate": "pnpm migrate"
  }
}
```

## 真实产物

把上面这份 plan 交给 `impl_gate_compose mode:"materialize"`（0.4.31 实跑）：

```text
login-demo/
├── compose-plan.json
├── SPEC.md                    # 200 行 / 6.2 KB，九节齐全
├── .impl-gate/
│   ├── checklist.md           # 32 行，A1 的证据已经指到 SPEC.md 的具体行
│   ├── mapping.md             # 每条「需要」一行
│   └── ownership.json         # 记录生成了哪些文件、plan 的 sha256
├── export/
│   ├── export.md
│   └── manifest.json
└── login-demo/                # 契约图谱
    ├── graph.toml
    ├── shared/spec.md
    ├── user-service/spec.md
    └── auth-api/spec.md
```

- **9 个文件、0 条警告**（把上面整块 plan 原样贴进去即可复现；少了 `covers`、`by`、`package.json` 归属或 HTTP 宿主，就会各自触发一条警告）
- 三波：M1 独立 → M2 依赖 M1 → M3 依赖 M2；`impl_gate_init` 出 3 张卡
- `SPEC.md` 的 §4.4 会显示两条路由（`POST /auth/login` 201 前的 200、`GET /auth/me` 200），§5.1 显示 F1 的三步时序，§8.1 显示端口/启动/健康检查/迁移，§10 显示 P1 登录页

## 三处最常见的改法

### 1. 加一个模块（例如 token 服务）

在 `modules` 里追加：

```json
{
  "id": "M4",
  "dir": "token-service",
  "title": "Token 服务",
  "responsibility": "签发与校验 token",
  "exposes": [{ "kind": "fn", "signature": "signToken(userId: string): Promise<string>", "note": "7 天有效" }],
  "requires": [{ "module": "M1", "item": "openDb(url: string): Promise<Pool>", "why": "记录签发日志" }],
  "constraints": ["不把 token 写日志"],
  "files": ["token-service/sign.ts"],
  "acceptance": [{ "id": "token-sign", "assertion": "过期 token 校验失败", "test": "pnpm test token-service" }]
}
```

然后把 M3 的 `login` 改成 `requires` M4 的 `signToken(...)`，**签名逐字复制**。改完重跑 `materialize` 与 `init`，波次会自动重排。

### 2. 加一条验收断言

只改对应模块的 `acceptance`，`id` 全局唯一即可：

```json
{ "id": "auth-login-ratelimit", "assertion": "同一手机号 1 分钟 5 次后返回 429", "test": "pnpm test auth-api -- ratelimit" }
```

### 3. 拆波次

如果 M2 与 M3 都要写 `auth-api/session.ts`，`init` 会在 TASKS.md 报“必须串行或拆分文件”。两种改法：

- 拆文件：给 M3 单独的 `auth-api/session.ts`，M2 保留 `user-service/create.ts`；
- 拆依赖：让 M3 只依赖 M2 的 `createUser`，不共享文件；若仍有文件交集，把其中一个模块下移一波（改 `requires` 制造先后关系），不要靠人工约定并行。