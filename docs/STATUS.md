# 交付现状：已完成 / 未完成 / 已知风险

> 本文如实记录实际执行过的验证。未执行的项明确标注，不把"代码已生成"描述成"功能已验证"。

## 1. 已实现并已验证

### 1.1 工程与基础设施

- pnpm Monorepo（`apps/*` + `packages/*`），TypeScript strict，所有包 `tsc` 通过。
- PostgreSQL 16 + Redis 7 通过 `compose.yaml` 启动；`postgres` 起在 55432、`redis` 起在 56379。
- Prisma 两个迁移已应用（含 32 张表的 RLS 策略与 `localehub_app` 非 owner 角色）。
- `compose.yaml` 与 `compose.yaml + compose.production.yaml` 均通过 `docker compose config` 校验。
- API `/api/v1/health` 返回 `{"status":"ok","checks":{"database":true}}`（真实运行验证）。
- Web 15 条路由构建成功，`next start` 后 `/login` 等页面返回 200。
- Worker 编译通过，队列定义与 QA 任务实现完成（**未在长时间运行下验证队列重试**）。

### 1.2 领域与同步

- 三方比较全部 12 类分支、计划确定性哈希、汇总统计：19 个单元测试通过。
- 同步服务：scan 记录、预览、推送（幂等重放）、变更增量、基线、冲突、apply report、
  同步前校验、事件日志。
- 冲突解决：`KEEP_LOCAL` / `KEEP_REMOTE` / `MANUAL_MERGE` / `DEFER`，写平台新版本并推进 revision。
- 源文变更 → 依赖旧 Source Version 的译文标记 `STALE`，历史版本保留。

### 1.3 格式适配器

- JSON（自研 span scanner，原地 token 替换）、YAML（Document API 保留注释）、
  iOS `.strings`、`.stringsdict`、`.xcstrings`、Android `strings.xml`/`plurals.xml`、PO、XLIFF。
- 29 个 round-trip / 原地补丁测试通过，含复数分支、XML 实体、引号与换行转义。

### 1.4 本地仓库操作（CLI）

- 平台只暴露一个 Remote MCP；本地 14 个动作在 CLI 里（scan / sync preview|push / pull /
  apply preview|--confirm / conflicts / qa / status / patch / release validate / info / mcp-config），
  引擎在 `packages/local-sync`，不含任何 MCP 依赖。
- 路径安全：24 个测试通过（`..`、绝对路径、NUL、符号链接逃逸、allowRead/Write、deny 规则、
  配置校验、备份、原子写入、写后校验回滚、重复 Key 检测）。
- 端到端验收脚本 `apps/e2e-demo/dist/run-demo.js`：**A–E 全场景 ALL ACCEPTANCE CHECKS PASSED**
  （该脚本直接驱动 `LocalSyncServices`，与 CLI 同一条代码路径）。

### 1.5 集成测试（真实 API + PostgreSQL + 文件系统）

14 个集成测试全部通过，覆盖：push new、幂等推送、平台审核后拉取、备份与原子写回、
apply report 推进基线、草稿隔离、源文变更致 STALE、双边冲突、同值收敛、预览后本地变更阻断回写、
计划过期、Scope 强制、RLS 租户隔离、跨租户 Token 拒绝。

### 1.6 Web 后台（shadcn/ui）

Next.js 15 + shadcn/ui（Tailwind v4、new-york、Radix、lucide、sonner）：项目管理、项目概览、
翻译编辑器（并排原文/译文、版本历史、QA、草稿与审核）、审核队列、过期译文、QA 中心、
仓库同步页（连接/心跳/映射/历史/说明）、同步历史（可展开逐条 Sync Item）、冲突三栏对比、
Token 管理、MCP 工具清单与 Skill 列表、组织设置。
含明/暗/跟随系统主题、语义状态色令牌、响应式侧边栏 + 移动端抽屉导航。

验证方式（headless Chrome + CDP，登录后逐页检查）：

- `next build` 15 条路由全部生成；
- 11 个受保护页面均渲染出 `data-slot="card"/"button"/"table"` 组件，无应用错误；
- 暗色与浅色模式均生效（`.dark` 类随主题切换，首屏内联脚本避免闪烁）；
- 390px 窄视口下 11 个页面**全部无横向溢出**（首次检查发现 Token 页与 MCP 页各有一处，已修正：
  代码块所在栅格列补 `min-w-0`，资源 URI 加 `truncate`）。

### 1.7 其他

- CLI：`init / info / scan / sync preview|push / pull / apply preview|--confirm / conflicts /
qa / status / patch / mcp-config / release validate`。
- Seed：组织、5 角色用户、项目、3 语言、术语、样例 Key、QA 运行、MCP Token。
- 5 个内置 Skill（prompt 型），通过 MCP 下发给客户端（见 §1.12）。
- 文档：README、PRD、ARCHITECTURE、DATABASE、API、MCP、SYNC、SKILLS、DEPLOYMENT、本文件。

### 1.9 CI 恢复绿色

`main` 上的 GitHub Actions 从第一次推送起一直是红的，三个原因互相掩盖，且**都在本地不可见**：

| #   | 现象                                             | 根因                                                                                                                                                        | 为什么本地看不到                                   |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | `Acceptance demo` 报 `fetch failed`              | 演示假定 API 已在运行；集成测试在 `afterAll` 会先把它杀掉                                                                                                   | 本地一直开着 dev API                               |
| 2   | `Acceptance demo` 报 `Invalid email or password` | 集成测试先跑并创建了用户 → 注册关闭 → 演示无法自建账号                                                                                                      | 本地库里早就有 demo 用户                           |
| 3   | 集成测试 `expected 403 to be 201`                | CSRF 守卫读 `process.env.CORS_ORIGINS`，CORS 中间件读校验后的配置（含 schema 默认值）。没有 env **文件**的实例上守卫看到空串，把 Web 自己的 origin 判为非法 | 本地恰好存在 `localehub.env`，启动时被载入进程环境 |

第 3 条用「把 `localehub.env` 挪走 + 导出 CI 的环境变量」在本地复现，旧实现产出与 CI 完全相同的断言失败；
第 1、2 条用「新建空数据库，按 CI 顺序跑演示与集成测试」验证。

核对方式（无需 CI 日志权限）：`badge.svg` 与 `actions/workflows/ci.yml` 页面 HTML 均显示
`completed successfully: Run 5 of CI`。

### 1.10 Docker 栈：两个只在容器里出现的缺陷

此前对镜像的验证只做到「容器起得来 + 路由返回 200」，而页面是纯客户端渲染的，**HTTP 200 与页面
能不能用无关**。改为整套 `docker compose up` 后用无头浏览器按真实路径验证，暴露两个缺陷：

| #   | 现象                                                      | 根因                                                                                                                                                                                                                                     | 修法                                                                                          |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | 页面能开、登录返回 201，但登录后每个 `/api/v1` 请求都 500 | `next.config.ts` 的 `rewrites()` 在**构建期**执行，目标地址被写进 `routes-manifest.json`。`compose.yaml` 只在运行环境设 `API_BASE_URL_INTERNAL`，于是镜像里烘焙的是 `http://localhost:3001`——在容器内那指向 web 容器自己，`ECONNREFUSED` | 改成 `docker/web.Dockerfile` 的构建参数，compose 用 `build.args` 传入                         |
| 2   | 登录成功后的所有请求 403 `INSECURE_TRANSPORT`             | `compose.yaml` 给 api 设了 `NODE_ENV=production`（为了让镜像行为贴近生产），但开发栈没有 TLS 终结，守卫据此拒绝一切认证流量。页面照常打开、登录也成功，所以只看「路由 200」永远发现不了                                                  | 开发栈显式 `ALLOW_INSECURE_HTTP: "true"`；生产 overlay 显式设回 `"false"`，避免被环境合并继承 |

生产 overlay 另修四处同源问题（**未实际执行**——`secrets/**` 在本工作区不可读写，无法起生产栈；
端口与副本的机制用一次性 compose 项目单独实测）：

- api / web 是 `replicas: 2` 却继承宿主端口映射：第二个副本必然 `Bind for 0.0.0.0:3001 failed:
port is already allocated`。nginx 是唯一入口，这些服务不该发布宿主端口。
- **`ports: []` 在 overlay 里是无效写法**，Compose 会忽略空列表并保留基础文件的端口。也就是说
  overlay 头部写着「PostgreSQL 和 Redis 不暴露到宿主机」，实际上 55432 / 56379 一直暴露着。
  正确写法是 `ports: !reset []`（v5.1.3 实测：`ports: []` 保留 `published: "3998"`，
  `!reset []` 清空）。已改 5 个服务，合并结果只剩 nginx 的 80 / 443。
- 缺 `TRUST_PROXY`：Express 默认把 socket 地址当客户端，nginx 后面所有调用者会共用一个限流桶、
  共用一条审计身份。设 `"1"`（前面恰好一跳）。
- `MCP_PUBLIC_URL` / `API_BASE_URL` / `CORS_ORIGINS` 未设，会继承开发默认值：页面会把
  `localhost` 地址发给客户端。

### 1.8 请求层安全基线（本轮新增）

| 项           | 实现                                                                                                              | 验证                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 浏览器会话   | HttpOnly + SameSite=Lax Cookie；CSRF Token 放在可读 Cookie 里做双提交；写请求另校验 Origin/Referer                | 集成测试 4 项 + 无头 Chrome 实测 `httpOnly=true`、`localStorage` 为空 |
| Bearer 凭据  | CLI / Remote MCP / 集成脚本继续用 `Authorization: Bearer`，不受 CSRF 约束                                         | 集成测试「keeps bearer credentials working」                          |
| 传输         | `NODE_ENV=production` 下纯 HTTP 携带凭据返回 `INSECURE_TRANSPORT`（public 路由除外）                              | 集成测试起第二个 production 模式实例验证                              |
| 限流         | 全部端点；已认证按 actor，登录/注册按（IP, 账号）+ 更宽松的 IP 桶；Redis 共享计数，Redis 挂了退化为单进程并打日志 | 16 个单元测试 + 集成测试实测 429                                      |
| 安全响应头   | helmet（CSP / HSTS / X-Frame-Options / nosniff / COOP 等）                                                        | 预检与业务响应实测                                                    |
| 草稿回写策略 | `organizations.allow_draft_apply` 默认 false，平台侧拒绝 `POLICY_VIOLATION`                                       | 集成测试 + 演示场景 D + 设置页开关                                    |
| 同源反代     | Next.js 增加 `/api/v1/*` rewrite，浏览器默认走同源，Cookie 保持 first-party                                       | 无头 Chrome 全流程 20/20                                              |
| 角色校验     | `@RequireRole` 在 guard 里**只在路由带 projectId 时生效**；不带 projectId 的路由必须在 handler 里补 `assertRole`  | 逐路由审计 + 新增集成测试（见 §1.11）                                 |

### 1.11 `DELETE /mcp-tokens/:id` 的角色校验从未生效

guard 的实现是「`@RequireRole` + 路由带 projectId 才校验」，注释写明不带 projectId 的路由要在
service 层自己补检查。Token 吊销这条路由两样都没有：既无 projectId 参数，handler 里也没有
`assertRole`。结果是 `@RequireRole(PROJECT_MANAGER)` 只是装饰——**任何成员（包括 DEVELOPER）
都能吊销组织里任何人的 Token**，已用真实会话复现（HTTP 200 + `revokedAt` 被写入）。

修法：handler 里补 `assertRole(actor, '', PROJECT_MANAGER)`（与 `POST /skills` 同一写法），
UI 按 `/auth/me` 的角色隐藏吊销按钮，并让失败有 toast 而不是静默。

审计了全部 23 处 `@RequireRole`：其余 22 处要么路由带 `:projectId`、要么 body 里有 `projectId`、
要么 handler 里已有 `assertRole`，仅此一处是缺口。逐路由抽查也做了（`POST /skills`、
`POST /projects/:id/locales` 对 DEVELOPER 正确返回 403）。

回归测试写在 `security.integration.test.ts`：先用未修复的构建确认它失败（期望 403 实得 200），
再确认修复后通过，并断言「拒绝之后 Token 确实仍有效」与「OWNER 仍可吊销」——只断言状态码会
漏掉「返回 403 但其实已经写进去了」这类实现。

### 1.12 Skill 通过 MCP 下发给客户端

Skill 是文档，因此以 MCP **resource** 下发，指令型 Skill 额外注册 MCP **prompt**（客户端里是可调用
命令）。没有新增工具：规格 §6.2 把工具面固定在 14 local / 15 remote，而「读已发布的规范」不是一个需
要单独授权的平台能力（REST 侧 `GET /skills` 同样不带 role 或 scope 要求）。

| 端点                        | 内容                                                         |
| --------------------------- | ------------------------------------------------------------ |
| `localehub://skills`        | 清单（Markdown 表格：slug、版本、resource URI、prompt 名称） |
| `localehub://skills/{slug}` | 完整 `SKILL.md`（含 frontmatter），`text/markdown`           |
| `skill-<slug>`              | 仅 `PUBLISHED` + `kind=PROMPT`；可选参数 `focus`             |

规则（`packages/contracts/src/mcp-skills.ts` 一份实现，两个 Server、API 与 Web UI 共用）：
只下发 `PUBLISHED`；每 slug 只取最高版本（`1.10.0` > `1.9.0`，按数字比较）；`kind=SCRIPT` 只有
resource 没有 prompt；prompt 名统一加 `skill-` 前缀。

`skill-` 前缀不是装饰：`McpServer.registerPrompt` 对重名**直接抛错**，而那个错发生在 Server 构建
阶段——一个 slug 撞上内置 prompt 名，等于整台 Server 每个请求都失败，不只是该 Skill 不可用。
`REMOTE_MCP_PROMPTS`（与 `REMOTE_MCP_RESOURCES` 一起）是第二道防线，也是发现接口的唯一来源。

失败降级是**有意的**：skills 查询抛错时只记 stderr 并返回空列表（否则一个附加功能会带塌
15 个工具）。Remote MCP 无状态、每个请求建一次 Server，所以 Skill 是实时的——新发布的 Skill
下一个请求就能读到，不需要重启任何客户端。

验证（真实协议，不是断言内部对象）：

- 单元：`packages/contracts/src/__tests__/mcp-skills.test.ts`（15 个，含 `1.10.0 > 1.9.0` 与
  pre-release 排序）、Remote MCP 用 SDK 的 `InMemoryTransport` 跑真实 MCP 协议（8 个，其中 2 个
  断言「注册了什么」与「`/mcp/tools` 声明了什么」完全一致）；
- 集成：`skill-delivery.integration.test.ts`（11 个）——真库 + 真 API + 真 Remote MCP 进程 +
  真 Streamable HTTP 客户端，覆盖「DRAFT 不下发」「取最高版本」「跨组织不可见」「SCRIPT 无 prompt」
  「内置 prompt 与生成的 prompt 并存不重名」「`GET /skills` 的注解与 Server 一致」；
- 实测：容器栈里注册 5 个内置 Skill 后，SDK 客户端列出 7 个 resource、7 个 prompt，读到
  `translation-review` 正文 572 字节。

顺带修掉一个上游缺陷：`LOCALEHUB_API_URL`（文档写明覆盖 config 文件）此前被已删除的 MCP 入口写在
它自己那份 `LoadedConfig` 上，而 `LocalSyncServices` 会重新加载配置，于是覆盖被静默丢弃——所有
调用方都在和 config 文件里的地址通信。已移到 `LocalSyncServices.config()`（真正读配置的地方），
`services.test.ts` 有回归测试。

### 1.13 平台改为只暴露一个 MCP（偏离规格 §6.1 / §6.2）

**决定由用户做出**：不再提供 Local MCP，平台侧只保留 Remote MCP。这与交付规格 §6.1
（「必须采用双 MCP 边界」）与 §6.2（「Local MCP Tools（必须实现）」）不一致，是本项目
**有意偏离规格**的一处。

理由：

1. Local MCP 由每个开发者的客户端进程各自拉起，版本与能力随机器而变，平台无法统一管理、
   也无法在不打扰用户的情况下更新；
2. 它让「能力清单」失去唯一来源——工具、resource、prompt 散在两台 Server 上，平台的发现接口
   只能把两份清单糊成一个扁平列表，结果声明了 6 条没有任何 Server 实现的 resource，还把一个
   已删除 Server 的 prompt 当成通用清单发布（见 §1.12）。

**本地仓库读写并没有消失**，只是换了载体：`apps/mcp-local` 删除，引擎原地成为
`packages/local-sync`（不含任何 MCP 依赖，类名 `LocalMcpServices` → `LocalSyncServices`），
由 `apps/cli` 驱动。安全属性逐条保留：

| 属性                                                         | 原来由谁保证       | 现在由谁保证                        |
| ------------------------------------------------------------ | ------------------ | ----------------------------------- |
| `allowRead`/`allowWrite`/`deny*` 白名单、`..` 与符号链接逃逸 | Local MCP 工具层   | 同一份 `WorkspaceGuard`（CLI）      |
| 备份 + 原子写 + 写后重解析                                   | Local MCP 工具层   | 同一份 `SafeFileWriter`（CLI）      |
| 先预览后确认、默认 dry-run                                   | MCP `confirm=true` | CLI `--confirm`（缺省即拒绝）       |
| 平台够不到开发者磁盘                                         | 两 Server 分离     | 只有一个平台侧 Server，结构上更彻底 |

失去的是：MCP `annotations` 的 `readOnlyHint` 不再覆盖本地动作（客户端无法据此决定是否弹确认），
改由 CLI 的 `--confirm` 与退出码承担；Agent 需要本地能力时必须用 Bash 调 CLI，而不是调 MCP 工具。

契约层同步收缩：`LOCAL_MCP_TOOLS` / `localToolSchemas` / `LOCAL_TOOL_DESCRIPTIONS` 删除；
`localServerConfig` 与 `localAndRemote` 片段删除；`mcpClientConfig` 只剩单条远端条目，
`localehub mcp-config` 不带 `--remote` 时向平台的公开发现接口询问自己的地址。

顺带修掉 §1.12 提到的发现接口失真：`REMOTE_MCP_RESOURCES` / `REMOTE_MCP_PROMPTS` 进契约，
Server 与 `/mcp/tools` 从同一处取，并有集成测试断言「声明的每一条都真的注册了」——那条
`localehub://projects/{projectId}` 及其 4 个子资源从未被任何 Server 实现，已从声明中移除。

### 1.14 用户管理：组织内建号、分配角色（本轮新增）

此前**没有任何用户管理能力**：`POST /auth/register` 只在实例无用户时可用，`POST /projects/:id/members`
要求账号已经存在，于是除首个管理员外，任何人都无法创建账号。设置页只有一张角色说明表。

现在补全为「管理员在组织内直接建号」——不做邀请、不开放外部注册（用户明确要求）：

| 能力     | 位置                                                           | 说明                                                         |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| 成员列表 | `GET /organization/members`                                    | 含组织角色、各项目角色与 `localeScope`、最近登录             |
| 建号     | `POST /organization/members`                                   | 邮箱 + 姓名 + 初始密码 + 角色；邮箱已存在时只挂组织关系      |
| 改角色   | `PATCH /organization/members/:userId`                          | 组织级角色                                                   |
| 移出组织 | `DELETE /organization/members/:userId`                         | 同时删除其项目角色，避免重新加入时恢复旧权限                 |
| 重置密码 | `POST /organization/members/:userId/password`                  | 无邮件通道，由管理员转达                                     |
| 项目角色 | `PUT/DELETE /organization/members/:userId/projects/:projectId` | 单项目角色 + 语言范围                                        |
| 页面     | `/settings/members`                                            | 列表内联改角色、项目角色增删、建号对话框、重置密码、移出组织 |

五条提权守卫抽出到 `packages/permissions`（`assertCanManageMembers` / `assertCanGrantOrgRole` /
`assertCanManageMember`），11 个单元测试逐条钉住：不能授予高于自己的角色、不能修改高于自己的成员、
不能动自己、不能移除最后一个所有者、MCP Token 不能管理成员。

**其中一条是真实的账号接管面**：`POST /organization/members` 对已存在的邮箱**绝不复写密码**。若照搬
「按邮箱添加并设置密码」的常见写法，任何组织管理员都能用自选密码接管平台上任意账号。集成测试专门
验证：管理员用自选密码「添加」一个已有账号后，原密码仍可登录、管理员给的密码不能登录。

`users` 表没有 RLS（人可属于多个组织，没有 `organization_id` 列），所以所有用户读取都以
**RLS 保护的 `memberships` 查询返回的 id** 为键；按邮箱查人是特权读取，与登录同一例外，且仅此一处。

验证：21 个集成测试（真库 + 真 API）覆盖列表/建号/登录/重复成员/密码规则/提权守卫/项目角色/移除后
清理/重置密码；无头 Chrome 实测 `/settings/members` 渲染 6 名成员、导航可进入、建号对话框字段正确、
真实提交后表格出现新成员且该账号能用所填密码登录、桌面与 390px 均无横向溢出。

### 1.15 `POST /projects` 的角色校验从未生效（本轮发现并修复）

与 §1.11 同一类：guard 只在路由带 `projectId` 时应用 `@RequireRole`，而 `POST /projects` 既无
path 参数、body 里的 `projectId` 也不是自己，handler 与服务层都没有补 `assertRole`。结果是
**任何成员（含 READONLY）都能在组织里创建项目**——我先用真实会话复现（201 + 项目落库），再修，
再把它写进集成测试：READONLY 与 DEVELOPER 均返回 403 `ROLE_INSUFFICIENT`，且断言项目**没有被**
写进去（只断言状态码会漏掉「返回 403 但其实已经写进去了」）。

顺带审计了其余 `@RequireRole` 路由：`/organization/overview` 只返回计数、`/system/queues` 是刻意
`@Public()` 供探针使用、`/organization/settings` 在 service 内自查角色，均无同类缺口。

### 1.16 `POST /projects/:projectId/members` 可绕过全部成员守卫（本轮发现并移除）

写 §1.14 的守卫时留下一条旧路没关：`POST /projects/:projectId/members` 只要求**该项目**的
PROJECT_MANAGER，却会**代建组织成员关系**，并把传入的**项目角色当作组织角色**写进去。

实测复现：一个组织角色仅 `DEVELOPER`、只在某一个项目上有 PROJECT_MANAGER 的账号，调用该接口把一个
组织外的用户拉进组织，落库的组织角色是 `PROJECT_MANAGER`——高于他自己的组织角色，且完全绕过
§1.14 的五条守卫（不得越级授予、不得修改高于自己的成员、必须留至少一个所有者、MCP Token 不得管理
成员、以及「组织级成员管理需要 ORG_ADMIN」）。

该接口的 `POST` 在 Web、CLI、api-client 与测试中**都没有调用方**——它是纯遗留攻击面。已删除
（连同 `addMemberSchema` 与 `ProjectsService.addMember`），`GET` 保留（项目成员只读视图，无害）。
项目经理想给项目配人，走 `PUT /organization/members/:userId/projects/:projectId`（有守卫）；
要把人拉进组织，必须 ORG_ADMIN。

回归测试断言该路由返回 404。至此成员相关的写入路径只剩一条。

### 1.17 OpenAPI 3.1 文档由代码生成（本轮新增）

规格 §8.4 要求「通过 OpenAPI 3.1 生成文档和 TypeScript Client」，§16 的验收清单也列了「API
OpenAPI 文档和 MCP Tool Schema 完整」。

**没有**用 `@nestjs/swagger`。这个代码库用 `@Body(zodBody(schema))` 管道校验，不是 DTO 类，swagger
看不见它们——硬套的结果是给 81 条路由手写一遍 `@ApiBody` / `@ApiResponse`，那是**第二份**描述，必然
漂移。这正是上一轮修掉的 MCP 发现接口犯过的错（手维护的清单声明了 6 条没人实现的 resource）。

改为从**代码本身**装配（`apps/api/src/openapi/document.ts`），一条事实只说一遍：

| 文档里的内容                 | 来源                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| 路径、方法                   | `PATH_METADATA` / `METHOD_METADATA`                                                                      |
| `public` / `role` / `scopes` | `@Public` / `@RequireRole` / `@RequireScopes` 的 `SetMetadata` 键——**与 `AuthGuard` 请求时读的是同一份** |
| 请求体、查询 schema          | 路由参数上的 pipe 实例，即真正执行校验的 `ZodValidationPipe`                                             |

产出：`GET /api/v1/openapi.json`（public，客户端读它时还没有凭据）与提交进仓库的 `docs/openapi.json`
（81 个操作 / 68 条路径），由 `pnpm --filter @localehub/api openapi` 重新生成。

两处需要说明的设计：

1. **`@ApiAuth` 只描述、不强制**。有些路由的鉴权在 service 里（成员管理、`POST /projects`），guard
   元数据为空，文档里 `role: null` 会被读成「任何成员都可以」——与事实相反。这些路由用 `@ApiAuth`
   补上真实要求，并用 `x-localehub-auth.enforcedBy` 区分 `guard` / `service` / `authentication`。
   注解与执行分离，避免「写了注解就以为生效了」。
2. **响应体形状留空**。service 直接返回对象字面量，响应类型哪里都没声明。文档只描述信封
   `{success, data, error}` 并把 `data` 留作无约束，而不是编一个没有任何东西校验的形状。

一致性由 `__tests__/openapi.test.ts` 用**独立机制**守住（解析 controller 源码 + 读 app.module
注册表，不复用生成器的元数据走法）：路由集合双向比对、controller 覆盖、已提交文档逐字节比对、
手写 api-client 调用的每个端点都在文档里。四条断言都做了变异验证——故意漏掉 `QaController`、
改坏客户端路径、篡改已提交文档，测试都会红。

顺带修掉一处：`ResponseEnvelopeInterceptor` 会把 `/openapi.json` 也包成 `{success, data}`，任何
OpenAPI 工具都会找不到 `openapi` 字段。新增 `@RawResponse()` 让「描述 API 的文档」不属于「API 的
资源」，这是唯一一处豁免。

### 1.18 账号生命周期与组织审计（本轮新增）

补掉上一轮成员管理之后暴露出的几个缺口——它们都是「接口建好了，但人用不了」或「出事了查不到」：

| 缺口                      | 现在                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 改不了自己的密码          | `PATCH /auth/password`：需提供当前密码；管理员重置接口本来就拒绝操作自己，而平台没有邮件通道，此前本人**完全无法**轮换密码                                                                                   |
| 无法停用账号              | `PATCH /organization/members/:userId/status` + `users.deactivated_at`。暂停保留成员关系、项目角色与审计，但**现有**会话与 MCP Token 立即失效（`AuthGuard` 每请求检查），登录也被拒。不能暂停自己或唯一所有者 |
| 成员变更查不到            | `GET /organization/audit`（`?action=member.` 前缀筛选）+ `/settings/audit` 页。此前 `audit_logs` 一直在写，但唯一的读接口是项目级的，「谁把谁提权了」在全产品里无处可查                                      |
| 多组织登录是随机的        | 登录接受 `organizationId`，不传时进入 `last_organization_id`（新增列）记录的上次组织；传了不存在的组织返回 403 而**不是静默换一个**（见下）                                                                  |
| 多组织切换没有 UI         | 顶栏用户菜单里加组织切换（仅在属于多个组织时出现），切换后整页重载——所有已缓存页面都是按上一个组织取的                                                                                                       |
| `/system/queues` 无需认证 | 改为要求平台管理员。存活/就绪探针仍用公开的 `/health`、`/health/ready`                                                                                                                                       |

**测试抓到的一个真问题**：我最初用 `??` 链写组织选择，结果是「请求了不属于自己的组织」会**静默回退**到
另一个组织——调用方要的是 X，拿到的是 Y，之后所有写入都会落在 Y。集成测试直接把它照出来了
（期望 403，实得 201）。改成显式分支：给了 `organizationId` 就必须命中，否则 403。

`deactivated_at` 与 `last_organization_id` 两个字段都是可空、默认 NULL，迁移不重写表。

验证：15 个集成测试（真库 + 真 API）覆盖改密码（当前密码错误 401、旧密码失效、MCP Token 被拒、写审计）、
暂停（现有会话 403 `ACCOUNT_DEACTIVATED`、已签发的 MCP Token 同样失效、新登录被拒、恢复后可用、不能暂停
自己/唯一所有者、写审计）、审计（普通成员 403、跨组织不可见、记录操作者与目标）、登录选组织（进入指定组织、
记住上次、拒绝不属于的组织）、队列接口（无凭据 401、平台管理员 200、普通管理员 403）。
无头 Chrome 实测四个新/改页面均渲染真实数据、无报错、无横向溢出，并真实点击完成一次「暂停 → 徽章出现 →
恢复」。

### 1.19 CSV / XLSX 适配器（本轮新增）

规格 §10.1 给这两种格式的用途写得很具体：**「产品经理批量编辑、导入校验」**。它们是给人用的导入
导出通道，不是仓库同步格式——这条定位决定了下面每个决定。

- **`CsvAdapter`**：RFC 4180，带电子表格实际会产出的东西（引号字段、字段内换行、双写引号、CRLF）。
  导出写 BOM，因为 Excel 在 Windows 上会把无 BOM 的 UTF-8 CSV 按系统代码页读，非 ASCII 译文全乱；
  读取时容忍 BOM。`applyPatch` **只替换变化的单元格**，行尾、引号风格与列顺序原样保留——与 JSON
  适配器打 token 补丁而不是重新序列化同一个理由。
- **`XlsxAdapter`**：基于 `exceljs`（自己写 xlsx 是典型的重复造轮子）。导出为 base64 + mimeType，
  读取时把数字、日期、富文本、公式结果都归约成「人会看到的那段文字」。
  **`applyPatch` 明确拒绝**：工作簿是 zip 压缩的 XML 部件，「改一个单元格」等于重新生成整个档案，
  没有能保留作者所做修改的原地编辑。所以 `xlsx` **不在** `formatIdSchema`（仓库映射可声明的格式）里
  ——允许它出现在 `.localehub/config.yaml` 会造出一个永远 apply 不了的映射。导入导出走更宽的
  `exportFormatSchema`。
- **列名按名字解析，不按位置**，且**表头必需**：有人在表格里插一列，按位置解析就会把译文读进 key 列。
  大小写不敏感，接受 `Key`/`键`、`Translation`/`译文`、`Language`、`Comment`/`注释`。
- **校验一次报全部问题**：缺 key、缺 locale、重复（key+namespace+locale 三元组，因此同一 key 出现在两个
  namespace 不算重复）、以及值以 `=`/`+`/`@` 开头（电子表格会当公式）——行号按 1 起算并计入表头，与
  用户看到的表格一致。

`GET /projects/:projectId/export` 现在返回 `encoding` 与 `mimeType`，二进制格式不再需要第二个端点。

验证：22 个单元测试（含列顺序打乱、BOM、CRLF、字段内换行、转义往返、按 namespace 精确匹配、
XLSX 数字与富文本、拒绝原地补丁、zip 签名识别）+ 6 个集成测试（真库 + 真 API：导出 JSON/CSV/XLSX，
XLSX 解出来是 zip 签名并能被适配器读回同样的译文，未知格式 422）。

### 1.20 Webhook 事件推送（本轮新增）

`SYNC_PUSHED`、`TRANSLATION_APPROVED` / `TRANSLATION_REJECTED` 会推送到组织配置的 HTTP 端点。

| 能力     | 位置                                                                      |
| -------- | ------------------------------------------------------------------------- |
| 端点管理 | `GET/POST/PATCH/DELETE /organization/webhooks`                            |
| 投递历史 | `GET /organization/webhooks/:id/deliveries`                               |
| 签名     | `x-localehub-signature: t=<unix>,v1=<hex>`，HMAC-SHA256 over `<t>.<body>` |
| 事件标识 | `x-localehub-event`、`x-localehub-event-id`                               |

几个刻意的决定：

- **事件先落库再入队**。`webhook_deliveries` 是耐久记录，队列只是通知 worker；重启、重部署或 Redis
  清空都不会丢掉一个已经接受的事件，运维也永远能回答「这条到底送达没有」。
- **签名密钥加密存储，不是哈希**。这是唯一无法套用「只存哈希」规则的地方：校验 Token 只需要哈希，
  而**生成**签名需要密钥本身。用 `ENCRYPTION_KEY` 派生的 AES-256-GCM，数据库被拖走也伪造不了签名。
- **时间戳在被签名的字符串里**，不只是放在旁边——否则截获一个请求、改一下 `t` 就能重放。
- **至少一次投递**。worker 在消费者处理完但行未更新时崩溃会导致重复投递；`x-localehub-event-id` 是
  给消费者去重用的，文档里写明了。
- **重试约 9 小时**（10s → 30s → 2m → 10m → 30m → 2h → 6h），之后标记 `FAILED` 并留在投递日志里。
  维护窗口内下线的消费者仍能收到，彻底消失的消费者不会被反复打扰。
- 无 `eventTypes` 的端点接收全部事件——这是运维加一个 webhook 时的本意，而「静默收不到任何东西」
  是更糟的默认。

### 1.21 映射变更检测（本轮新增）

`FILE_MAPPING_CHANGED` 此前只是声明了一个冲突原因，从未被任何代码产生。现在当 baseline 记录的
`localFileId` 与本次扫描的文件不一致、且两侧都发生变化时，冲突原因是它而不是笼统的
`LOCAL_AND_REMOTE_CHANGED`——因为审核人真正要决定的是：把远端值写回去，会落到一个这条译文从未住过的文件里。

baseline 没有记录文件 id（该列之前就存在但没传给 diff）时**不**报告映射变化：把「未知」当成「变了」
会让每个尚未推送过的项目里的每条冲突都被错误重标。

验证：4 个单元测试（映射变化、普通双侧冲突不受影响、baseline 无记录时不误报、纯移动不算冲突）。

### 1.22 三个真实缺陷：后台任务从未工作（本轮发现并修复）

做 Webhook 时，端到端验证暴露了三个各自独立、又互相掩盖的缺陷。**异步 QA 从未成功入队过**：

1. **`jobId` 含冒号**。`qa/run-async` 传 `jobId: \`qa:${projectId}:...\``，BullMQ 的 job id 会成为
Redis key 的一部分，直接拒绝（`Custom Id cannot contain :`）。
2. **入队失败被静默吞掉**。`QueueService.enqueue` 为了不让请求失败而 catch 掉异常并返回
   `queued: false`，但**没有任何调用方检查这个返回值**——端点照常返回 201，客户端以为任务已受理。
   同步 QA 一直可用，所以这个洞一直没被注意到。
3. **worker 没有 RLS 上下文**。worker 用的是裸 `PrismaClient`，不设置 `app.current_org_id`；而所有
   租户表都有行级策略，于是**未限定租户的读取返回 0 行**。QA 任务因此读到「项目不存在」，
   Webhook 任务读到「投递行不存在」——两者都表现为「任务跑完了但什么都没发生」。

修法：job id 改用连字符；`enqueue` 失败打日志，`qa/run-async` 在 `queued === false` 时返回 503
而不是假装成功；worker 的作业体走 `TenantPrisma.withOrganization`（与 API 同一条受认可路径），
Webhook 作业把 `organizationId` 放进载荷——读那一行本来就需要它。

验证：`scripts/check-webhook-worker.mjs` 起一个真实 HTTP 接收端，经 API 触发事件，等 **worker 进程**
投递，再用消费者的方式验签——通过（`delivered SYNC_PUSHED | signature verified: true`）。
异步 QA 实测 `queued: true` 且 `qa_runs` 达到 `SUCCEEDED`。

### 1.23 发布包导出（本轮新增）

| 能力 | 位置                                                                                      |
| ---- | ----------------------------------------------------------------------------------------- |
| 打包 | `POST /projects/:projectId/releases/:releaseId/bundle`（PROJECT_MANAGER）                 |
| 下载 | `GET /projects/:projectId/releases/:releaseId/bundle`（READONLY，返回 `application/zip`） |

- **确定性**。条目按名字排序、时间戳固定为 1980-01-01、存储而非压缩，因此同一份快照永远产出同样的
  字节——`releases.snapshot_checksum` 才有意义：下载的人可以自己复算。测试直接断言「重新打包字节相同」。
- **自描述**。`manifest.json` 记录发布名、生成时间、语言、来源 id 与 checksum，以及**每个文件的 sha256**，
  便于部分下载时校验。
- **按项目鉴权，不按路径**。发布 id 会对着 `release` 行核对 `projectId`，所以猜到一个 id 也取不到别的
  项目、别的组织的包。
- **不走 JSON 信封**。zip 被包进 `{success, data}` 就不是 zip 了，这条路由用 `@RawResponse()`。
- 存储是按 `组织 id/发布 id.zip` 寻址的目录。规格 §8.4 要求预签名 URL 而不是把大文件塞进 JSON 响应体
  ——目录存储给出同样的性质（下载是独立请求，字节不经过 JSON），换 S3 只需替换 `bundles.ts` 里的
  存储层。**导入导出仍走 JSON 响应体**，这一条还没做完。

zip 是手写的（约 120 行）而不是引依赖：需要的形状很小，而约束很具体——存储式条目、固定时间戳、
排序文件名，通用库在这三点上都要对抗。测试用一个独立的读取器解析产物并逐条校验 CRC。

验证：9 个单元测试（分组与 namespace 展平、排序稳定性、独立读取器解析、跨运行确定性、非 ASCII
路径与内容、manifest 内容与摘要、存储的读写与隔离）+ 6 个集成测试（真库 + 真 API：建发布、未打包时
404、打包、下载得到真实 zip 且信封未污染、重新打包字节相同、跨项目 id 取不到）。

### 1.24 `users` / `organizations` / `review_actions` 的 RLS（本轮新增）

这三张表最初被排除在行级策略之外，因为它们都没有 `organization_id` 列：`users` 与
`organizations` 天然是全局的，`review_actions` 通过 `review_tasks` 关联租户。

**这个缺口的方向是危险的**：应用角色不是表 owner，没有策略时未限定租户的读取返回的是
**全部行**，而不是零行。对 `users` 来说，这意味着任何忘记加过滤条件的代码路径都能读到所有用户的
密码哈希。

三张表各自的策略用各自能表达的写法：

- 用户：属于当前组织时可见，经 `memberships` 子查询判断——而 `memberships` 本身受策略保护，
  所以这条不能用来枚举别的租户的人；
- 组织：只有当前会话所属的那一个可见；
- 审核动作：其审核任务在范围内时可见。

给 `users` 加策略**当场打断了登录**，而这正是这次改动有价值的部分：`auth.controller` 写
`lastLoginAt` 用的是裸 `prisma.user.update`，新策略下匹配 0 行，报错是「record not found」——
一个刚刚认证成功的账号却「不存在」。该调用改为走 `withoutTenantScope`（这个文件里其他用户读取
本来就走这条特权路径），并做了一次全仓扫描确认三张表上不再有裸调用。

这个例外是承重的、不是顺手加的，因此写在策略注释里：登录与 Token 认证在 `app.bypass_rls = on`
下运行，因为它们在任何组织已知之前就要读 `users`。

验证方式特意选了**直接用应用角色**（生产同款凭据）而不是经过 API：跨租户读为空、无上下文读为空、
审核动作经任务正确隔离，以及登录路径依然可用。

### 1.25 Docker 栈已重建并验证（本轮）

本轮最后一次改动后，Docker 守护进程内的网络一度持续失败（`registry.npmjs.org` 上的 `ECONNRESET`），
`docker compose build` 装不进新代码，而数据库已应用新的 RLS 迁移——旧镜像里裸写的
`prisma.user.update`（登录更新 `lastLoginAt`）在新策略下匹配 0 行，于是容器栈登录返回 404。

网络恢复后已重建并验证。**其中一处值得记下**：`worker` 用的是独立镜像 `localehub-worker`，不是
`localehub-api`；只重建后者时 worker 仍跑旧代码，日志里少一个队列（4 个而不是 5 个），很容易被当成
「新功能没生效」。完整重建命令是：

```bash
docker compose build api worker mcp-remote web && docker compose up -d --force-recreate
```

重建后的容器栈验证：

- 登录恢复（此前 404 的那条）；
- 98 个集成测试对着**容器栈**全过（不是本地进程）；
- `scripts/check-webhook-worker.mjs` 经容器内 worker 真实投递并验签通过——注意脚本的接收端要
  监听 `0.0.0.0` 并把 `host.docker.internal` 写进 URL，否则容器内的 worker 连不上宿主上的接收端，
  表现为 `fetch failed`（重试机制会正确地把它标成 PENDING/重试中）；
- demo A–E 通过；
- 无头 Chrome 实测 **15/15** 页面渲染真实数据、无错误提示、无横向溢出；390px 下五个设置页同样无溢出。

### 1.26 MCP 接入教程与「按使用者适配」（本轮新增）

此前的 `/mcp` 页面把工具表、资源、配置片段都列了出来，却**没有一条从头到尾的流程**：读者要自己
拼出「先签 Token → 再找 project_id → 粘贴配置 → 验证」。其中最要命的是 project_id——15 个工具里
14 个把它当第一个参数，而它在 UI 里**根本看不到**，只能去翻 URL 或者先跑一次 `list_projects`。

现在：

- `/mcp` 新增「接入教程」标签页并作为默认页：四个编号步骤（签 Token → 拿 project_id →
  放配置 → 验证并开始用），每步给出可点的入口与可复制的片段；
- **项目详情页标题旁显示 `project_id`，点击即复制**；
- 教程里的示例提示词用**当前登录者自己的项目**生成（名称与 id 都是真实的），不是演示数据；
- 文档补了同一份四步流程，以及 §2.3「使用者之间如何隔离」——把「数据自动适配使用者」落到具体机制上：
  Token 绑定、角色解析、RLS、以及示例按读者生成。

关于「自动适配」需要说清楚边界：**平台侧本来就没有需要使用者改的配置**。工具看到哪些项目由 Token
的 `project_ids` 与用户的项目角色决定，SQL 层再由 RLS 兜底；接入者看到的列表、示例里的 id、能读到的
译文，天然都是他自己的。真正缺的是**把这些暴露出来**——一个看不见的 id 会让「自动适配」在体验上退化
成「你得先想办法找到它」。

验证：无头 Chrome 实测教程页为默认标签、四个步骤渲染、页面出现真实 project_id、提示词带
`project_id=`、无报错无溢出；项目详情页显示并可复制 id。另有一个端到端脚本按教程四步真实走一遍
（`scripts/check-mcp-onboarding.mjs`）：签一个只绑定单个项目的 Token，经真实 MCP 传输调用
`list_projects`——**只返回那一个项目**，再用该 id 调 `list_project_locales` 成功。

**运行期间的一次磁盘事故**：重建镜像把 Docker 磁盘占满，Postgres 因
`could not write lock file "postmaster.pid": No space left on device` 反复重启，API 报
`Can't reach database server at postgres:5432`。`docker builder prune -af && docker image prune -af`
回收 21.77 GB 后自行恢复，无需重建数据。这一条与 §1.10 的「只在容器里出现的缺陷」同类：
**症状指向数据库，原因在磁盘**。

### 1.27 从仓库初始化项目（本轮新增）

上一轮补了接入教程，但它默认「你已经有一个项目」。真实的第一天不是这样：仓库里已经有语言文件，
平台上什么都没有。而且**远程 MCP 当时根本没有建项目的工具**——15 个工具全是读写既有项目，Agent
无法把仓库接到平台上。

新增两个工具：

| 工具                  | 做什么                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `create_project`      | 建项目（语言、平台、创建者成为该项目 PROJECT_MANAGER），**返回可直接写入 `.localehub/config.yaml` 的完整内容**与后续步骤 |
| `import_translations` | 把一批语言文件内容写成 Key / 源文版本 / 译文；默认 dry-run，`confirm=true` 才落库                                        |

三个刻意的决定：

1. **是 Agent 读文件，不是平台。** 平台够不到开发者的磁盘，所以 Agent 用自己的文件工具读语言文件、
   把内容交给 MCP。这不是绕过边界，而是边界本身决定的形状。
2. **配置是「返回」而不是「写入」。** `create_project` 把配置文件的内容作为返回值交给 Agent，
   由 Agent 写进仓库——初始化路径上同样不碰使用者的磁盘。
3. **导入复用 CLI 的管道**（`recordScan` → `createPreview` → `push`），因此 Agent 导入与 CLI 推送
   不可能在平台上留下不同的状态。

**顺带消除了两份实现**：建项目原本只在 `ProjectsService.create` 里，MCP 要建项目就得抄一遍。现在抽到
`packages/domain/src/projects.ts` 的 `createProject(tx, input)`，REST 与 MCP 共用；`slugify` 同理。
`localehub init` 与 `create_project` 也共用 `packages/workspace/src/config-template.ts` 的模板，
所以「命令行初始化」与「Agent 初始化」产出的配置文件逐字一致。

**容器状态**：BuildKit 因 Docker Hub 认证失败（`failed to fetch oauth token: … EOF`）无法构建，但旧版
构建器可用——它直接使用本地已有的基础镜像，不需要 registry 认证：

```bash
DOCKER_BUILDKIT=0 docker compose build api worker mcp-remote web && docker compose up -d --force-recreate
```

已用这条路重建并验证：容器栈的 `/mcp/tools` 返回 **17 个工具**（含 `create_project` /
`import_translations`），104 个集成测试与 demo 对着容器栈通过，并用真实 MCP 客户端在容器上走完了
建项目 → 返回配置 → dry-run → 确认导入（`{"created":2,...}`）。

验证：6 个集成测试（真库 + 真 API + 真 MCP 进程 + 真 Streamable HTTP 客户端）。其中最关键的一条是
**把 `create_project` 返回的配置文本喂给 `localConfigSchema` 校验**——一个「看起来对但 CLI 不接受」的
模板会让使用者拿到一个坏仓库却看不出原因。其余覆盖：返回的后续步骤含项目 id 与 token 变量、
DEVELOPER 建项目被拒、dry-run 不落库、确认后 Key 与译文确实写入、Token 未绑定的项目被拒。

### 1.28 MCP 的写入不进审计（本轮发现并修复）

用户问「现在没有把初始项目汇报到服务器的吗」。检查一次真实初始化后的库：

```
project 1 | locales 2 | translation_keys 2 | translation_entries 4
repository_connections 1 | sync_scans 1 | sync_sessions 1 | sync_baselines 4
project_events 7 | audit_logs 0
```

项目、条目、事件都在，唯独 `audit_logs` 是 **0**——而同一份数据走 REST 推送时，`sync.push` 已经
写了 340 行。`grep -c 'audit' apps/mcp-remote/src/server.ts` 返回 `0`：Remote MCP 里一次审计都没写。

这不是「少了个锦上添花的功能」：§1.18 刚建的组织审计页读的就是这张表，所以**通过 MCP 做的每一次
写入在产品里都是隐形的**，「谁导入了这四十个 key」在系统里没有答案。

根因是结构性而非遗漏——写入逻辑原本放在 Nest 的 `AuditService` 里，一个 `@Injectable()`，MCP 进程
根本构造不出来。所以：

| 改动                                                     | 为什么                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 抽出 `packages/domain/src/audit.ts`（`recordAudit` + `redactForAudit`） | 两个进程写同一张表，就必须共用同一段写入逻辑，否则形状迟早分叉                               |
| `AuditService` 改为薄封装                                | 只保留请求特有的东西（`requestId` 来自 async context），其余全部委托                          |
| MCP 加 `audit()` 小助手                                   | actor 一律取自 Token，不接受工具参数——审计的意义就是记「真正是谁做的」                        |
| 六个写工具各加一处                                       | `project.create`、`sync.push`、`translation.ai_translate`、`translation.review`、`translation.draft_update`、`translation.submit_review` |

四个刻意保持的性质：

1. **只读不记账。** dry-run 与 `write_drafts:false` 不写，否则审计页把「看一眼」记成「改一次」。
2. **键名脱敏。** `token` / `secret` / `password` / `authorization` / `cookie` 在落库前替换为
   `[redacted]`，递归处理嵌套对象与数组。
3. **失败不外抛。** 审计写不进去只打 stderr：被记录的动作已经完成，不能因为记不上账就让它看起来失败。
4. **在事务提交之后写。** `recordAudit` 走独立连接，所以 `review_translation_entries` /
   `update_translation_draft` / `submit_review` 里的审计调用被移到 `withOrganization` **之外**：
   放在里面的话，业务事务一旦回滚，审计行会留下来，页面就会声称一次没发生的审核「已批准」。

`import_translations` 沿用 REST 的 action 名 `sync.push`（同一件事），用 `metadata.via` 区分入口，
所以按 action 聚合的统计不会因为入口不同而裂成两份。

**顺带让审计页真的能回答那个问题**：`GET /organization/audit` 增加 `?actorType=mcp` 过滤，返回的每行
带上 `mcpClient`（名称、Token 前缀、是否已撤销）；`/settings/audit` 因此能一眼分出「人改的」与
「Agent 改的」，并在 Agent 行上标出具体是哪把 Token——撤销时不会误伤同事的 CI。

验证：8 个新增单元测试（脱敏、默认值、特权路径、失败不上抛）+ 2 个新增集成测试。都用真 MCP 客户端
建项目、dry-run、确认导入，然后：

- `GET /projects/:projectId/audit` 断言 `project.create` 与 `sync.push` 都在、`actor_type='mcp'`、
  `actor_id` 与 `mcp_client_id` 都指向真实身份、dry-run 没有留下第二行；
- `GET /organization/audit?actorType=mcp` 断言返回的每行都是 MCP、`actor.email` 是签发人、
  `mcpClient.name` 是 Token 名、前缀匹配、未撤销。

### 1.29 平台 → 仓库方向没有闭环（本轮新增 `mark_applied`）

上一轮把「仓库 → 平台」补齐了，但反方向是断的：Agent 能读已审核译文（`get_pending_platform_changes`）、
能自己写文件，**却没有任何工具能说「我写完了」**。后果是 `applied_to_repo_at` 永远为空：

- `get_pending_platform_changes` 每次都把同一批变更再发一遍，Agent 反复做同一件事；
- `validate_release` 一直把它们算作「未落地」；
- 仓库和平台明明一致，系统却认为不一致。

CLI 侧这条路是通的（`apply --confirm` → `POST /sync/apply-reports`），所以缺的不是机制而是入口。

新增第 18 个工具 `mark_applied`：`{ project_id, items[{key, locale, platform, file_path?, translation_version_id?}],
dry_run, git_commit? }`。它写 `applied_to_repo_at` / `applied_to_repo_commit`、把三方比较基线推到已收敛、
发 `SYNC_APPLIED` 事件、留 `sync.apply` 审计，并建一条 `pull` 方向的 sync session 与 apply report
——所以 Agent 的落地在同步历史里和 CLI 的落地并排可见。

**每条都要带 `translation_version_id`，这是这个工具唯一真正的安全检查。** 平台看不到开发者的磁盘，
这条记录本质是**声明**而不是**观测**（和 CLI 的 apply report 同一种信任）。平台能验证的是「你声明的
版本是不是它现在持有的版本」：带旧版本号的条目判为 `VERSION_SUPERSEDED` 并**拒绝标记**。否则一个慢
半拍的 Agent 会把昨天的译文写进仓库、标记为已落地，平台从此不再下发新的那条——这是系统里唯一没有
其他机制能发现的偏差方向。其余判定：`NOT_FOUND`、`ALREADY_APPLIED`（幂等：重复调用不报错、不重复记
事件、不建 session）、`DRAFT_NOT_ALLOWED`（未审核文本落仓库需要组织打开 `allowDraftApply`，与 REST
拉取同一条策略）。`dry_run=true` 只回答不写。

`reportApply` 与 `markApplied` 共用抽出来的 `recordRepositoryWrite`：两边都在对一台平台看不见的机器
做同一个断言，就必须移动同样三样东西（落地标记、基线、事件），两份实现迟早分叉。

**顺带发现并修复：MCP 完全不校验 scope。** 实测确认——签一个只有 `project.read` 的 Token，调用
`import_translations` 能成功写库。服务端只 `assertRole`，从不 `assertScope`，而 REST 路由是靠
`@RequireScopes` 拦的。于是规格 §2.2「`sync.push` 与 `translation.apply` 必须分离授权」在唯一真正
依赖它的入口上失效——默认签发的 Token 明确不含 `translation.apply`，但它照样能把平台变更标记为已落地。

修复方式是把对应关系写进契约（`REMOTE_MCP_TOOL_SCOPES`），并在 `define` 包装层统一断言：放在包装层
而不是各 handler 里，因为「忘了写的检查」等于「没有检查」。映射逐条对齐 REST：

| 工具                         | scope                                              | 对应 REST                     |
| ---------------------------- | -------------------------------------------------- | ----------------------------- |
| `import_translations`        | `repository.scan` + `sync.preview` + `sync.push`    | `/sync/scans`、`/sync/preview`、`/sync/push` |
| `update_translation_draft`   | `translation.write`                                 | `POST /translations/:id/draft` |
| `review_translation_entries` | `translation.review`                                | `POST /translations/review`    |
| `mark_applied`               | `translation.apply`                                 | `POST /sync/apply-reports`     |

其余工具与 REST 对应路由一致：只校验角色。

验证：契约层 5 个单元测试（工具与 schema 一一对应、scope 映射只引用真实工具与真实 scope、两个写工具
的 scope 被钉住）+ 6 个新增集成测试，用真 MCP 客户端跑完整闭环：把一条译文改成 APPROVED →
`get_pending_platform_changes` 显示未落地 → `dry_run` 不写不建 session → 确认后落地、平台不再下发、
REST 视图一致 → 审计有 `sync.apply` 且带 `via: mark_applied` 与 commit → 重复调用幂等且不重复记账 →
平台在期间又改了一版时旧版本号被拒（且真的什么都没改）→ 只有 `sync.push` 的 Token 调 `mark_applied`
得到 `SCOPE_INSUFFICIENT`，但仍能做它被授权的事。

### 1.30 MCP 之前不教怎么用（本轮新增 instructions / 教程资源 / 提示词）

起因是一份真实记录：一个 Agent 连上来，用「发畸形请求看报错」的方式摸 `import_translations` 的入参，三次
往返才问出 `files[0].entries[0].key`，最后写下「MCP 只报字段名，无文档」。

**这个判断是错的，但结论是对的**——schema 一直是完整的（`tools/list` 返回 `required`、嵌套结构、类型、
`default`、`min/max`），只是**没有任何一层在教**。它的试错方法还有个结构性缺陷：报错只列**必填**字段，
凡是带默认值的字段全部隐身，而这里带默认值的恰好是最危险的三个：

| 字段 | 默认值 | 不显式传会怎样 |
| --- | --- | --- |
| `platform` | `web` | iOS 的 key 全部落到 `web` 下。platform 是 key 身份的一部分，之后用 `ios` 扫同一批文件会变成两套不相干的 key |
| `namespace` | `''` | iOS 的 Localizable / InfoPlist / LaunchScreen 三张表拍平成一个 key 空间，同名 key 互相覆盖且不报错 |
| `confirm` | `false` | 这个默认是对的，但它不知道——于是把「安全的两段式」当成「5800 条不可逆写入」在担心 |

所以现在补了四层，各司其职：

| 层 | 内容 |
| --- | --- |
| `instructions` | 两个方向别搞反（仓库→平台 / 平台→仓库）、三条事后难改的规则、分批上限、dry-run 默认 |
| `localehub://import-guide` | 完整教程：调用形状、逐条规则、实测边界、推荐顺序、`.strings` 解析坑 |
| `import-localization-files` 提示词 | 七步流程（读文件 → 推 locale/platform → dry run → 分批导入 → 核对），供人从客户端直接唤起 |
| 工具与字段 `description` | 每个字段在什么情况下会出错；**字段描述随 schema 走，所以默认值也能被解释** |

字段描述是关键：`platform` 在 schema 里现在是
`{"type":"string","enum":[…],"default":"web","description":"默认是 web：iOS 请传 'ios'…platform 是 key 身份的一部分"}`。
这正是试错法拿不到的东西。

**顺带把上传上限量清楚了**（此前只是从代码推断）。整个导入跑在一个 Prisma 交互式事务里，默认超时 5 秒：

| 单次调用条目数 | 结果 |
| --- | --- |
| 400 | 成功，约 3.2 秒 |
| 1000 | 失败：`Transaction already closed: … timeout was 5000 ms` |
| 1400 | 失败：同上 |

失败是原子的（超时那次落库 0 条）。教程因此给的是「按文件 × 语言拆开，每批 300~400 条」，并说明重复导入
幂等（未改动的值判 `changed:false`，不产生重复版本）。一万条 key 约 30 次调用——这是当前实现的真实上限，
把工具改成服务端自动分批是后续项（见 §5）。

验证：19 个 MCP 单测（其中 12 个新增，覆盖 instructions 的两方向与三条规则、教程资源的 URI/mime/必含条款、
提示词的参数渲染与「发现 platform/locale 不符要停下来」、带默认值字段必须有描述、任何工具都不许没有描述），
外加容器栈上用真实 MCP 客户端读取确认。

### 1.31 仓库有、平台没有的语言（本轮新增自动扩充）

用户要求：「当平台没有仓库的 locale 的时候 要支持自动扩充」。先实测现状，发现两个缺口，一个比一个贵：

**缺口一：确实会自动建，但是静默的。** 导入 `zh-Hant`、`fr-FR` 时 `ensureLocale` 会建语言行——返回
`{created: 1}`，没有任何地方说明项目多了两个语言，只有事后打开项目页才发现。

**缺口二：等价标签不被认成同一个语言。** 这是真正花钱的那个。项目 `sourceLocale = zh-CN`，iOS 仓库的源目录
是 `zh-Hans.lproj`。实测：平台**新建了一个 `zh-Hans` 语言**，`locales` 变成 `en-US, zh-CN(src), zh-Hans`——
而且因为 `zh-Hans !== zh-CN`，这批内容**不被当作源文**：`upsertSourceVersion` 不执行，译文全部
`basedOnSourceVersionId = null`。项目变成「有译文、没有原文」，占位符校验、源文变更标 stale、AI 翻译全部
失去参照物，**全程不报错**。

修法是把「扩充」定义成三件事，而不是一件：

| 情况 | 行为 |
| --- | --- |
| 代码相同 | 直接用 |
| 等价标签 | 归入项目已有的那个（`zh-Hans` → `zh-CN`、`zh-Hant` → `zh-TW`、`en` → `en-US`、`ja` → `ja-JP`） |
| 项目没有 | 新建语言行，名字用中文可读名（`localeDisplayName`：`简体中文（中国）`、`法语（法国）`、`韩语`） |
| 无法判断 | **拒绝**：项目同时有 `zh-CN` 和 `zh-TW` 而来的是 `zh`，返回 409 `INVALID_LOCALE` 并列出候选 |

platform 同样处理：项目只声明 `web`，内容来了 `ios`，就自动加上 `project_platforms`。

等价判断**刻意写死在一张小表里**（只有中文的脚本↔地区真正互替，加上「光秃秃的语言对上唯一匹配」），不猜
CLDR 的 likely-subtags——认错方向的代价是把繁体归到简体下。

**顺带修掉 `canonicalizeLocaleTag` 的一个真实缺陷**：它号称「小写语言、Title 脚本、大写地区」，但遇到
`pt-br`、`zh-hans` 这种输入时既不修也不报，返回原样，而 `isValidLocaleTag` 又会拒绝——于是目录名和手写
config 里的这类标签会以一个没人看得懂的错误失败。现在按位置修大小写（紧跟语言的四字母只能是脚本，
两字母或三位数字只能是地区），因为位置使这个修复无歧义。

**可预见性是重点**，所以 `expansion` 出现在三个地方：dry run 的返回值（「什么都没写」在调用方真正想知道
「这次导入会让项目变成什么样」时毫无用处）、`sync.push` 审计行、以及 `localehub scan` 的输出。dry run 里
`platformsAdded` 一度是空的——在容器栈上跑出来才发现的，已补并加了回归测试。

验证：9 个契约单测（等价、不混淆繁简、光秃标签、歧义拒绝、可读名字、大小写修复）+ 8 个集成测试（zh-Hans
归入 zh-CN 且判为源文、真新语言被新增且命名、新端被加上、dry run 报告但真的不写、歧义被拒且候选列出、
审计留痕），外加容器栈实测：同一个 `zh-Hans.lproj` 场景，修复前 `locales` 是 `en-US, zh-CN(src), zh-Hans`，
修复后是 `en-US, zh-CN(src)`。

### 1.32 项目管理：配置可改，语言用选的（本轮）

用户的要求：「点每个项目可以修改配置 平台那些 语言配置也可以增加 源语言和目标语言是要 key 选择 不要用手写」。

改之前：项目详情页是**只读**的，语言卡片只是一张表；新建项目的表单里源语言与目标语言是两个自由输入框，
各接受一串 BCP 47 代码。那个输入框是一个带静默失败的记忆测试——`zh-Hans` 与 `zh-CN` 对人是同一个语言、
对数据库是两个，打错了要么得到一个关于语言标签的报错，要么更糟：建出一个没人想要的语言。

**语言选择器**（`components/locale-picker.tsx`）。数据来自新的 `packages/contracts/src/locale-catalog.ts`
（97 种语言，含 `native` 与 `english` 两个名字）：

- 按代码、母语名、英文名都能搜（`中文` 能搜出全部五种中文变体，`korean` 能搜出 `ko-KR`）；
- 下拉里同时显示 `localeLabel(entry)` 与英文名，右边是代码；
- **列表之外的语言仍可输入**：输入 `haw-US` 这类合法标签时出现「使用 haw-US」一行。目录是便利，不是约束；
- 目标语言是多选（`multiple` 模式），源语言单选；
- 选源语言时会自动把它从目标语言里去掉——同一个语言在表单里出现两次读起来像错误。

`localeLabel` 输出**中文**标签（产品是中文的，`한국어` 或 `· FR` 不是中文读者能扫的标签），并只在**有区分
意义时**加地区：整个目录里只有一种韩语，就显示 `韩语`；英语有六种，必须显示 `英语（美国）` 与 `英语（英国）`，
否则两行一模一样，选择变成猜测。语言自己的名字（`한국어`）退到下拉项的第二行，翻译看得懂它。搜中文名也能搜到
（输 `韩语` 出 `ko-KR`，输 `繁体` 出三种繁体中文）。

**项目设置页**（`/projects/[projectId]`）：

| 能力 | 规则 |
| --- | --- |
| 改名称 / 描述 | 直接保存 |
| 改平台（多选） | 作为**集合**整体提交（`PATCH /projects/:id { platforms }`），表单一次保存 |
| 加语言 | `POST /projects/:id/locales`，名字自动用目录里的中文名（`韩语`） |
| 删语言 | `DELETE /projects/:id/locales/:code`，源语言不可删 |
| 改源语言 | 只在项目**还没有任何译文**时允许 |

三条拒绝值得单独说，因为它们都是「现在便宜、几千条之后昂贵」的决定：

1. **加一个已有语言的另一种写法会被拒**（已有 `zh-CN` 再添加 `zh-Hans`）。否则译文会被拆到两个语言下，
   而两边的统计都看起来正常。
2. **有译文的语言不能删**。删语言会级联删掉它的全部译文——那是该让人看着数字决定的，不该是整理列表的副产品。
3. **源语言在有译文后不能改**。源文版本、stale 标记、三方比较基线全都锚在它上面，改锚点等于让这些
   全部指向一个已经不存在的语言。空项目下则允许，并且支持**交换**（把源语言改成已有的某个目标语言，
   两个 locale 的 `isSource` 互换）。

平台同样有保护：不能删到最后一个（项目没有端就无处放 Key），有 Key 的端不能删（`DELETE .../platforms/:platform`）。

**语言标签改中文**（同一轮追加）：目录原本用语言自己的名字做标签（`한국어`、`Français · FR`、`አማርኛ`），
那在语言切换器上是对的，在一个中文后台里是错的——选语言的人得先认出一种自己可能不认识的文字，而 `· FR` 是地区码
不是词。现在 `localeLabel` 输出中文（`韩语`、`英语（美国）`、`简体中文（中国）`），母语名退到下拉项第二行
（翻译看得懂它），搜索同时匹配中文名、母语名、英文名与代码——输 `韩语` 出 `ko-KR`，输 `繁体` 出三种繁体中文。
新增的 `LANGUAGE_ZH` / `REGION_ZH` / `SCRIPT_ZH` 三张表也被 `localeDisplayName` 的兜底路径复用，
所以目录内外的措辞不会分叉。`zh-CN` 没有 script 子标签但就是简体，靠 `ZH_IMPLIED_SCRIPT` 补上，
否则 `zh-CN` 与 `zh-TW` 会都显示成「中文」。

**一个只在镜像里暴露的坑**：Web 改成 import `@localehub/contracts` 后，Docker 构建失败两次——
先是 `web.Dockerfile` 只拷贝了 contracts 的**源码**、没跑它的 build（该包的入口是 `dist`）；补上构建后
又撞 `node:crypto`（contracts 根的 `hash.ts` 用了它，webpack 无法为浏览器解析）。解法不是 polyfill，
而是给 contracts 加浏览器安全的子路径导出（`@localehub/contracts/locale` 与 `/locale-catalog`），
Web 只引用这两个——把「浏览器能用哪部分」写成显式契约，而不是指望 tree-shaking 分析 Node 内置模块。

验证：215 单元（+1 语言标签唯一性）+ 129 集成（+8 项目设置：改名、加语言并命名、拒绝重复语言、删语言与
源语言保护、空项目换源语言、有译文后拒绝换源语言、平台集合保存与「至少一个」、有 Key 的端不能删），
以及浏览器实测三处交互。

### 1.33 平台写入 100% 失败：一次推送的开销与项目大小成正比（本轮发现并修复）

用户转来另一个 Agent 的记录：「平台侧 5 秒事务超时复现了」「连 1 条都失败」「每次卡满 5 秒事务上限」。

**先复现**。本机单条写入是 87ms，看起来没问题；但那个 Agent 的项目（高研院iOS）已经有 2,792 个 key /
5,480 条译文，而且 `sync_scans` 显示它每次只发 **1 条**仍失败，`sync_plans` 里那次只有 1 条扫描的计划却有
**5,481 个 item**。差距在项目体积，不在批次大小。

**根因**（两处，各自都足以致命）：

| # | 问题 | 为什么致命 |
| --- | --- | --- |
| 1 | `createPreview` 把连接上**所有 baseline** 的 identity 都加进比较集合，`buildSyncPlan` 为每个都生成 item（含无事可做的 `SKIP`），`push` 再为**每个 item** 写一行 `sync_items` | 一次推送的开销 = 项目大小，而不是改动量。5,480 条 → 5,481 个 item，5 秒事务写不完 |
| 2 | 批次被当成**整个仓库的快照**：本批没带的条目一律判 `ARCHIVE_CANDIDATE`（本地已删除） | 分批导入时每批都重新制造 5,480 个归档候选，每个同样写一行 `sync_items` |

两条叠在一起：分批导入越到后面越慢，最后连 1 条都过不去——而**减小批次完全没用**，因为成本不在批次里。

**修法**：

1. `buildSyncPlan` 只把要做的 item 放进计划（`SKIP` 过滤掉），`summary` 仍统计它们——`unchanged: 5480`
   是读者想知道的，5,480 行「什么都没发生」不是。§1.29 的经验在这里复用了：dry run 要回答「会变成什么样」。
2. 新增 `sync_scans.partial`（迁移 `20261113000000_sync_scan_partial`）：CLI 的 `scan` 扫的是配置里全部
   文件（`partial=false`，缺席即删除，归档候选照常）；`scan --file-set` 与 MCP 的 `import_translations`
   只带部分文件（`partial=true`），于是**只有这一批出现的 identity 参与比较**。
3. `TenantPrisma` 增加 `withOrganizationBulk`（默认 60 秒，`BULK_TRANSACTION_TIMEOUT_MS` 可配），给
   `recordScan` / `createPreview` / `push` / `reportApply` / `markApplied` 这些「写入量由调用方决定」的
   路径用。单独入口而不是开关，是为了让调用点读起来就是它本来的样子。

**一个连带的语义变化**：`push` 的 `skipped` 现在只表示「计划里有、但决定不做」（例如没开 `includeDeletes`
的归档候选）。无变化的条目根本不进计划，所以导入的返回值补了 `unchanged`，回答「这次导入做了事吗」。

**实测**（修前 → 修后）：

| 场景 | 修前 | 修后 |
| --- | --- | --- |
| 往 960 条的项目导入 1 条 | 1,287ms（且持续恶化） | — |
| 往 10,400 条的项目导入 1 条 | 失败 | **1.1 秒** |
| 往同一个项目填 10,400 条（每批 800） | 中途超时 | 全部通过 |
| 往那个出问题的 5,480 条项目导入 1 / 20 / 100 条 | 全部失败 | 1.16s / 1.23s / 1.98s |

**教程与文档同步改掉**：MCP 指南原先写「每批 300~400 条，否则必失败」——那个建议现在既不准确也没必要，
改为说明「开销只与本批条数有关」以及「批次不会把没带来的文件判成删除」。工具描述里那句「单次只放
300~400 条」同样改写。

验证：217 单元 + 131 集成（新增 2 个回归测试：一次推送的 item 数必须等于改动量——那个 5,481 的 bug 会让它
变成「改动量 + 项目全部条目」；以及重跑不变的条目时 `unchanged` 如实报告），外加容器栈实测。

### 1.34 翻译编辑器：翻页、独立滚动，以及一个顺带发现的排序问题

用户要求：「翻译编辑器 需要可以滚动和翻页」。

**翻页以前不存在**：列表请求里带了 `limit=100`，`nextCursor` 被取回后直接丢掉。所以一个有 8,300 条的项目
在编辑器里只能看到前 100 条，而且卡片上写着「100 条」——那既不是总数，也没有任何地方说明还有多少。

改法：

- **游标分页**：`cursors` 栈（每访问一页压一个游标）。`nextCursor` 只指向后一页，「上一页」用的是来时的
  那个游标——API 没有 offset 可算，所以只能记着。任何筛选变化都会重置游标（它指向的是上一个结果集）。
- **每页条数可选**（50 / 100 / 200），底部显示「第 101–200 条，共 8,300 条」。
- **接口补 `total`**：游标响应里推不出页数，而编辑器显示「100 条」却让人以为那就是全部。同一事务里多一次
  `count`（走同样的 where，有索引）。
- **排序改成按 key 名**：原来是 `(localeCode, keyId)`，而 `keyId` 是 UUID——顺序稳定但**没有意义**。
  翻页翻的是随机顺序，等于没法用。现在 `(localeCode, key.key, id)`，最后一项是为了让顺序全序（游标分页
  需要）。这个问题在写测试时就撞到过（§1.31 里「列表按 UUID 排序，所以『第一条』每次运行都不同」），
  当时只在测试里绕开了。

**滚动**：xl 以上两个面板各自填满视口并独立滚动（列表用 `ScrollArea`，详情正文也有自己的 `ScrollArea`），
整页不再滚动；xl 以下整页滚动、列表限高 60vh——手机上两个嵌套滚动区比一个更糟。长原文放在 `max-h-64
overflow-auto` 的框里自己滚，而不是把页面撑长。

一个只在浏览器里才发现的细节：只开列表（没选中条目）时外层容器没有高度约束，`h-full` 解析成 auto，
整个列表把页面撑到 4,145px。修正是让外层在 xl 下**始终**有高度，而不是只在选中条目时才有。

顺带加的两个编辑器该有的行为：**↑/↓ 切换条目**（焦点在输入框里时不拦截，否则译文框里没法用方向键移动光标），
在最后一行按 ↓ 自动翻页；选中的行会 `scrollIntoView({block:'nearest'})`，键盘走动时始终可见。
筛选输入加了 300ms 防抖——加上 `count` 之后每次按键是两个查询。

验证：217 单元 + 132 集成（新增 1 个：按 key 名排序、`total` 是结果集大小而非页大小、游标翻到下一页），
浏览器实测 1440×900 与 390×844：翻页 1→2→1、行序为 `k000…k099` / `k100…`、↑/↓ 切换、最后一行 ↓ 翻页、
长原文在框内滚动、整页 `docScrollH === viewportH`（桌面）/ 可滚动（手机）、均无横向溢出。

## 2. 未实现 / 部分实现

| 项                                                  | 状态       | 说明                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI 3.1 文档                                    | **已完成** | 由装饰器元数据生成（81 个操作 / 68 条路径），`GET /api/v1/openapi.json` + `docs/openapi.json`，见 §1.17                                                                                                                                                                                                                                                                                 |
| OpenAPI 驱动的 TS Client 生成                       | 部分       | 客户端仍手写（方法体是真 HTTP 调用），但新增测试断言「客户端调用的每个端点都在文档里」，路径漂移会被 CI 拦住                                                                                                                                                                                                                                                                            |     |
| Remote MCP 的 OAuth 2.1                             | 部分       | 仅 Bearer Token；无 OAuth 授权码流程                                                                                                                                                                                                                                                                                                                                                    |
| Remote MCP 的 Resources 模板                        | 部分       | 已注册 `qa-rules`、`localehub://skills` 与 `localehub://skills/{slug}`。项目级资源模板（`localehub://projects/{projectId}` 及其子资源）**未实现**，已从 `/mcp/tools` 的声明中移除——声明一条没有 Server 实现的 resource 会让客户端去读一个必然失败的地址（见 §1.13）                                                                                                                     |
| Skills 脚本隔离执行器                               | **未实现** | `kind=SCRIPT` 仅登记，任何进程都不执行（见 SKILLS.md）                                                                                                                                                                                                                                                                                                                                  |
| 对象存储 / 预签名 URL                               | 部分       | 发布包走目录存储并按组织/发布 id 寻址，下载是独立请求；导入导出仍走 JSON 响应体，未接 S3/MinIO。换 S3 只需替换 `packages/domain/src/bundles.ts` 的存储层                                                                                                                                                                                                                                |
| CSV / XLSX 适配器                                   | **已完成** | 22 个单元测试 + 6 个集成测试（经真实导出端点往返），见 §1.19                                                                                                                                                                                                                                                                                                                            |
| Git/GitHub App、PR 检查                             | **未实现** | 规格 §14 第二阶段                                                                                                                                                                                                                                                                                                                                                                       |
| 发布快照导出为实际文件包                            | **已完成** | 确定性 zip（含 manifest 与逐文件摘要），见 §1.23                                                                                                                                                                                                                                                                                                                                        |
| Webhook 事件推送                                    | **已完成** | HMAC 签名投递 + 重试 + 投递日志，见 §1.20；游标拉取仍然保留                                                                                                                                                                                                                                                                                                                             |
| 多组织切换 UI                                       | **已完成** | 顶栏用户菜单里切换（仅在属于多个组织时出现），切换后整页重载；登录时可指定组织并记住上次                                                                                                                                                                                                                                                                                                |
| 用户管理（建号 / 角色 / 项目角色）                  | **已完成** | 无邀请、无自助注册：管理员在 `/settings/members` 直接建号（邮箱+姓名+初始密码+角色）、改组织角色、分配项目角色与语言范围、重置密码、移出组织。API 与守卫见 §1.14                                                                                                                                                                                                                        |
| 会话列表 / 远程登出                                 | **未实现** | 没有 `UserSession` 表，改密码不会注销其他设备，也无法查看「我在哪些设备登录过」。要立即切断访问只能靠暂停账号（见 §1.18）                                                                                                                                                                                                                                                               |
| 前端单元测试                                        | **未实现** | 仓库里没有 Playwright / RTL 用例，也没有进 CI 的浏览器测试。人工验证用无头 Chrome（CDP）脚本，判定标准是「页面出现真实数据且无错误提示」，不是 HTTP 200——后者在 API 全挂时依然成立，本文件 §1.10 就是这么被骗过一次的                                                                                                                                                                   |
| Docker 镜像与整套 compose 栈                        | **已完成** | `docker compose up -d --build` 起全套（postgres / redis / api / worker / mcp-remote / web）。无头 Chrome 实测 24/24：登录后首页、9 条路由与两张项目详情页都渲染出真实数据（不是只 HTTP 200），`/mcp`「客户端配置」三个片段可渲染可复制，桌面与 390px 均无横向溢出；Remote MCP 用 SDK 客户端握手 15 个工具，本地文件类工具未暴露。**过程中发现并修掉两个只在容器里出现的缺陷，见 §1.10** |
| i18n Adapter：JSON 数组/ICU AST                     | 部分       | ICU 复数以字符串形式保存，非 AST 级编辑                                                                                                                                                                                                                                                                                                                                                 |
| `file_hash` 级别的映射变更检测                      | **已完成** | 映射变化现在产生 `FILE_MAPPING_CHANGED` 冲突，见 §1.21                                                                                                                                                                                                                                                                                                                                  |
| `organizations` / `users` / `review_actions` 的 RLS | **已完成** | 三张表都已启用行级策略；无组织上下文时返回 0 行，跨租户不可见。见 §1.24                                                                                                                                                                                                                                                                                                                 |

## 3. 已知风险与设计取舍

1. **`include_drafts=true` 可回写草稿**：这是规格允许的显式路径（§3.3 step 8），但会覆盖已审核文案。
   apply 计划会返回 `riskWarning`，UI/CLI 需展示。建议生产默认关闭该能力（可加组织策略开关）。
2. **Prisma + RLS 的交互**：`TenantPrisma` 用 `$transaction` 包裹并 `SET LOCAL`，每请求一次额外事务。
   长事务下性能会下降；当前用 cursor 分页与批量上限控制。
3. **登录/Token 校验使用特权路径**：这是 RLS 的必要例外，依赖"token hash / email 唯一"
   作为访问控制。代码中已集中到 `withoutTenantScope`，并以 `set_config(..., true)` 限制在事务内。
4. **冲突只在 preview/push 时产生**：平台侧改动本身不会主动探测本地状态（平台无法访问本地）。
   因此"平台单方改动"在本地执行 preview 前一直处于"待拉取"状态，而非冲突。
5. **`APPLY_REJECTED_STALE_PREVIEW` 是整计划拒绝**：一条条目变脏会阻断整个计划，需要重新
   preview。这是有意选择的保守行为，代价是频繁编辑的仓库需要多次预览。
6. **JSON 原地补丁的边界**：仅支持字符串值与复数对象；数值/布尔值补丁会抛
   `UNSUPPORTED_FORMAT`（翻译文件不应承载非字符串值）。
7. **`.stringsdict` 不支持新建 Key**：结构复杂，要求先在目录中创建条目，补丁只改数量分支。
8. ~~**Web 端 Token 存在 localStorage**~~ **已修复**：浏览器改用 HttpOnly 会话 Cookie +
   双提交 CSRF Token，`localStorage` 不再保存凭据；CLI/MCP 仍用 Bearer，两条路径解析到同一个 actor。
9. **AI Provider 默认离线启发式**：不会真正翻译，只做术语替换；配置 `ANTHROPIC_API_KEY`
   才会调用真实模型。AI 输出始终为草稿。
10. **单仓多语言文件同名 Key 冲突**：扫描阶段检测并报 `DUPLICATE_KEY`，但只在同一
    platform+namespace+locale 内判定；跨 namespace 同名 Key 视为不同 Key（符合唯一键设计）。

## 4. 实际执行的验证命令与结果

```bash
pnpm -r build                     # 全部 packages + apps 编译通过
pnpm --filter @localehub/web exec next build   # 15 条路由构建成功
pnpm -r typecheck                              # 16 个 workspace 项目全部通过
pnpm test                                      # 181 unit tests passed（OpenAPI 一致性 7、CSV/XLSX 22、Webhook 14、发布包 9）
pnpm test:integration                          # 104 integration tests passed（含 6 个 RLS 直连验证、6 个仓库初始化）
node apps/e2e-demo/dist/run-demo.js            # ALL ACCEPTANCE CHECKS PASSED（A–E）
docker compose config                          # valid
docker compose -f compose.yaml -f compose.production.yaml config   # valid
docker compose up -d --build                   # 整套栈起来，5 个服务健康
docker compose exec -T web node -e "…routes-manifest…"   # 转发目标 = http://api:3001/api/v1
curl -b cookie http://localhost:3000/api/v1/projects    # 200，走 web 容器转发
docker run --network host … localehub-api:test # health=ok, login ok, /mcp/tools 返回 15 个工具（无 local 段）
docker build -f docker/web.Dockerfile .        # 成功（localehub-web:test）
pnpm exec eslint . --max-warnings 0            # 0 error / 0 warning
node apps/e2e-demo/dist/run-demo.js            # 连续两次运行均 ALL ACCEPTANCE CHECKS PASSED
psql -U localehub_app …                        # 验证 RLS：无 org 上下文 0 行；跨租户写入被拒绝
curl /api/v1/health                            # {"status":"ok","checks":{"database":true}}
curl -o /dev/null -w %{http_code} /login 等     # 8 个页面均 200
curl /api/v1/mcp/tools | jq '.data \| keys'    # ["prompts","remote","remoteUrl","resources","skillDelivery","snippets"]，无 local
curl /api/v1/openapi.json | jq '.paths \| length'  # 68 条路径 / 81 个操作；不带信封（@RawResponse）
pnpm --filter @localehub/api openapi             # 重新生成 docs/openapi.json（提交进仓库，测试逐字节比对）
node apps/cli/dist/bin.js mcp-config           # 向平台问自己的地址，输出单条 localehub-remote 配置
cd .demo-workspace && node …/bin.js info|scan|sync preview   # 本地链路走通（scan 2 文件 / 6 条目）
POST /organization/members (READONLY)          # 无 token 管理成员的越权尝试 → 403（§1.15 修复前后各跑一次）
无头 Chrome 驱动 /settings/members             # 建号对话框真实提交 → 表格出现新成员 → 该账号用所填密码登录成功
```

## 5. 建议的后续优先级

1. **为 `users` / `organizations` / `review_actions` 补 RLS 或收敛访问**。前两张表是全局面级数据、
   没有 `organization_id`；第三条通过 `review_tasks` 关联租户。可选做法：`users` 只允许
   `id IN (SELECT user_id FROM memberships WHERE organization_id = current_organization_id())`，
   或在应用层把读取入口收敛到单一特权函数并加审计。需要先确定「一个用户属于多个组织」时的可见性语义。
2. 由 OpenAPI 文档生成 `api-client` 的方法与类型（当前仅路径漂移有测试守住）。
3. Skills 隔离执行器（独立容器、无网络、非 root）。
4. CSV/XLSX 适配器与对象存储导入导出。
5. GitHub/GitLab App + PR 检查（`localehub scan / sync preview --direction=push / qa --changed-only`）。
6. 前端 E2E（Playwright）覆盖翻译编辑器与冲突处理的关键交互。

---

### 1.35 翻译编辑器：界面草图详情页（本轮）

用户要求：「翻译编辑器可以加一个按钮打开一个 90% 的详情页，左边是 mcp 调用端上传的生成界面草稿图，
界面草稿图要根据调用端的源语言在当前界面位置标记出来，右边是译文，点击标记会去到对应的翻译互相联动」。

**缺的不是词，是位置。** `checkout.pay_now` 到了译者手上是三个词，没有按钮：key 的身份是
`(项目, platform, namespace, key)`，里面没有任何位置信息。所以新增的是「Key 说不出的那一半」：
一张界面草图 + 每个 key 的文字在图上的位置。

**上传端（Remote MCP 第 19 个工具 `upload_screen_mockup`，scope `sync.push`，进审计）**

- 入参：屏幕名、端、草图语言、图片（base64）、标记数组。图片支持 SVG / PNG / JPEG。
- **坐标是相对图片的比例 0~1，不是像素**——同一张图在 400px 弹窗和全屏下必须落在同一处，换 2x 导出
  也不该让标记作废。传像素会被拒绝，错误信息说明该传什么（调用端最容易犯的错）。
- **格式由字节决定**：`detectImageType` 读魔数，声明的 `mime_type` 只作为「调用方声称」记进审计。
  WebP 明确不收——平台读不出它的像素尺寸，就不敢把「大小」交给调用端的一面之词。
- **像素尺寸真的读**（PNG 的 IHDR、JPEG 的 SOF 逐段扫描、SVG 的 viewBox）：字节数不等于画得出来，
  200 KB 的纯色 PNG 可以是 30000×30000，上限 8192 是按名字拒绝而不是让浏览器去画。
- **SVG 里的 `<script>` / 事件属性 / `<foreignObject>` / `xml-stylesheet` / `<!ENTITY>` 一律拒绝**，
  并列出要删的东西。另外两层：图片以 `image/svg+xml` 返回时带 `sandbox` 的 CSP 与 `nosniff`，
  编辑器一律用 `<img>` 渲染——三层各自独立。
- **指向尚未导入的 key 不失败**：标记照存，返回值 `markers.unmatched` 报告，编辑器显示「平台没有这个
   Key」。草图常画在导入之前，要求 key 先存在等于把顺序弄反。
- 同名同端再传 = 整体替换（图与标记一起换）；`replace: false` 则报 `CONFLICT`。

**读取端**：`GET /projects/:id/mockups`（`?key=` 时每行附 `containsKey`，回答「我选中的这条在哪个
界面上」）、`GET …/:mockupId?locale=`（标记 join 源文与该语言的译文，按阅读顺序排序）、
`GET …/:mockupId/image`（字节 + ETag + 304 + 三层安全头）。上传/删除同路由也开了（DEVELOPER），
与 MCP 走**同一个** `@localehub/domain` 函数——一个上传在两个入口上一个有效一个无效是不可能的。

**编辑器**：标题栏「界面草图」按钮打开 90% 视口的详情页。左边是按标记框住的草图，右边是该语言的同一批
条目，**双向联动**：点标记 → 右侧滚动并高亮该条；点条目 → 标记点亮。编号是两侧的暗号。琥珀色编号表示
「草图有字、译文还空着」，所以一张图扫下来就知道哪几处没翻。有 `entryId` 的条目可以「在编辑器中打开」
（关掉弹窗并选中该条——详情面板是按 id 取的，所以不在当前页也能打开）。多屏时按名字切换。

实测：**13 个新集成测试**（MCP 上传 → REST 读取 → 图片字节与安全头 → 标记 join → `containsKey` →
替换语义 → CONFLICT → SVG 拒绝 → 像素坐标拒绝 → REST 平权 → 大请求体 → 审计 → scope 强制 →
路径里的 projectId 与行不一致时 404）、**31 个新单元测试**（几何规则、魔数与尺寸解析、SVG 危险构造、
解码与上限）。全量：257 单元 + 150 集成测试通过。

**浏览器实测（无头 Chrome，容器栈 :3000）**：弹窗 1296×810（1440×900 视口的 90%），375×812 的草图
渲染为 323×699，**7 个标记 7 个都落在图内**，右侧 7 行；点第 3 个标记 → 对应行滚入视野并高亮（`rowFound`
与 `rowHighlighted` 均为 true），点最后一行 → 对应标记点亮（`markerFound` / `markerHighlighted` 均为
true）；390×844 窄屏下弹窗 367×776、`scrollWidth == clientWidth`（无横向溢出）；控制台无 error、无异常。
截图：`/tmp/mockup-dialog.png`、`/tmp/mockup-dialog-mobile.png`。

**其中三个缺陷只有浏览器看得见**——两端的单元/集成测试全绿，因为出问题的是「浏览器拿到的东西」：

| 缺陷 | 症状 | 原因与修复 |
| --- | --- | --- |
| `imagePath` 多一层前缀 | 弹窗左半边显示「草图加载失败」 | 服务端返回 `/api/v1/projects/...`，而浏览器端的 `api.ts` 会自己再拼一次 `/api/v1`，请求打到 `/api/v1/api/v1/...` 而 404。改成返回相对路径（与其它接口里的 URL 一致），并加了一条集成断言：`imagePath` 不以 `/api/v1` 开头 |
| 草图被压成 2×2 像素 | 七个标记全叠在一个点上 | 百分比标记的遮罩层必须**就是**那张图。原写法用 `inline-block` 包住 `<img>` 再给它 `max-w-full`——百分比 max-width 对「由内容决定宽度」的父元素求解，浏览器把这个循环解成 0。改为用服务端读出的尺寸给遮罩层设 `aspect-ratio` + `height: 100%` + `max-w-full`，`<img>` 用 `absolute inset-0 h-full w-full` 填满它；尺寸未知时回退到旧分支 |
| 点击毫无反应 | 点标记、点行都不动，看起来像「联动没做」 | 两侧约定的身份串用 `\u0000` 分隔后写进 `data-marker`，而 `CSS.escape` 会把 NUL 替换成 U+FFFD，`querySelector` 因此永远匹配不到元素。分隔符换成 namespace 不可能出现的 `\u001f` |

第三条尤其值得留档：集成测试断言了标记 join 的顺序与内容，全绿；断掉的是**组件读回自己写下的属性**
这一步，只有真的去点一下才会暴露。

**代码评审又找出 16 个问题，全部已修**（其中 4 个在运行中的栈上被复现）。按严重程度：

| 问题 | 症状（已验证） | 修复 |
| --- | --- | --- |
| **上传不校验项目归属**（最严重） | 组织 A 的成员用组织 B 的项目 id 上传：行写进去了（A 的 organization_id + B 的 project_id）。RLS 让 B 看不见这一行，但 `(project_id, platform, name)` 唯一索引**不按租户隔离**——A 于是永久占住 B 的一个屏幕名，B 自己传同名草图得到 `CONFLICT`。未知项目 id 则撞外键，返回 500 并带上 Prisma 原文 | `upsertScreenMockup` 在事务内先按租户查项目，查不到即 404。REST 与 MCP 共用这一个函数，所以两个入口一起修好 |
| **SVG 的 `<svg:script>` 绕过检查** | 黑名单只认无前缀的 `<script>`；`<svg:script>alert(1)</svg:script>` 通过并入库，作为文档打开时脚本真的执行了 | 元素名允许命名空间前缀（`<svg:script>`、`<x:foreignObject>` …）。另：SVG 不再走 `blob:` URL（`blob:` 是同源可导航文档，「在新标签页打开图片」会在本应用源上执行文件里的脚本，而 API 的 sandbox CSP 只管 API 自己的 URL）——SVG 改为 `data:` URL，PNG/JPEG 仍用 object URL |
| **横屏草图被拉伸** | `height:100%` + `aspect-ratio` + `max-w-full`：宽度被 clamp 时高度仍是确定值，1440×900 的草图渲染成 655×778（比例 0.84，应为 1.60）。竖屏恰好正确，所以上次只测竖屏没发现 | 左栏设为 size container，盒子宽 `min(100%, calc(100cqh * 比例))` —— 两个方向同时受限，比例永远成立 |
| **`stroke-width` 被当成图片宽度** | `\bwidth=` 中 `\b` 把连字符当词边界，`<svg stroke-width="2" width="375">` 读成 2×375；根元素没写尺寸时会退而取第一个子元素的尺寸（实测 327×48）。这个错误尺寸正是编辑器用来算 `aspect-ratio` 的输入 | 只在根 `<svg>` 标签内解析，且用 `(?<![\w-])width` 排除 `stroke-width`；子元素一律不看 |
| **全局 4 MB 请求体** | 为了让草图能传上去，之前把 JSON 解析上限对整个应用抬到 4 MB：`/auth/login` 等路由在 AuthGuard 与限流器之前就先缓冲解析 4 MB；解析失败还因为注册在 CORS 之前而**没有 CORS 头**（跨域部署下浏览器只报不透明的网络错误），超限返回 500 而非 413 | 大解析器只挂 `/projects/:projectId/mockups` 这一条路由，注册在 CORS 之后；其余路由保持 100 kB。手工挂载的中间件绕过 Nest 异常过滤器，所以超限/格式错误在这里直接按统一信封回 413 |
| **`?key=` 只比 key 名** | Key 的身份是 `(namespace, key)`，只比名字时「同名但属于另一个 namespace」的屏幕会回答 `containsKey: true`，编辑器于是打开错误的屏幕并高亮错误的标记 | 列表接口接受 `namespace` 并按其匹配；编辑器同时传 `key` 与 `namespace`；前端聚焦标记也按身份比对 |
| **重新打开对话框保留上一次的屏幕** | 选择逻辑「当前屏幕还在列表里就留着」，于是第二次打开时虽然带着新的 `?key=` 重新问了，却仍停在上次的屏幕上 | 每次打开都重置所选屏幕，让 `containsKey` 的答案重新决定 |
| **`<img>` 后按方向键会改动对话框背后的编辑器** | 焦点在标记按钮上时，窗口级 ↑/↓ 监听仍会切换选中的条目并 `preventDefault()`，弹窗里的按键因此失效 | 对话框打开时该监听直接返回 |
| **SVG 以注释/DOCTYPE 开头时被拒** | 导出工具常在根元素前写 `<!-- … -->` 或 `<!DOCTYPE svg …>`，两者都被判为「无法识别的图片，WebP 不支持」 | 允许根元素前的合法 XML 序言（声明/DOCTYPE/注释/空白），其余仍拒绝 |
| **`data:` URL 带参数时被拒** | `data:image/svg+xml;charset=utf-8;base64,…` 报「不是合法 base64」——把参数当成了载荷 | 参数段允许出现 |
| **审计与校验在两个入口不一致** | `detectedMimeType` / `declaredMimeType` 只有 MCP 路径记；REST 的 `mimeType` 接受任意字符串，同一个 `image/jpg` 在 MCP 被拒、在 REST 被收下 | REST 审计补同样两个字段；`mimeType` 收敛为三种真实格式 |
| **按名字替换的竞态** | 先查后写：两个同名上传并发时都读到「不存在」，输的那个撞唯一索引并返回 `CONFLICT`，把一次合法的 `replace: true` 报成冲突 | 写入改为按唯一索引 `upsert`，由索引仲裁；`replace: false` 的拒绝语义仍由前置查询给出 |
| **304 也要读整张图** | 图片响应是 `no-cache` + ETag，所以每次打开都在重新校验；即使命中 304，也先把最多 2 MB 的 BYTEA 读进内存再丢掉 | 先只取 `contentHash`/`mimeType` 比对 ETag，未命中才取字节；`Buffer.from(image.buffer, …)` 不再复制 |
| **`upload_screen_mockup` 与「写操作默认 dry run」矛盾** | 服务端 instructions 对所有客户端说「所有写操作默认 dry run」，而它没有 dry run 且 `replace` 默认 true，会把已有草图与标记一起覆盖 | instructions 明确写出这一例外（别拿它试），工具声明 `destructiveHint: true` |
| **`/mcp` 教程页数字过期** | 页面写「十八个工具里有十六个」，而注册表与文档都是 19 / 17 | 改为十九 / 十七 |

四个在运行栈上复现的问题（跨租户写入、`<svg:script>`、横屏拉伸、`stroke-width`）现在都有回归测试：契约层的检测与尺寸、域层的租户校验与 `data:` URL、以及集成层的「外组织项目 404 且没写任何行」「不存在的项目 id 返回 404 而不是 500」「5 MB 请求体得到 413 与统一信封」「`?key=&namespace=` 区分同名不同 namespace」。

**修这些修复时又踩了一个自己造的坑，值得记下**：把大请求体解析器按路由挂上去（`app.use('/api/v1/projects/:projectId/mockups', json({limit:'4mb'}))`）之后，`/auth/login` 开始对正确密码返回 422 `email: Required`。原因是 Nest 用它**自己的**解析器时靠「栈里有没有一个叫 `jsonParser` 的中间件」来判断要不要注册全局限定器（`ExpressAdapter.isMiddlewareApplied`），而 `json({…})` 返回的函数正好就叫 `jsonParser`——Nest 于是认为「已经装过了」，全应用再没有任何 body 解析。症状不止一处：登录体解析不到，限流器的「按 (IP, 账号)」桶也退化成所有登录共用一个 `unknown` 桶，于是连续跑集成测试必然 429。改法是把解析器包一层、给一个 Nest 不认识的名字（`mockupBodyParser`），Nest 就会照常注册自己的 100 kB 全局解析器，而 body-parser 见到已解析的请求会跳过，两条路径互不干扰。实测四条：小草图 201、400 kB 草图 201（旧的 100 kB 默认会拒）、5 MB 413 且是统一信封、`/auth/login` 上传 150 kB 仍被 100 kB 默认拒。

横屏修复也在浏览器里量过：1440×900 的草图，盒子 798×499（比例 1.600，与图片一致；修复前是 0.84），375×812 的仍是 364×789（0.462），两者都是 7/7 标记落在图内、右侧 7 行；点标记↔点条目的双向联动仍为 true，窄屏无横向溢出，控制台无异常。

**评审复查后又修的 7 处**（连同上面那批一起进了同一个提交）：

| 问题 | 症状 | 修复 |
| --- | --- | --- |
| 「平台没有这个 Key」判断错了依据 | 用 `source === null` 当「Key 不存在」，而只导入了非源语言的 Key 有 Key 行、有译文、只是没有 SourceVersion——编辑器于是对着一条真译文说「平台没有这个 Key」 | 改看 `platform === null`：那才是 domain 里「项目里没有这个 Key」的信号 |
| 归档的 Key 仍算匹配 | 两个 marker→key 查询都没过滤 `archivedAt`，而库里其它每一处都过滤（sync.ts、translations.service.ts、content/platform controller、MCP 服务端）。已经归档（仓库里已删）的 Key 会被当成现存，`matchedKeys` 也把它算进去 | 两处都加 `archivedAt: null` |
| 读路径不规范化 locale | 写入侧规范化（`zh-hans` → `zh-CN`），读取侧直接拿 `?locale=` 去比：`EN-US` 匹配不到任何条目，于是每个标记都显示「该语言还没有条目」——200 的错误答案 | 读路径同样规范化，非法标签仍原样传下去由校验层报错 |
| `replace: false` 的并发语义 | 「先查再写」：两个并发请求都读到「不存在」，第二个于是走了 update 分支，把第一次的上传覆盖掉，还返回 `replaced: false` | `replace: false` 走 `create`，由唯一索引原子裁决（输的一方 P2002 → 409）；`replace: true` 走 `upsert` |
| 草图语言与源语言不同也报「与平台原文不一致」 | 用 `ja-JP` 画的草图，每个标记都会被标成与 en-US 原文不一致 | 只在 `mockup.locale === sourceLocale` 时才比较文本 |
| 304 不带 ETag 与 Cache-Control | 按 RFC 9110 §15.4.5，304 也要说明自己在重新验证什么；缺了这两个头，客户端/代理没有可存的元数据，可能把条目当成启发式可缓存——与 200 说的正好相反 | 304 分支补上 ETag 与 `private, no-cache` |
| 「所有写操作默认 dry run」是错的 | 实际只有 `import_translations`（`confirm`）与 `mark_applied`（`dry_run`）能预演；`review_translation_entries`、`update_translation_draft` 等一调即写，跟着这句话去「演练」就会真的落库。`docs/MCP.md` 有同样一句 | 两处都改成点名哪两个工具能预演、其余的调用即写 |

顺带把评审提到的一个小口子补了：413 响应原先没有 `requestId`（手工挂载的解析器跑在 request-context 中间件之前），它是全 API 唯一无法与日志对照的错误；现在沿用调用方的 `x-request-id`（没有就生成一个）并同时写回响应头。

**局域网登录（用户报的问题，已单独查明并修复）**：别人用 `http://192.168.x.x:3000` 打不开，是两道独立的门叠加，而症状都只是「登录没反应」：

1. `Origin` 不在 `CORS_ORIGINS`（默认只有 `http://localhost:3000`）→ 登录请求直接 403
   `CSRF_VERIFICATION_FAILED`。这是配置，需要把局域网地址加进去。
2. 会话 Cookie 带 `Secure`，而别人访问的是明文 HTTP → **浏览器静默丢弃 Cookie**：登录返回 201，
   但之后仍是未登录。Chrome 把 `http://localhost` 当成安全上下文，所以只有开发机不受影响——
   这正是「本机好使、别人登不进去」的分界。修复：`Secure` 跟随 `ALLOW_INSECURE_HTTP`，开发栈
   （明文）不设、生产（TLS）照常设。

实测（无头 Chrome，从 `http://192.168.0.101:3000` 登录）：修复前登录 201 但 cookie 存储为空、
后续请求 401；修复后 `localehub_session` / `localehub_csrf` 两个 cookie 都落库（`secure=false`），
后续 `GET /projects` 返回 200。同时把「开给局域网」的写法与代价写进了 `env.example`、
`docs/DEPLOYMENT.md` 与 `compose.yaml`（明文下 cookie 不设 Secure，只适合内网；长期对外应前置 TLS）。

另外把 `scripts/append-rls.py` 的租户表清单补上 `screen_mockups` / `screen_mockup_markers`——
迁移里手写了 RLS 策略（库里两条 `tenant_isolation` 已生效），但生成器不认识这两张表，重新生成时
会把它们漏掉。

**第三轮评审的四个候选也都修了**（都是读代码确认、两个有实测）：

- **`replace: true` 的 upsert 其实不是原子的**。Prisma 的 `upsert` 一旦 `update` 分支里带嵌套关系
  （`markers: { deleteMany: {} }`）就会退化成「先 SELECT 再 INSERT/UPDATE」，正好重新打开了它本来
  要关的竞态。改成一条原生 `INSERT … ON CONFLICT (project_id, platform, name) DO UPDATE`，标记的
  清空改为独立语句。实测：同名连续两次 `replace: true` 保持同一个 id、标记数正确跟随；**四个并发**
  的 `replace: true` 全部 201，库里仍只有一行、一套标记。
- **根标签扫描会被属性值里的 `>` 截断**。`<svg data-note="a > b" width="20000">` 用 `[^>]*` 只能
  读到 `data-note`，尺寸读不到 → `assertMockupDimensions` 跳过，8192 的上限被绕过。改成按引号状态
  逐字符扫描，并加了「带 `>` 的属性值下尺寸仍被读到」的回归测试。
- **两个 SVG 读取器用的切片长度不同**（4096 / 8192）：序言较长的合法草图，识别层认作图片、测量层
  却读不到尺寸。统一成一个常量。
- **两个上限互相矛盾**：2 MB 图片 base64 后约 2.7 MB，再加 400 个标记的 `text` 可以超过 4 MB 的请求
  上限，而 413 既不说是哪个上限也不说怎么改。现在有一个共享的 `MAX_MOCKUP_REQUEST_BYTES`，413 的
  文案直接说明「图片最多 2 MB、与标记描述共用 4 MB」，并在 `details` 里给出两个数值。

顺带修掉的一个「不是缺陷但会挡住它」的问题：API 的 JSON 请求体默认上限是 Express 的 100 kB，而一张
草图经 base64 之后轻易超过它——`POST /projects/:id/mockups` 会以 413 拒掉一张正常的线框图。已在
`main.ts` 提到 4 MB，与 MCP 传输层的上限一致，并加了一条 180 kB 载荷的回归测试。

**顺带发现、但这次没有修的问题（重要）**：`scanEntrySchema` 里没有 `platform` 字段，`toScanEntry`
（CLI）与 MCP 导入都没有把条目的 platform 传上来，`parseScanEntries` 一律回落到 `web`。实测数据库：
**19,436 条 key 全部是 `web`**；`project_platforms` 为 `{ios, web}` 的「高研院iOS」项目，其 2,792 条
key 的 platform 也全是 `web`，一条 `ios` 都没有。也就是说：**调用方填的 platform 从来没有到达 key 的
身份上**，而 `docs/MCP.md` 与导入指南都写着「platform 是 key 身份的一部分，必须与仓库配置一致」。
CLI 的往返仍然是自洽的（读与写两边都按 `web` 走），所以此前没有任何验收项发现它。

修它会让下一次全量推送把已有的 `web` key 全部判成「本地已删除」并另建一套 `ios` key——对任何已同步过的
项目都是一次数据迁移（需要先按 `repository_file_mappings` 回填已有 key 的 platform），不属于本次改动
范围，所以没有一并改。**（这个缺陷已在 §1.39 修掉并完成回填：回填的证据取自扫描记录本身，比
`repository_file_mappings` 更准——后者只覆盖有连接的仓库。）****本次的标记匹配因此按 key + namespace 做，不按端**：同名 key 存在于多个端时优先
取屏幕自己的端，取到别的端会在编辑器里直接标出来（「Key 在 web，不在 ios」），而不是假装没看见。
详见 `docs/MCP.md` §2.10。

### 1.36 界面草图：用代码生成整页的标记，而不是手量坐标

用户要求：「需要草稿对应那个页面的所有UI，用代码生成标记对应页面，然后提交到后端」。

手画一张 SVG、再逐个把坐标量出来，是这套流程里最容易错也最容易过时的一步：页面改一句文案，标好的
位置就全废了；漏掉一个按钮，就少一个标记。而**页面的代码本来就说清了它有哪些元素、上面有哪些字**。

**新增的是第二种输入：描述而不是图片。** `upload_screen_mockup` 与 `POST /projects/:id/mockups`
现在都接受 `ui`——一棵元素树（`screen` / `section` / `card` / `row` / `text` / `button` / `input` /
`image` / `icon` / `badge` / `divider`）。平台按树排版、画成 SVG、并**在同一次遍历里算出每个标记的
位置与大小**。图片与坐标来自同一次排版，所以不可能对不上，这正是手量坐标做不到的。渲染器在
`packages/contracts/src/ui-spec.ts`：纯函数、浏览器安全（CLI 用、API 也用），同一份描述永远画出
同一张图。文本量宽按 CJK 全宽 / 拉丁半宽估算，行内换行、grid 列数、`flex` 方向都参与排版。

**本地生成器**：`localehub mockup --page <file>`（`packages/local-sync/src/ui-extract.ts`）。
它读 JSX/TSX 或 HTML——不编译，只做容错扫描——把元素结构变成树、把界面文案变成标记：

```bash
localehub mockup --page src/app/projects/page.tsx --name 项目列表            # 预览：写 .localehub/mockups/*.svg
localehub mockup --page src/app/projects/page.tsx --name 项目列表 --confirm   # 提交
```

`t('key')` / `$t('key')` / `i18nKey` 等调用取真实 key；硬编码文案（这个仓库的产品就是这样）以文案
本身为 key；`--keys` 可覆盖映射，`--namespace` 指定字符串表（根节点上的 namespace 整棵树继承）。

**质量是被测出来的，不是声明出来的**：单元测试直接读本仓库 7 个真实页面（`projects/page.tsx`、
`mcp/page.tsx`、`translations/page.tsx` 等），断言「提取到的每个字符串都在排版结果里有标记」。
这一步逼出了六个真实缺陷，全部修掉并各有回归测试：`useState<Foo>` 被当成标签（整页解析成空）、
函数体的 `{` 被当成 JSX 表达式（吞掉整个组件）、`.map()` 里的 JSX 被整段跳过（列表画成空框）、
`<Field>` 因名字含 field 被当成 input（表单标签全丢）、`flex-1` 被当成 `display:flex`（子元素叠在
一起）、中文里被表达式分开的句子多出空格（`已选 项` → `已选项`）。

**实测**：真实浏览器里，`localehub mockup --page` → 提交 → 翻译编辑器的「界面草图」，10 个标记
10 个落在图内、双向联动正常；MCP 客户端用 `ui` 调用同一工具，5 个标记 4 个对上 Key、1 个如实报
unmatched。全量 308 单元 + 157 集成测试通过。

### 1.37 项目设置页：删除项目

用户要求：「项目设置页面要提供一个删除项目按钮」。删除接口早就有了（§1.14 为清理演示数据加的），
但只能在 CLI / curl 里用；而且 `confirmName` 是**可选**的——不传就直接删，这让「输入项目名确认」这个
设计形同虚设。

**接口侧**：`confirmName` 改为必填（缺参数 422 并说明要传什么，名字不符 422），间隔两种拒绝各有一条
集成测试；`GET /projects/:projectId` 的响应用 `highestRole`（与服务端守卫同一套排序）给出调用者的
**有效角色**，前端据此决定是否显示入口——不会「点了被拒」，也不会「有权限却看不到」。

**页面侧**：设置页底部一个红色危险区（说明会删掉什么、以及仓库文件不受影响），按钮打开确认对话框：
列出后果、要求**逐字输入项目名**（不符则永久删除按钮保持禁用），成功后提示并跳回项目列表。用
`Button` 而不是 `AlertDialogAction` ——后者点击即关闭对话框，一次被拒的删除会把错误信息一起带走。

**实测（无头 Chrome，真实栈）**：新建一个临时项目 → 打开设置页 → 危险区渲染、按钮可用 → 打开对话框
（默认禁用）→ 输入错误名字仍禁用 → 输入正确名字变为可用 → 点击 → 跳转 `/projects`、项目 404、控制台
无错误。用例创建并删除自己的数据，不碰演示项目。

### 1.38 MCP 里的草图教程：教的是「传 ui」，而且照抄就能跑

用户问：「mcp 里有教程让 agent 怎么使用上传代码生成的交互页吗」。查下来是**只有一半**：工具的
`description` 与 `ui` 字段的 `description` 已经改成推荐 `ui`，但 Agent 真正先读到的那几层还在教旧做法——

- `instructions`（客户端在调用任何工具前放进上下文的那段）写着「上传一张界面草图与若干标记……坐标是相对图片
  的比例（0~1），不是像素」，**完全没提 `ui`**；
- `localehub://import-guide` 的 §6 让人「把界面画下来」，示例是 `image_base64` + `markers`；
- 没有任何提示词覆盖这条流程（三个提示词分别是审核、修 QA、导入）。

也就是说：一个 Agent 连上来、读完它能读到的全部内容，会得出「得自己画一张图、自己量坐标」的结论——正是
本轮刚做完的 `ui` 输入要消灭的那一步。工具 schema 教了，教程没教。

**补齐三处，并新增一份教程资源：**

| 层 | 改动 |
| --- | --- |
| `instructions` | 草图那段改成「传 `ui` 即可：平台自己排版、画图，并算出每个标记的坐标，不用你画图，也不用你量坐标」，并给出 CLI 捷径与指南 URI |
| `localehub://screen-sketch-guide`（新增） | 完整教程：调用形状、节点表（11 种 type 分别画成什么、哪些生成标记）、key/namespace 从哪来、两件不可逆的事、上限、以及「用 CLI 从页面源码生成这份描述」 |
| `upload-screen-sketch`（新增提示词） | 六步流程，供人在客户端里一键唤起；和导入提示词一样，把规则指向教程而不是复述，避免两处漂移 |
| `localehub://import-guide` §6 | 收缩成一段指路，避免同一件事有两份权威说明 |
| `/mcp` 教程页 | 日常提示词加一条「把某个页面做成界面草图传上来」，另加一段「让译者看到界面」说明 |

**顺着这条线发现并修掉两个真问题**（都是「照教程做会失败」这一类）：

1. **教程里的示例被工具拒收。** 指南写「`ui` 里只需要 `root`」，而 `uiSpecSchema` 的 `name` 是**必填**——
   第一个照抄示例的调用方拿到的是 `Required at ui.name`。平台自己也从不读 `spec.name`（屏幕的身份来自
   调用参数），所以这是纯粹的陷阱：`ui` 里要么被迫编第二个名字，要么两个名字写岔了也无人告知哪个生效。
   现在 `ui.name` / `ui.platform` / `ui.locale` 都是可选且被忽略（CLI 本地渲染仍会传）。新增回归测试：
   **把教程里的那段 JSON 抠出来、用工具 schema 校验并真的渲染一遍**——教程里的例子不可执行的 bug
   只有这种测试能挡住。
2. **调用参数里的 `platform` 到不了渲染器。** 画布尺寸取的是 `ui.platform`，而指南让人别写 `ui.platform`，
   于是 iOS 屏幕被画在 1280×800 的 web 画布上。`resolveMockupInput` 现在多收一个 `platform` 作为
   画布回退（`ui.platform` 显式写了就仍以它为准），MCP 工具与 REST 两个入口都传。单元测试钉住
   `ios → 390×844`、`ui.platform=android` 覆盖调用参数。

**实测（真实容器栈 + 真实 MCP 客户端）**：`scripts/check-mcp-sketch-guide.mjs`（新增，可重复执行、自建
临时项目与 Token 并自行清理）从容器里的 MCP 读 `instructions` / 资源 / 提示词 / 工具描述，再与
`GET /mcp/tools` 对照，五处都对得上；把指南 §1 的示例原样传进 `upload_screen_mockup`，得到 4 个标记、4 个如实报
`KEY_NOT_IMPORTED`、画布 390×844、图能取回且其中没有可执行内容（临时项目用完即删）。浏览器里
`/mcp` 页渲染出新示例与说明，「Resources & Prompts」页签列出新资源与新提示词，无控制台错误。
验证：319 单元 + 162 集成测试通过。

### 1.39 修掉「platform 到不了 key 身份」这个缺陷，并回填存量

用户问「这个问题解决了吗」——问的是 §1.35 结尾记下的那处已知缺陷，答案是**没有，当时故意推迟了**，现在修掉并迁移。

**缺陷本身**：`scanEntrySchema` 里根本没有 `platform` 字段，于是 zod 把调用方传的条目级 platform 直接
剥掉，`parseScanEntries` 一律回落到 `web`。三条链路合起来的效果是：**任何调用方填的 platform 都到不了
key 的身份上**，而 `docs/MCP.md` 与导入指南都写着「platform 是 key 身份的一部分，必须与仓库配置一致」。
实测库里 19,436 条 key 全部是 `web`；`project_platforms` 是 `{ios}` 的「高研院iOS」2,791 条 key 也全是
`web`，一条 `ios` 都没有（Agent 那轮同步报告里标的第 1 点就是它）。

**修法（四处，缺一不可）**：

| 位置 | 改动 |
| --- | --- |
| `scanEntrySchema` | 增加可选 `platform`（条目自带时优先） |
| `recordScan` | 解析 `entry.platform ?? files[fileId].platform ?? 'web'`，并把结果写进存储的 scan JSON——这是唯一同时拿到条目与文件两半的地方，改造只能落在这里 |
| `toScanEntry`（CLI）/ MCP `import_translations` | 显式带上文件的 platform：平台能从 `fileId` 推出来，但一个说清自己意思的载荷不需要别人推理 |
| `expandProjectShape` | 平台列表也考虑条目自带的端，否则「只传条目不传文件」的调用方会在项目没声明的端下建 key |

`parseScanEntries` 里的 `?? 'web'` 保留，但降级为**历史 scan 的兼容回退**（迁移前记录的 scan JSON 里确实
没有 platform，重读不能改变它们的意思）。

**回填**：`scripts/backfill-key-platform.mjs`（新增）。证据不许猜——每条 key 的端从**扫描记录**推：
每个 scan 都存着 `files[].platform`，每个条目都写着它的 `fileId`，两者一拼就是这条 key 当时是从哪个端的
文件里读出来的。含糊的（同名 key 在两种端下都出现过）与无证据的（直接调 API 建的 key）**一律不动**，
只报告。默认 dry-run，`--confirm` 才写，且 key、它所属的 namespace（`namespaces` 按
`(project, platform, name)` 唯一，push 靠它解析 key）、以及 sync baseline（不然迁移后第一次推送会把
已有的 key 当成新的）三者一起搬；搬空的 namespace 行删掉。

第一次跑踩到 Prisma 交互事务的 5 秒上限：2,791 条 key 逐条 update + 8,295 条 baseline 逐条 update
撑爆了预算，中途报 `Transaction already closed`。改成按 (端, namespace, 目标端) 分组的 `updateMany`
并把事务上限提到 300 秒。已提交的项目重跑是幂等的（重新推导后无事可做）。

**实测**：66 个项目有待迁移、合计 **2,888 条 key**（其中 2,791 条是「高研院iOS」）、8,300+ 条 baseline；
回填后全项目复查 **0 条不符**。高研院iOS 现在是 2,791 条 `ios` key、8,295 条 `ios` baseline、一个 `ios`
namespace（空的 `web` 行已删），`platform=web` 查询返回 0 条。

**回归证据有三层**：

1. 新增集成测试 `apps/e2e-demo/src/platform-identity.integration.test.ts`：iOS 文件 → `ios` key；同一批
   再推一次 `pushNew 0 / archiveCandidates 0 / unchanged 2`；同名 key 落在两个端下 → 两条 key、两份值
   互不覆盖；条目自带 platform → 项目端列表扩展且 key 落在该端。
2. 用户 Agent 的推送脚本原样重跑（三语 8,295 条、300/批）：**每批计划 0 项**——修复前每一批都会是
   「300 条新 web key + 300 条待归档」。
3. 从平台读回 3 条 en 条目再扫一次：`unchanged: 3`、`archiveCandidates: 0`。

迁移前的 `translation_keys` / `namespaces` / `sync_baselines` 三张表已整体备份（`pg_dump`，25 MB）。

### 1.40 草图要「看得出是哪个页面」：读页面的颜色与组件，并且能直接收 HTML

用户要求：「要让 agent 通过 mcp 上传带色彩、组件和页面的 html，要有一定还原度，不然看不出是哪个页面，
现在草图效果不太好」。

上一轮的 `ui` 输入解决了「不用量坐标」，但画出来是一套灰阶线框：位置对，页面认不出。这一轮解决的是**像不像**。

**一、颜色与组件外观进入渲染器。** 节点多了 `style`（`color`/`background`/`border`/`borderWidth`/`radius`/
`fontSize`/`fontWeight`/`align`/`paddingX`/`paddingY`/`gap`/`shadow`），颜色是**校验过的**——只接受 `#rgb`、
`#rrggbb`、`#rrggbbaa`、`rgb()`/`rgba()` 与常见颜色名（这些字符串最终落在 SVG 属性里，属性不是放任意文本的地方）。
渲染器按这些属性画：控件用页面自己的色、卡片描边加圆角、`nav` 是一条真顶栏（顶栏横跨整屏，不跟着内容留白）、
`tabs` 是分段控件、文字有字号字重与对齐，按钮的颜色会自动配可读的文字色（`bg-white` 上不会出现白字）。
不写样式的节点回落到「这类元素本该有的样子」，所以一条没用样式的描述也不再是一堆灰框。

**二、样式从页面的源码里读出来**（`packages/contracts/src/ui-style.ts`，新增）：Tailwind 全套调色板与常用工具类
（`bg-*`/`text-*`/`border`/`rounded`/`p*`/`gap`/`shadow`/字号字重/对齐）、inline `style`、以及 `<style>` 块里的
类/标签/`*` 规则与 `:root` 变量（`var(--brand)` 会解析）。层叠只做到「标签 → 类 → inline」，按特异度排序，
够画出页面，也不假装是 CSS 引擎：`hsl()`、`@media`、伪类一律忽略。

**三、`upload_screen_mockup` 与 `POST /projects/:id/mockups` 多收一个 `html`**（与 `ui`、`image_base64` 三选一，
外加 `namespace`）。扫描器因此从 `packages/local-sync` 搬到 `@localehub/contracts`——API 要与 CLI 用同一个读取器，
而 local-sync 那一半（按 workspace 白名单读文件）留在 CLI 侧。平台**只解析，不渲染、不执行、不联网**：
这是这一轮刻意不做的取舍，理由见下面「没有做的是什么」。

**顺着做的时候发现并修掉的三个真缺陷**（都是「照页面抄会丢东西」这一类）：

1. **单个英文单词的文案被整个丢掉。** `looksLikeUiText` 里那条 `^[.#]?[a-z0-9-_:...]+$`（本意是排除类名、id、
   路径）在 `i` 标志下把所有「没有空格的一串字符」都判成了代码——于是 `Checkout`、`Cancel`、`Settings` 这类最常见的
   英文标签全部消失，页面标题只有一个词的页面会留下一个没有标记的空洞。现在改为：带标点（`#`、`.`、`/`、`_`、`:`）
   的判为 id/类/路径，**全小写且带连字符或数字**的判为工具类（`text-sm`、`bg-blue-600`、`flex-1`），其余一律当文案。
2. **`{…}` 表达式被当成文案。** `aria-label={label}` 里的 `label` 是变量名，之前会被读成一条字符串——修掉第 1 条之后
   它立刻冒了出来（页面里多出一个叫 `label` 的标记）。属性值的来源现在分得清：字面量是文案，表达式不是；
   `className={cx(…)}`、`style={styles.card}` 同理不再被当成样式。
3. **`<script>` 与 `<style>` 的内容被当成文案**，页面里一段内联脚本会产生一条文字是 `const x = 1` 的标记，
   一段样式表会产生一堆 CSS 标记。现在解析前先剥掉脚本与注释，样式只用来读颜色。

**四、顺手抓到的一个更严重的渲染缺陷：容器盖住了自己的内容。** 排版的记录顺序对容器是**后序**（卡片的高度要等子元素量完
才知道），渲染器照这个顺序画，于是卡片的背景矩形盖在它内部的文字与按钮之上——**画出来是一张空卡片**，而每个标记的位置
依然正确。此前所有检查都只看几何（标记在不在图内、有没有越界），所以这个缺陷一路活到了今天：在浏览器里把草图当像素
读回来（canvas + `getImageData()`）才现形——服务的 SVG 里有 `#2563eb`，画出来的图里一个蓝像素都没有。
修法是渲染分两趟：先按深度画所有「面」（父在前、子在后），再画所有「内容」（文字、图标、图片占位）。
几何没有变，所以标记与图片仍然同源；已经存在平台上的草图是旧渲染的字节，重新上传一次即可（本轮没有任何项目在用）。

**验证**：374 单元（contracts 159，含 21 条样式读取、49 条提取器、2 条叠放次序）+ 168 集成测试通过；真实页面（本仓库 7 个页面）
的「每个字符串都有标记」性质仍然成立。新增集成用例：一份带 `<style>`、Tailwind 类、`data-key` 与一段 `<script>`
的页面经 REST 上传后，3 个字符串 → 3 个标记、3 个按 `data-key` 匹配上项目里的 key、取回的 SVG 里有按钮的蓝色
（`#2563eb`）而没有脚本内容；两种输入同时传返回 422 并列出三种输入。MCP 侧：连上真实服务读 `instructions`、
资源与提示词，文档里的示例**原样执行**（`html` 那段示例被解析、渲染，标记的 key 是 `exam.next`、namespace 继承）。
浏览器里走完整条路：上传一份带 `<style>` 与 Tailwind 类的页面 → 打开翻译编辑器的「界面草图」→ 把那张图当像素读回来，
页面自己的蓝（`#2563eb`）与深色标题确实画了出来，控制台无错误。

**没有做的是什么，以及为什么**：一开始评估过「服务端渲染调用方的 HTML」，没有做。上传的东西在这套系统里一律是
惰性数据（SVG 有黑名单、按字节判类型、返回时 `sandbox` CSP + `nosniff`、编辑器只用 `<img>` 渲染）；HTML 要有用就得
**渲染**，那等于在 API/worker 进程里跑调用方给的代码（外链、SSRF、字体与 CSS 拉取、死循环），而且服务端也渲染不出
那张页面——调用方给的多半是壳：Tailwind 需要那份 CSS、组件是 import 的、内容是 hydration 之后才有的。
所以这条路是「解析成元素树 + 平台自己画」，要真像素级，让调用方本地截图、自己量坐标传 `image_base64` + `markers`。

### 1.41 统一入口：不管什么技术栈都转成 HTML，补齐移动端的语汇

用户要求：「无论代码是 iOS、安卓、Web 或者其他语言，都需要把界面转成 HTML 上传上来，这个更统一，查看、操作空间也好」。

这是上一轮 `html` 输入的收口：把它从「三种输入里最省事的那种」变成**所有技术栈的统一入口**。敢统一的前提要说清楚——
**平台存的不是调用方的 HTML**，而是它自己按元素树画出的 SVG 与标记坐标，所以画法、主题、组件语汇都能在平台侧继续
演进，调用方不用重传；HTML 只是「怎么把界面说清楚」的一种写法，而且是一种谁都会写的写法。

**先补语汇：移动端截图里最显眼的几样东西以前画不出来。**

| 新增 | 画成 | 从源码里怎么认出来 |
| --- | --- | --- |
| `tabbar` | **贴屏幕底部的**标签栏（顶边一条细线，项目横向铺满） | `TabBar` / `UITabBar` / `BottomNavigationView` / `.tabbar` / `.bottom-bar` |
| `switch` | 开关（实心轨道 + 白色圆钮） | `Switch` / `Toggle` / `<input type="checkbox">` |
| `slider` | 滑块（轨道 + 已填充段 + 圆钮） | `Slider` / `SeekBar` / `<input type="range">` |

`tabbar` 的关键不是形状而是**位置**：它属于屏幕底边，不属于内容流。此前的排版把它当成普通子节点，于是每一屏内容
比视口长（也就是几乎每一屏）它都会被挤到折叠线以下——排版因此分两段：先把内容排完定出画布高度，再把贴底的栏放到
`画布高 - 栏高`，图与标记仍然出自同一趟。

**组件名现在两种写法都认。** 以前只有**标签名**参与分类，所以 `<div class="card">` 只会是一个 `section`（只是背景色像卡片），
`<div class="tabbar">` 更是完全认不出。现在分类先看组件名——标签名或类名任一处出现 `card`/`btn`/`badge`/`tabbar`/`switch`/`slider`/
`Field`… 都算——只有剩下的才按标签归类（`div` 是分组、`li` 是行）。`<input>` 是唯一的例外，它先看 `type`：`range` 是滑块、
`checkbox` 是开关，不能因为标签叫 input 就当文本框。

**顺带修掉的一个「画不出来的控件」**：`pick()` 会丢掉既没有文案也没有子节点的元素（本意是清理空壳），于是
`<input type="checkbox">` 这类**没有文案的控件**被整棵剪掉——一页设置项画出来只有标签、旁边没有开关。现在
`switch`/`slider`/`image`/`icon`/`divider`/`input` 即使没有文案也保留：它们自己会画出东西。同一处还补上了
`image` 的 `alt` 与 `icon` 的文字标记（`<img alt="院徽">` 的 `alt` 是界面上唯一的名字，理应有个标记）。

**教程给了每种栈的对照表**（`localehub://screen-sketch-guide`）：`NavigationStack`/`TopAppBar` → `<nav>`、
`TabView`/`BottomNavigationView` → `<div class="tabbar">`、`UISwitch`/`SwitchMaterial` → `<input type="checkbox">`、
`UISlider`/`SeekBar` → `<input type="range">`、`List`/`RecyclerView`/`FlatList` 的行 → `<ul><li>`、`Card`/`MaterialCardView`
→ `<div class="card">`、`TextField`/`TextInputLayout` → `<input placeholder>`、`Image`/`AsyncImage` → `<img alt>`、
分段控件 → `<div class="tabs">`，以及三个必须一次定对的字段（`platform` 决定画布、`namespace` 决定字符串表、
`data-key` 决定文案挂在哪个 key 上）。`instructions` 与 `upload-screen-sketch` 提示词也改成同一句话：
不管什么栈，先转成 HTML。

**验证**：382 单元（contracts 167，新增 5 条原生控件、3 条类名组件、3 条 `input[type]`）+ 168 集成测试；
7 个真实页面的「每个字符串都有标记」性质仍成立。叠放次序、贴底栏位置、开关与滑块都各有用例钉住。

### 1.42 「为什么收到的页面这么丑」：颜色与图片

用户反馈：「为什么接收到的页面这么丑，没图片和颜色」。复现出来的很具体：agent 从 SwiftUI 手写转出来的界面用的是**语义类名**
（`class="card"`、`class="primary-button"`），一个颜色工具类都没有 → 抽取器读到的样式是空的 → 渲染器只能用平台自己那套灰阶
（近黑按钮、白卡片、灰文字）；`<img>` 则永远是占位框，因为**平台从不联网取图**。

四处改动，正好对应「没颜色」和「没图片」：

| 加的 | 解决什么 |
| --- | --- |
| 按端默认的配色（`defaultTheme`） | iOS 用系统蓝 `#0a84ff` + 页面底色 `#f2f2f7`，Android 用 Material 蓝 `#1a73e8`，web 仍是近黑——同一份没颜色的描述，iOS 的屏看起来就像 App 了 |
| `theme: { accent, background }` | 调用方直接说品牌色，一次顶掉所有节点；accent 落在按钮、开关、滑块与**选中的那个页签**上。节点自己的颜色仍然优先 |
| `css` | 颜色常常不在页面文件里，而在 `globals.css` / 主题文件里。把那份样式表一起传，`:root` 变量与类规则都能解析，规则先于页面内的 `<style>`（页面自己写的优先） |
| 内联图片 | `<img src="data:image/png;base64,…">` 真的画出来（`<image href>` + `clipPath`，圆角跟着框走）；单张 ≤ 300 KB、合计 ≤ 1.2 MB，超了退回占位框。外链/仓库路径依旧是占位框——平台不联网，这是底线 |

**「选中的那个页签」是新加的可读性约定**：`tabs` 与 `tabbar` 的第一个项目按当前项画（accent 底、反白字）。没有这个，
分段控件画出来就是三个散字，标签栏画出来像页脚。

**CLI 顺带把仓库里的图带上**：`localehub mockup --page <文件>` 现在会扫描 `src="..."`，把工作区允许读、大小在限内的小图
读成 base64 内联进去（跳过哪张、为什么，都写在输出的 warnings 里）。这样 `--page` 出来的草图既带颜色也带图。

**验证**：393 单元 + 168 集成测试；用一段手写转写的 iOS 屏（语义类名 + 一张内联 logo + 标签栏）实测：抽取到的样式从 0 条
变成 4 条，画布上出现品牌色、页底色与选中页签的药丸；把同一棵树的 theme 换成 `#c8102e` 后，按钮与选中页签跟着变。

### 1.43 一张画布：页面的各个状态各占一帧，组件列出来并标出来

用户要求：「要做无限画布那种样式，关联的状态和组件也列出来，然后再标出来」；追问后确认：**画布上摆的是
「页面 + 多个状态各一帧」，状态由 Agent 上传时一起给**。

**上传**：`upload_screen_mockup` 与 `POST /mockups` 多一个 `frames: [{title, html?, ui?}]`（≤8 帧，与
`ui`/`html`/`image_base64` 互斥）。平台把各帧排成一张 `canvas`：横向铺开、**画布宽度按各帧之和**（不是按一个视口），
每帧上方写状态名——那行字是平台的标注，**不进标记**。`markers.frames` 报告每帧的标记数，`markers[].frame` 记住
一条文案落在哪一帧。

**组件**：节点上的 `component`（HTML 里就是类名或 `data-component`，JSX 里是组件名；工具类会被跳过）。平台给每个
实例打编号徽章、在画布底部列出编号/名字/实例数，并把**组件内部的文案都归属该组件**（继承最近的祖先）。
只有一个组件时不画图例——那不是图例，是标签，而多一条横带会加在每一张草图上。

**编辑器**：草图不再是「塞进框里的一张图」，而是一块可以**拖动平移、滚轮缩放**的画布（缩放以指针为中心，
所以正在看的地方不会跑掉），带「适应 / 1:1」；画布下方是状态与组件两条 chip，点一下把不属于它的标记与行淡下去——
「这个按钮在哪些地方出现」因此是可回答的。

**数据**：迁移 `20261116000000_mockup_marker_frame_component` + `20261116000100_mockup_legend`——marker 多
`frame`/`component` 两列，mockup 多 `legend` JSONB（存图上的编号，**不重算**：图上的徽章和旁边的清单必须一致，
而只有画这张图的那一趟知道编号顺序）。

**验证**：397 单元（新增 4 条画布/组件、3 条图例与叠放次序）+ 170 集成测试。真实浏览器里走完整条路：上传三帧
（默认 6 标记 / 空状态 5 / 加载中 5）、组件编号 navbar·policy-card·tabbar·primary-button，打开编辑器——
适应 57% → 放大 90% → 适应 57% → 1:1 = 100%、拖动确实平移、点「空状态」淡掉 11/16 个标记、点 `policy-card`
淡掉 13/16（它自己的 3 条留着）、16 行每行都带组件 chip、控制台无错误。

### 1.44 标记圈在控件上，并用引线把各状态的文案拉出来

用户反馈三件事：「还原度不够」「素材没有显示」「圈住的要是哪个控件或者 view，现在圈着文字不好看，最好是拉一根线出来
展示不同状态的文案」。第三件最具体，先做它，同时把前两件的损失量化出来（见 §1.44 结尾的分析）。

**标记改圈控件。** 之前标记取的是**内容框**（文字本身），于是真实的项目里出现「我的」被圈成 106×20 的文字条、
「推荐」被圈成 24×18。现在：

| 元素 | 标记覆盖 |
| --- | --- |
| 按钮 / 输入框 / 徽标 / 开关 / 滑块 | **整个控件**（含内边距） |
| 导航栏标题 | 顶栏里属于标题的那半边，**整条栏的高度** |
| 标签栏 / 分段控件的每一项 | **那一格**（拇指会落下的区域），不是格子里那行字 |
| 卡片 / 分组里的普通文字 | 它自己的文字框（没有别的可圈） |

`UiBox.markerRect` 承担这件事：默认仍取内容框，控件与格子各自覆盖。

**引线 + 状态对照（rail）。** 画布上出现两个以上状态时，右侧多一栏标注：从每个 key 的**控件**拉一条引线到标注栏，
标注栏里写 key 名，再逐行列出**每个状态**下那里的文案。某个状态里这句根本不在，就写「—」——那本身就是译者要知道的答案
（「空状态下这个按钮不存在」）。单屏草图不画这一栏：没有状态可比，它只会变成噪声。

标注栏是**图片的一部分**（平台画的，存进 SVG），所以任何人打开草图都看得到，不依赖编辑器；画布宽度把这一栏算进去，
标记的比例坐标随之重算（上传契约里 x 是「占图片宽度的比例」，不重算就会整体偏移）。

**验证**：400 单元（新增 3 条：控件级标记、状态对照栏、单屏不画栏）+ 170 集成测试；真实 REST 上传实测——
导航标题 358×52、按钮 92×38、卡片文字 322×20，画布里出现 `policy.count`（默认：共 3 份保单 / 空状态：共 0 份保单）
与 `policy.detail`（默认：查看详情 / 空状态：—）两条标注，3 条引线。

**还原度与素材：损失在哪（本轮分析，未全部修）**

用平台上真实上传的那张「高研院 iOS 首页」（390×1441、19 个标记）量的：品牌色**读到了**（`#F5F7FC` 底、`#306EEE` 主色，
配色不再是问题），但图里 `<image>` **0 个**、15 个灰圆代表所有图标、34 个矩形 38 段文字撑起一整屏——素材与细节都没进来。
按「谁的责任」排序：

| 层 | 损失 | 能不能修 |
| --- | --- | --- |
| **输入**（最大） | Agent 从 SwiftUI 手写转的 HTML 本身就是近似：教练头像、海报、插图、渐变、真实排版都不在里面。画得再准，画的也是那份近似 | 换输入：本地截图（Agent 有仓库，能跑浏览器）+ 从 DOM 量的坐标，100% 还原 |
| 素材 | `<img src="…">` 的外链/路径一律占位（平台不联网）；**行内 `<svg>` 也被当成占位**（图标、插图最常见的形式，而且标记就在手里）；`background-image` 与渐变完全忽略 | 行内 `<svg>` 可以画（与上传 SVG 同一道黑名单过滤）；CSS 里的 data URI 可以画；`--page` 已能内联仓库小图，可再扩到 `srcset` 与 CSS `url()` |
| CSS 读取 | 只认标签/类/inline：没有后代选择器、`:hover`、`@media`、`!important`；`hsl()`、渐变、逐边边框、`position`、字距行高、大小写、透明度都不认 | 逐项可加，属于工作量问题，不是设计问题 |
| 排版 | 一遍栈式排版：没有绝对/固定定位（只有顶底栏的贴边启发式）、没有重叠与 z-index、没有 grid 跨列、没有 aspect-ratio、没有 min/max | 同上 |
| 文字度量 | CJK 全宽 / 拉丁 0.56em 估算，换行位置与浏览器不同 | 只影响线宽与换行，不影响可读性 |
| 词表 | 16 种元素；表格画成一行行格子，图表/地图/视频/画布是占位 | 按需加 |

结论一句话：**平台这一侧能修的是「素材 + CSS + 排版」，但「还原度」的天花板在输入那一层**——手写 HTML 转述的界面，
画出来永远是线框图。要真正的还原度，得让 Agent 在本地截图。
### 1.45 工作目录 `.localehub/`：什么要提交、什么不要

用户问：「是不是应该让 Agent 用的时候建一个工作目录 .localehub，然后输出的东西也要在里面提交」。

**是，而且一直就是这个设计**——只是没人把「提交什么」写下来，而且有一处该忽略的没忽略。现在定死：

| 文件 | 提交 | 说明 |
| --- | --- | --- |
| `.localehub/config.yaml` | **要** | 仓库与项目的对应关系（project id、语言目录、端映射）。`create_project` 的 nextSteps 现在明说「并提交进仓库」 |
| `.localehub/mockups/*.svg` + `*.json` | **要** | 见下 |
| `.localehub/state.json` | 不要 | 本机同步游标与历史。**之前没有 gitignore**——提交上去会让两台机器的 lastRevision/history 互相覆盖，也会把组织内部的 id 带进仓库 |
| `backups/`、`cache/`、`patches/`、`*.local.yaml` | 不要 | 本来就在 gitignore 里 |

**新增：草图旁边那份说明（manifest）。** 图片本身不说明它从哪来、是不是平台现在持有的那一版，所以
`localehub mockup` 现在同时写 `mockups/<名字>.json`：来源页面、屏幕身份（platform/locale/namespace）、画布尺寸、
标记数、组件清单、生成时间，以及**上传后平台的 checksum**。文件里带一句 `$comment` 直接写给人看：
「这份 .svg 就是上传到平台的那张图，要改就改页面源码再跑一次，不要手改这里的文件」。

为什么值得提交：Agent 改平台是改一个共享系统，评审应该在 PR 里看见它放了什么——一张几 KB 的 SVG 加一份说明，
比一句「我上传了草图」有用得多。

**验证**：402 单元（新增 2 条：图片与说明一起写出、预览态 `uploaded: null`）+ 170 集成测试；
`localehub://screen-sketch-guide`、`docs/QUICKSTART.md`、`docs/MCP.md` 都补了这张表。

### 1.46 引导工具：传完自己看 `report`，知道哪里没还原

用户说：「内容还是没色彩和图片素材 而且关联联动也有问题 圈中的地方要是红色的不要表在空间上 只是把控件圈住就好
你看看怎么做引导工具」。前两件在 1.42–1.44 已经改过（颜色/图片、标记圈控件、引线拉出各状态文案），
用户仍然看到同样的图——**因为失败是静默的**：图上传成功，只是画出来的东西不对，调用端没有任何反馈，
于是同一个 Agent 会一直用同一种方式重传。这一轮补的就是这个反馈回路。

**报告读的是画出来的那张图，不是调用端的输入。** 这是关键：读输入只能检查「你有没有传 css」，
读输出才能说「这张图上没有任何图片、颜色全是平台默认、两帧一模一样」——后者才是人看图时的判断，
而且对**已经上传的**草图同样有效（老数据懒算，不用重传）。

`packages/contracts/src/mockup-report.ts` 的 `analyzeSketch({svg, markers, legend})`：

- `stats`：图上真实的数量——`pictures`（内嵌矢量 + 内联位图）、`placeholders`（灰底斜线占位框）、
  `sourceColours`（平台调色板之外的颜色，也就是页面自己贡献的）、`frames`、`markers`、`missingKeys`、`components`。
- `findings`：六条，每条带 `title`（人话）与 `advice`（**要说清改哪个字段、用哪条命令**）。
  `FINDING_CODES` 既是类型也是运行期列表，好让「每条都可达、每条教程里都有」能被测试钉住。

| code | 图上是什么样 | advice 指向 |
| --- | --- | --- |
| `NO_PICTURES` | 一个素材都没有 | 行内 `<svg>` 直接画；位图内联 `data:`；`localehub mockup --page` 自动内联 |
| `PLACEHOLDER_PICTURES` | 若干灰底斜线框 | 同上（占位框＝图片只有 URL，平台不联网取图） |
| `NO_SOURCE_COLOURS` | 全是平台默认黑白灰 | `css` 字段传样式表（解析 `:root`）或 `theme: {accent, background}` |
| `IDENTICAL_FRAMES` | 几帧一模一样 | 帧要画不同状态；重复的删掉 |
| `MISSING_KEYS` | 标记指向平台没有的 key | 不是错误：`import_translations` 后自动对上，或写 `data-key` |
| `NO_COMPONENTS` | 图例空 | 组件名：JSX 组件名 / 类名 / `data-component` |

刻意**没有**「标记没圈准」这条：自己传 `image_base64` + `markers` 时平台手里只有那张图，
没有图上元素的坐标，判断不了圈得准不准——报告只说自己看得见的事，不猜。教程里也是这么写的。

**它出现在四个地方**，因为调用端、人、和下一次上传分别需要它：

1. `upload_screen_mockup` 的返回值（API 与 Remote MCP 同一份，由 `upsertScreenMockup` 在画完之后算出来并存进
   `screen_mockups.report`）；MCP 的 `nextSteps` 直接把 `findings` 的标题列出来。
2. `localehub mockup` 打印出来，写进 `.localehub/mockups/<名字>.json`。
3. 编辑器草图对话框顶部的琥珀色横幅：逐条列出「哪里没还原 + 怎么改」，不用去翻 API 返回值。
4. `localehub://screen-sketch-guide` 新增 §7「传完先看 `report`，再决定下一次怎么传」（含上面这张表），
   `upload-screen-sketch` prompt 第 7 步要求 Agent 读完报告、按 advice 改输入后**同名重传**再做下一步；
   只要 `NO_PICTURES` / `NO_SOURCE_COLOURS` / `IDENTICAL_FRAMES` 还在，就说明图没达到「看得出是哪个页面」。

**关联联动的问题**（用户同一条消息里提的）：标记的身份原本只有 `key + namespace`，而一屏多帧时同一个 key
在每一帧都有一个标记，编辑器的 selected/dimmed 状态把它们当成同一个，点一帧会亮起所有帧。
现在 `markerKey` 是 `namespace \x1f key \x1f frame`，帧之间不再串。

**验证**：410 → 419 单元（新增 `packages/contracts/src/__tests__/mockup-report.test.ts`：8 条行为 +
3 条「每条 code 都可达、教程里都有、advice 都能落地」）；`scripts/check-mcp-sketch-guide.mjs` 增加
「教程讲了 report」「教程列全六个 code」「prompt 让 Agent 读 report」三项，对真实 MCP 跑通；
集成测试新增 `NO_PICTURES` / `NO_SOURCE_COLOURS` 与 detail 的 `report` 断言。
浏览器实测：用没有图片、没有颜色、两帧重复的页面传一张草图，API 报出全部五条 finding，
编辑器横幅逐条渲染出来，控制台零报错。

### 1.47 整页复刻：不重画，把页面本身交给浏览器

用户说：「素材还是没上传上来 不要 svg 啊 直接完整的 html+素材完整复刻 动态数据除外」。上一轮的答案是**提高重画的
保真度**（读页面的颜色、内联图片、组件外观），但重画永远是近似：字体是平台的、渐变阴影是估的、图标要内联成 SVG。
用户要的是那一页本身——所以这一轮加的是第二条路，**`document`：整页复刻**。

**平台不画，浏览器画。** 整页（`document`，或 `html` 里带 `<!doctype html>`／`<html>`——碎片仍然走重画，片段没有文档
可言）原文存进 `screen_mockups.document`（JSONB，`{frames:[{title,html}]}`，`image` 因此可以为空），编辑器在
`<iframe sandbox="allow-same-origin">` 里照它渲染。没有 `allow-scripts`，所以 `<script>`、`onclick`、`javascript:`
都不执行——**页面是被看，不会动**，由接口填的数据自然不出现，这就是「动态数据除外」。API 端同一份 CSP
（`default-src 'none'` + `img-src data: blob: https:` + `sandbox allow-same-origin`）是第二道，直接导航过去也一样安全；
`allow-same-origin` 保留下来是给父窗口量元素用的。

**素材怎么跟着走**（平台从不联网取资源，这是设计）：本地文件内联成 `data:`（`localehub mockup --page` 对整页会自动内联
`<link rel=stylesheet>`→`<style>`、`<img src>`、`srcset`、CSS `url()`，且 CSS 里的相对地址按**样式表自己的目录**解析——
按页面目录解析会把背景图内联错），或者写成浏览器能取的 `https` 地址。实测：上传一页自带样式表 + 内联 SVG 图标的
页面，浏览器里读到按钮底色 `rgb(48,110,238)`、卡片圆角 `14px`、图片 `naturalWidth` 非零，脚本没跑。

**标记怎么落**：整页里没有坐标可存，所以标记来自 `data-key` / `data-i18n-key`，矩形由**渲染这一页的浏览器实测**
（编辑器读 `contentDocument` 量每个元素，换算成与重画路径相同的比例坐标），因此排版变了、字体没加载完，框仍落在元素上；
同一个 key 在同一页出现两次会画两个框，而不是一个把两者都罩住的并集。这一轮同时修掉了**画布与右侧列表的单向联动**：
`SketchCanvas` 在 `pointerdown` 就 `setPointerCapture`，把后续的 click 重定向到了画布本身，于是点标记永远不会触发
标记的 onClick（行→标记是好的，标记→行never）。改成**超过 4px 抖动才捕获**，两个方向都通。

**引导**（用户上一轮的要求）在两条路上都给了：`analyzeDocument` 读**页面自己**并给出 `NO_KEYS`、`ASSETS_NOT_INLINED`、
`NO_STYLE`、`REMOTE_ASSETS`、`SCRIPTS_NOT_RUN`、`NO_PICTURES` 六条，每条带改法；`localehub://screen-sketch-guide`
新增 §0（整页 vs 片段的选择）与 §8（什么时候用、素材对照表、脚本不执行、状态与坐标），工具描述与 prompt 同步。

**踩到并修掉的坑**：`screen_mockups` 的 raw `INSERT … ON CONFLICT DO UPDATE` 在去掉 `RETURNING id` 之后**照样写入、
却返回空结果**——诊断过程中一路排除参数、RLS、冲突路径之后才在编译产物里看见模板里少了那行。现在这段代码把
空结果当错误抛出（附注释说明为什么），不再让它变成三行之后一个「Cannot read properties of undefined」。

**验证**：427 单元（新增 `mockup-document` 的读页与素材分类、`analyzeDocument` 六条 finding、`page-assets` 的
内联三条）+ 172 集成（整页上传→`kind: document`→`/document` 返回 `text/html` 且 CSP 不含 `allow-scripts`→`/image`
对复刻返回 409；无 key 的整页被拒并指名 `data-key`）；`scripts/check-replica.mjs` 在真实浏览器里跑通：
页面自身样式生效、素材解码、标记与元素位置一致、点标记→右侧行高亮、切状态换页、控制台零报错。

### 1.48 标注换个画法：红圈描边，编号挪到圈外

用户说：「那个圈着框框太丑了 要用红色线圈起来 然后标签在圈外 不要重叠」。之前的标记是一个**带底色的实心框**，
编号就压在框里的那行文字上——标注盖住了被标注的东西，两个挨着的控件还会把编号叠在一起。现在：

- **只有描边，没有填充**（`border-2 border-red-500` + `bg-transparent`），所以框下面那行字照样读得清；悬停才淡淡染一下。
- **编号画在框外**：每个编号从四个候选位置（框上方左右、框下方左右）里挑一个，代价 = 越出画布 ×1000 +
  压到别的编号 ×4 + 压到别的控件框 ×3，取最小的那个。所以它既不会回到自己的框里，也尽量不落在别的编号或别的框上。
- **编号是固定屏幕尺寸**（17px），不随缩放变小：`SketchCanvas` 把当前缩放比例报给对话框，编号按 `17 / scale` 反算，
  于是「适应窗口」时和放大到 400% 时一样清楚。框与编号之间留 2px，读起来是「框旁边有个标签」而不是框的一部分。
- 「这条还没译文」的信号从框的颜色挪到了**编号的颜色**（琥珀），右侧列表不变；画布下方的图例说明了这两种颜色。

**验证**：`scripts/check-marker-look.mjs` 在真实浏览器里量两件事——**两条路都量**（平台画的草图与整页复刻）：
描边是红色（`oklch(0.637 0.237 25.331)`）、2px、填充透明；编号 17×17、与自己的框相隔 2px、互不重叠；
点编号能选中右侧对应的行；被标住的控件本身样式没被盖掉（读回它的 `backgroundColor`）。427 单元 / 172 集成、
`pnpm lint` 全绿。

### 1.49 上传方交的是示意图，平台却报「有 6 张图，没问题」

用户说：「上传上来的还原度不太行 也没有素材」。先把库里那一页取出来看，不猜：

```
上课页 | ios | document | 17870 字符 | 3 帧
assets: {"inline":0,"remote":0,"local":0,"pictures":6,...}   ← 旧口径
findings: [ 'NO_COMPONENTS' ]
```

848×844 的一屏里 `<img>` 0 个、`url(` 0 个、`data:image` 0 个、6 个手写 `<svg>`，文字位置是灰条占位
（`.nav .bar{background:#DFE6F5}`）。**存进来的是一张线框图**——平台这一侧一个字节都没丢，是上传方手写的。
把它渲染出来一看，是一张「像那个 App」的示意图：认不出是哪个页面，因为照片、插画、图标一个都没来。

根因两条，都不在渲染上：

**一、上传方读到的文档还是「重画时代」的。** 导入指南 §6 开头写着「上游只有一条路值得走：**传 `ui`**」，
`upload-screen-sketch` 提示词第 3 步写着「平台只解析、不渲染」、第 5 步列三种输入**没有 `document`**。
整页复刻的说明（§1.47 建的）只在那份长 guide 里，上传的 Agent 没有被路由过去，于是照着旧指令手写了一张图。

**二、报告看不见「没有素材」。** `documentAssets` 把 `<svg>` 和 `<img>` 一起算进 `pictures`（原
`mockup-document.ts:251`），于是零素材的一页报出「pictures: 6」，唯一能告诉上传方「你这页什么都没带」的
信号是哑的。

改动：

- **`pictures` 与 `shapes` 分开数**：`pictures` = 页面**带来**的（`<img>`、`<image>`、`background-image`），
  `shapes` = 调用方**画**的（行内 `<svg>`）。两者答的是不同问题：「这屏的图到了吗」是译者看着线框图在问的那个。
- **新 finding `DRAWN_SHAPES`**：`pictures === 0 && shapes > 0` → 「N 处图形是手画的形状，这一页一张真素材都没有」，
  advice 指名从哪取原件（`Assets.xcassets` / `res/drawable*` / `assets/`），并且**矢量图标要照抄工程里的 `path`，
  不要照着截图重画一个像的**。`NO_PICTURES` 的措辞跟着改了：行内 `<svg>` 不再算「有图」。
- **教程新增 §9「素材和布局从工程里读出来，不要照着印象画」**：逐栈对照表——布局数值在哪、图在哪、颜色/字号在哪
  （iOS SwiftUI 与 UIKit/storyboard、Android、Flutter、React Native、Web 各一行），两条硬规矩（尺寸坐标照抄工程数值；
  图取工程里的原件），加一句自检：「看不出是哪个页面，就不要传」。
- **导入指南 §6 与上传提示词重写**：首选 `document`（整页复刻），片段是退路；明说「不要照着眼睛写一份示意图」；
  提示词第 3 步改成「交那一屏**真实的 HTML**」并点名原生界面的数值在工程里，第 7 步把 `DRAWN_SHAPES` 列进要看懂的
  那组 code。第 5 步补回「不要传 markers 配 html / ui / document」——这条被重写时漏掉过，`guide.test.ts` 当场抓住。
- **CLI 预览就报**：`localehub mockup --page`（不加 `--confirm`）走的是同一个分析器，所以上传**之前**就看到
  `DRAWN_SHAPES`，不用先传一次再被平台告知。

**验证**：拿用户那一页真实的三帧跑新分析器：

```
stats: {"pictures":0,"shapes":19,"frames":3,"markers":40,"keys":22,"inlineAssets":0,...}
findings: DRAWN_SHAPES | 19 处图形是手画的形状，这一页一张真素材都没有
          NO_COMPONENTS | 元素没有组件名，图例是空的
```

新增 7 个单元测试（434 全绿）：`pictures`/`shapes` 的分口径、`DRAWN_SHAPES` 的触发与 advice、
「一页同时有 `<img>` 和 `<svg>` 时保持 clean」、教程里逐栈线索（`constraint` / `layout_` / `padding` /
`StyleSheet` / `xcassets` / `drawable`）、提示词不再出现「平台只解析、不渲染」与「三种输入选一种」、
导入指南不再出现「上游只有一条路值得走」、以及 local-sync 里「预览（上传前）就报 `DRAWN_SHAPES` 且消息里带改法」。



### 1.50 存下来的报告是「判决」，判决不能比规则活得久

用户说「还原度还是很大问题 你研究下怎么才能提高」。把所有组织的界面草图列出来，找到另一屏真的：
**`高研院iOS` / `首页` / ios**，30,602 字符、4 帧、26 个 key，报告写着 **`"clean": true`，一条 finding 都没有**。
而它的 CSS 是：

```
.banner{margin:12px 16px 0;height:96px;border-radius:12px;background:var(--ph)}   /* --ph:#E8ECF5 灰块 */
.kk div{height:56px;border-radius:14px;background:#fff}                          /* 五列灰卡占位 */
.ph{fill:none;stroke:#A9B4C7;stroke-width:1.6}                                    /* 手画的占位描边 */
```

**这就是那批灰块线框图，而平台给它打了「没问题」。** 用今天的规则重算同一份存下来的文档：

```
旧：pictures: 60 → clean: true
新：pictures: 0, shapes: 60 → DRAWN_SHAPES | 60 处图形是手画的形状，这一页一张真素材都没有
```

根因是一行缓存判断（`mockups.service.ts`）：

```ts
const report = stored?.findings ? stored : await this.analyzeStored(...);
```

只要存下来的报告**有 `findings` 字段**就原样返回——而「没问题」恰恰就是 `findings: []`（空数组在 JS 里是真值）。
于是**上传时算好的判决被永久缓存**：§1.49 加的规则对任何已存在的行都不生效，用户看到的还是「clean」。
这比没有报告更糟——调用方把它读成「平台说这页没问题」。

改动：**整页按读重算，重画那条路仍用存下来的那份**（重画要解码图片，而它的图不会再变；整页只需重解析
行里已有的标记，且没有图片可解）。一次额外的主键读换「规则改了，所有已上传的行立刻跟上」。

**验证**：`首页` 通过运行中的 API 读出来已经是 `clean: false` + `DRAWN_SHAPES | 60 处图形是手画的形状`，
编辑器打开它会挂出这条横幅。集成测试新增一条：把一个「旧规则算出来的 clean 报告」写回库里（`SET LOCAL
app.bypass_rls` + 检查影响行数，否则 arrange 静默不生效、测试就因为错误的原因通过——第一次跑正是这样），
再读详情，断言它按今天的规则回答。434 单元 / 173 集成 / typecheck / lint 全绿。

**顺带**：这台机器的 Docker VM 被这轮反复分层构建塞满（58.4G 用到 0 可用），Postgres 报
`could not extend file ... No space left on device`，集成测试连项目都建不出来。`docker builder prune -af`
回收 32.79GB、`docker image prune -f` 回收 23.73GB（19 个 dangling 层），现在 25.2G 可用。别的项目的镜像没动。

### 1.51 复刻的 HTML 必须绝对定位（用户要求）

用户说：「生成的 html 要绝对布局」。这条不只是风格偏好——它是**让"像不像"从主观变成可判定**的那一步：

流式布局（flex/grid）把摆放交给浏览器的排版引擎，而浏览器的引擎不是设备的那个。字体、字号、行高差一点，
整块就挪走，而且**错得不明显**——一套错的数值会被吸收成一个看起来还挺合理的版式，谁也指不出哪里错了。
绝对定位反过来：每个元素在工程给它的坐标上，错了就是错位、重叠、超出屏幕，**一眼看得见**。

平台上两屏真实数据正好把这个分界画出来（同一项目、同一个 Agent）：

| 屏 | position:absolute | flex/grid | 报告 |
| --- | --- | --- | --- |
| `首页`（线框图） | **0** | **44** | DRAWN_SHAPES + `FLOW_LAYOUT` |
| `上课页`（重传那版） | **33** | 4 | 只有 MISSING_KEYS（info） |

改动：

- `documentAssets` 新增两个计数：`positioned`（`position: absolute|fixed`）与 `flow`（`display: flex|grid`），
  只读页面自己带的 CSS（`<style>` 与 inline style；外链样式表本来就被要求内联，读不到就不猜）。
- 新 finding `FLOW_LAYOUT`：`flow > 0 && positioned === 0` → 「N 处用 flex/grid 排版，整页没有一处绝对定位：
  这是重排，不是那一屏」，advice 给出写法（容器 `position:relative`，元素 `position:absolute` +
  `left/top/width/height`）和数值从哪来（Auto Layout 的 frame、`layout_*`、Flutter 的 `padding`）。
  **判据取"一处绝对定位都没有"**，所以混合的页面（上课页 33/4）不误报。
- 教程 §9 的「两条硬规矩」改成三条，**绝对定位升为第一条**并列在最前；findings 表加一行。
- `upload_screen_mockup` 的工具描述与上传提示词同步（原生界面的数值在工程里 → 照抄成绝对定位）。

**验证**：真实数据跑新分析器——`首页` positioned 0 / flow 44 报 `FLOW_LAYOUT`，`上课页` positioned 33 / flow 4 不报；
再通过运行中的 API 读两屏详情，结果一致（首页 0/44 两条 finding，上课页 99/12 只有 MISSING_KEYS）。
436 单元（新增 2 个）/ typecheck / lint 全绿。

### 1.52 「漏了很多文案」的真正原因：内容被容器裁掉了 64%

用户问「现在还漏了很多文案 为什么」。量出来不是绑定问题：

- 上课页 3 帧共 **42 个标记**，其中 **27 个（64%）整个落在 844 之外**（学习中 9/16、已结课 8/14、体验课 10/12）。
  例如 学习中：切换下一门课程@1301、我的课程@1335、个人IP海报@1335、同学圈@1335、问老师@1471、
  本课学习分钟/天数/总训练值@1432、去学习@1410 —— 底部整条 tab 栏、统计面板和主按钮，图上从不出现。
- 页面内容实际高 **1507px**，而 `.screen{height:844px; overflow:hidden}`。
- 页面上每个可译字符串都挂着 key（没有 key 的只有数字与「（结课说明由接口下发）」），标记 **39/42 匹配到 key**，
  只有 `同学圈` 真不在项目里。所以「漏」的不是 key，是**被裁掉的那 663px 画面**。
- 另有 6 个文字盒子窄于其文字（`本课学习分钟` 装在 25px 盒子里、文字需要 84px），文字溢出压到邻居上。

**关键发现：这一类错误静态查不出来。** 我从 CSS 文本里取所有 `top` 的最大值 = **782**，小于 844，看着完全正常——
因为那些底部元素是在**定位容器里按正常流往下排**的，位置只有排完版才有。所以"元素跑到屏外"这件事只有排版引擎看得见。

**但根因是可以查的**：`overflow:hidden` + 固定像素 `height` 写在同一条规则里 —— 这个组合意味着"内容可能被丢掉"。
真实数据上正好一处：`.screen{height:844px;overflow:hidden}`。所以新增 finding：

- `documentAssets` 新增 `clipped` 计数（同一条规则里同时有固定 `height` 与 `overflow:hidden`）。
- 新 finding **`CLIPPED_BOX`**：`N 处盒子设了固定高度 + overflow:hidden：排到它外面的内容，图上不存在`。
  advice 明说这一条比别的重要——**丢掉的东西后面找不回来**（图是唯一产物，文案在渲染前就没了），
  并给出改法（内容多高盒子就多高，不要用 `overflow:hidden` 收口）与自查手段（跑 `localehub mockup --page` 预览或在浏览器里打开）。

**按用户要求，把指引改成一份可对照的标准**（不再是一段建议）：

- 教程 §9 重写为「**复刻的交付标准 S1–S10**」，分画布 / 布局 / 文案 / 素材四组，每条后面括号里注明**平台用来判定它的 finding**
  （S2→`CLIPPED_BOX`、S4→`FLOW_LAYOUT`、S7→`NO_KEYS`、S9→`NO_STYLE`、S10→`DRAWN_SHAPES`/`ASSETS_NOT_INLINED`）。
- 上传提示词 `upload-screen-sketch` 重写：开头就写「**交付标准 S1–S10 是硬性的，逐条对照；不满足就不要传**」，
  第 3 步把五条硬要求逐条列出，**第 6 步新增「上传前自检（必做，不是可选）」**——四个问题逐帧问一遍，
  四个都答「没有」才传；第 8 步把 `CLIPPED_BOX` / `DRAWN_SHAPES` / `FLOW_LAYOUT` 列进要看懂的那组 code。
- `upload_screen_mockup` 的工具描述同步（最常被读到的那段）：加上「内容多高盒子就多高，不要用固定 height + overflow:hidden 收口」。
- `scripts/check-mcp-sketch-guide.mjs` 新增 5 条断言把标准钉住（S1/S2/S4/S5/S7/S10 都在、`CLIPPED_BOX` 在、
  「内容多高」与 `overflow` 在、提示词里自检是独立一步、提示词点名这两个 finding），防止以后重写时悄悄丢规则。

**验证**：真实数据跑新分析器——上课页 `positioned 151 / flow 0 / clipped 4` → 报 `CLIPPED_BOX`；
首页 `positioned 0 / flow 44 / clipped 0` → 报 `DRAWN_SHAPES + FLOW_LAYOUT`。通过运行中的 API 读上课页详情一致
（`clipped: 4` + `CLIPPED_BOX`）。438 单元（新增 2 个）/ typecheck / lint 全绿；
对已部署 MCP 的实时检查 **41 项全过**。

### 1.53 调用端反馈的 10 条：先修可判定的那批（P0 + 本地校验）

一次真实使用（同一项目 20+ 张草图 / 50+ 帧）沉淀了一份反馈，每条带复现与验收用例。逐条**先验证再改**：

| # | 反馈 | 验证结果 |
| --- | --- | --- |
| 1 | 带尾空格的 key 匹配不上 | **属实**。`mockup-document.ts` 读 `data-key` 时 `.trim()`，而 key 库里不裁剪——一个**本来存在**的 key 被报成「平台没有」 |
| 2 | `MISSING_KEYS` 不说是哪条 | **属实**。只有 `count` |
| 3 | `stats.frames` 只数有标记的帧 | **属实**。3 帧（1 帧无标记）报 2 |
| 4 | 单实例组件也报 `NO_COMPONENTS` | **复现不出他们所描述的样子**，但**实质是真的**：判据是「图例为空」，而图例是从**标记**推出来的——组件名写在没挂 key 的元素上就白写了 |

改动：

- **key 原样读**：只在「整串空白」时跳过，不再改写调用端的 key（尾空格是 key 的一部分）。
- **`MISSING_KEYS` 带 `keys: string[]`**（去重）——调用端不用再拿 `GET /keys?search=` 一条条试探。
- **`stats.frames` = 收到的帧数**，新增 `stats.framesWithMarkers`——「帧到齐了吗」和「有几帧能点」是两个问题，
  只报后者会被读成「丢了一帧」而触发无谓重传。
- **`NO_COMPONENTS` 改从标记读组件名**（`markupComponents`）：判据变成「整页一个组件名都没有」，与事实一致。
- **新增 `localehub mockup check <file>`**：跑平台同一套规则，**不写文件、不上传**，warning 级 finding 即退出码非零。
  「本地过、平台不过」到此为止——规则只有一份，两端跑的是同一个分析器。
- **教程 §10 四条约定**：key 里的换行**写真换行**（实测：`&#10;` 平台不解码、字面 `\n` 是两个字符，两种都匹配不上）、
  key 首尾空格是 key 的一部分、`components` 与 `legend[].count` 的口径、「图片名走本地化表」是调用端职责（附示例）；
  **§11** 讲 `mockup check`。

**验证**：444 单元（新增 4 条 P0 用例 + 2 条 `mockup check` 用例）/ typecheck / lint 全绿。
换行那条是实测三种写法得出的，不是推断。

**没做的（属产品决策，见 §1.53 后续）**：`NO_PICTURES` 让「确实没有图的页面」永远不 clean（需要请求级声明，
要加列 + 迁移）；参考截图比对（9.3）；草图侧的按页面总览视图（10）。

### 1.54 反馈文档剩下的三条：可声明的 NO_PICTURES、本地总览、以及 9.3 的取舍

§1.53 修完 P0 四条后，反馈文档还剩三条要定形状。用户说「做」，于是把不需要额外决策的两条做完。

**⑤ `expect_no_images`：让「确实没有图的页面」能 clean。** 这条的死结是：`NO_PICTURES` 的 advice 自己写着
「如果确实没有图，这条可以忽略」，可**忽略不掉的 finding 会让 `clean` 永远为 false**——调用端就没法拿
「没有 findings」当交付判据。做法是给调用端一个**能说的话**：

- `packages/database`：`screen_mockups` 新增 `expectations jsonb`（迁移 `20261119000000_mockup_expectations`）。
  **必须落库**，因为整页的报告每次读取都重算（§1.50）——声明只活一次请求的话，下一次读 finding 又会回来。
- `contracts`：`MockupExpectations { noImages?: boolean }`，`analyzeDocument` / `analyzeSketch` 都收；
  只压制 `NO_PICTURES`。重画那条路的 `PLACEHOLDER_PICTURES` **不受影响**——占位框意味着"图被引用了但没解析出来"，
  那不是"本来没有图"，声明不该掩盖它。测试里专门钉了这一条（`does not let the declaration hide a picture that
  failed to arrive`）。
- 线：API `expect_no_images` → domain 落库 → MCP zod/描述 → 详情读取时把存下来的声明再喂给分析器。
- **统计不撒谎**：`stats.pictures` 照样是 0。声明改的是判决，不是事实。

**⑩ `GET /projects/:projectId/mockups?include=unmatched`：草图侧的总览。** 一行多两个字段：`unmatchedKeys`
（该屏有多少标记指向项目里没有的 key）与 `findings`（上传时报告的 code）。前者用**一条** SQL 算（不是每屏一次）：
`NOT EXISTS (… translation_keys k JOIN namespaces n ON n.id=k.namespace_id WHERE k.project_id=… AND k.key=m.key
AND n.name=m."namespace" AND k.archived_at IS NULL)` —— **与 `resolveScreenMarkers` 同一套身份**（namespace+key），
所以这个计数和编辑器里那句「平台没有这个 Key」按构造就是一致的。不加参数时列表形状不变。

**⑨.3 参考截图比对：仍然需要先定 (A)/(B)。** 反馈里的现场案例（子组件当成页面级元素、底部固定卡 166 vs 真实 238、
列表起点 103 vs 真实 91）与我在 §1.52 查到的结论是同一件事：**S1–S10 验「自洽」，验不了「像不像」**。
要真验必须有参照渲染，那就是还挂着的问题：接受天花板，还是让上传方产出真实渲染 + 元素 frame 做比对。
两条独立路径得出同一结论，这条建议正面做决定；在此之前它不会被"再改几句指引"解决。

**验证**：446 单元（新增 2 条声明用例）/ 174 集成（新增 2 条：声明经过 API 落库并在重读后仍然生效；
`?include=unmatched` 在真数据上数出 1 条未匹配、不加参数时字段不存在）/ typecheck / lint 全绿；
镜像已重建并验证容器内是新代码。

### 1.55 草图上就地改译文：右侧不再只有「在编辑器中打开」

用户说：「右边的打开编辑器按钮跳页了 不方便 应该要在本页面编辑」。原来每一行的操作只有
「在编辑器中打开」——点下去弹窗关掉、跳到翻译编辑器、落到那条条目上。可读者此刻正看着**那个界面、那句话、
周围的上下文**，跳走丢掉的恰恰是他打开这个视图的理由。

改动（`screen-mockup-dialog.tsx`，编辑器弹窗与将来的草图页共用同一份）：

- 每行的**主操作改成「编辑」**：就在行内把值显示换成 `Textarea`，`保存 / 取消`，`⌘/Ctrl+Enter` 保存、`Esc` 取消。
- 保存走的是**编辑器自己那条路**：`POST /projects/:id/translations/:entryId/draft`（同一个端点、同一套 revision 校验、
  同一套审核流程），所以在这里写的草稿和在编辑器里写的是同一种东西——没有第二条路径，也就没有第二套规则。
  保存后重新拉详情，状态徽标（DRAFT 等）跟着更新。
- **「在编辑器中打开」保留为次级按钮**（ghost），不再是唯一出路：要审、要提交、要看版本时它仍然有用。
- 失败**显示在那一行上**（通常是角色不够，API 403）：比起「什么都没发生」，说清楚是更好的结果。
- 客户端不做权限门（编辑器页面本来也不做），API 是权威。

**验证**：`scripts/check-inline-edit.mjs` 在真实浏览器里跑完整流程——在真项目（高研院iOS）里临时传一屏、
取一条**真译文**、点编辑、改值、保存，然后断言三件事：**URL 没变（没有跳页）**、行上的值变了、平台上读回来就是新值；
最后把原值写回、删掉临时草图（脚本自己报 `value restored = true | probe screens removed = 1`）。实测输出：

```
editor took focus in the box: true
URL after saving     : unchanged (no navigation)
value on the platform: "就地编辑 mwn8044j"
SAVED IN PLACE       : true
```

446 单元 / typecheck / lint 全绿；web 镜像已重建（分层构建）并确认 bundle 里带 `data-marker-edit`。

### 1.56 传整个 App 之前，先把「从启动到每一屏」的关系摸清

用户说：「引导要加提示词 对方获取启动开始到会触发的页面的所有关系 然后再去提交」。这是 §1.53/§1.54 之后
上传方暴露出来的真正短板：**一屏单独看只能回答「这句话在这一屏的哪里」**；只有整套屏都在，译者才能顺着
「启动 → 首页 → 点去学习 → 上课页」一路找下去。而随机传几屏的结果是——没人知道少了什么，而「少了什么」
正是译者真正要问的问题。

新增 MCP 提示词 **`map-app-screens`**（`remoteScreenMapPrompt`），这是 `upload-screen-sketch` **之前**的一步：

1. 读导航源码，找到**启动那一屏**以及从它出发能到的每一屏和打开它的动作。提示词逐栈点名了导航在哪：
   iOS storyboard 的 `initialViewController`/`<segue>`、SwiftUI 的 `NavigationStack`/`NavigationLink`/`.sheet`、
   UIKit 的 `pushViewController`/`present`、Android 的 `LAUNCHER` activity 与 `res/navigation/*.xml`（nav_graph）
   的 `<action>`/`<deepLink>`、Flutter 的 `home`/`routes`/`onGenerateRoute`、RN 的 `react-navigation`、Web 的路由表。
   并提醒非按钮入口：tab、返回、深链、通知、**启动后自动跳转**。
2. **先列表、先不要传**：「从哪一屏 / 触发什么 / 到哪一屏 / 上传时用的屏幕名」，一屏多入口写多行，到不了的屏不写，
   拿不准的单独问。
3. 调用方确认后再按表里的顺序一屏一屏传（屏幕名用页面名，状态作为多帧）。
4. 把表写进仓库的 `.localehub/mockups/flow.md` 一起提交——复核的人要能看出「这一屏是从哪来的、点哪里进的」。

教程同时新增 **§12**（同样的内容 + 一张逐栈对照表），`upload-screen-sketch` 第 0 步指向它（只在传整个 App 时走）。

**验证**：实时 MCP 检查新增 7 条断言（提示词已注册、参数渲染、逐栈点名导航位置、先要表后上传、
`从哪一屏`/`到哪一屏`、教程指向它、教程写明 flow.md 去处），**47 项全过**；447 单元（新增 1 条）。
其中「逐栈点名导航位置」第一次是**失败**的——我漏了 Android 的实际文件名，检查当场抓住，补成
`res/navigation/*.xml`（nav_graph）后才过。

### 1.57 MCP 管理：每个工具都能点进去看

用户说：「MCP管理 点击每个工具都可以进去查看」。原来的表只有三列：名字、一句话、参数名逗号连起来——
「那我到底该传什么」这个问题，只有 MCP 客户端能回答（读 JSON schema），平台的页面上看不到。

- 新增路由 **`/mcp/[tool]`**：工具名、所属 server、参数个数与必填数、**完整描述**（不再截断——好几个工具的
  规则就写在描述里）、**参数表**（字段 / 类型 / 必填 / 说明，附默认值、枚举取值、嵌套形状的逐项展开）、
  **原始 schema**（可直接复制）。找不到的工具明确说「没有注册这个名字」并给回路。
- 列表每一行都可点（`data-mcp-tool`），**工具名本身是 `<a href>`**——可以复制链接、新标签打开、被读屏读到，
  不只是个 click handler。
- 类型抽到 `apps/web/src/lib/mcp-tools.ts`，两个页面共用，避免列表和详情各说一套。

**顺带抓到一个漂移**：`/mcp/tools` 并不返回 schema 里的描述，而是用
`apps/api/src/modules/mcp/tool-descriptions.ts` 那份**一行摘要覆盖**掉它。于是 MCP 客户端看到的是新文案，
平台自己的页面上挂着的却是「传 ui 元素树，平台自己画图并算坐标」——**这句在整页复刻取代它之后又活了两轮**，
因为两份文案之间没有任何东西保证同步。已修正，并加了一道机械能查的守卫
（`apps/api/src/__tests__/mcp-tool-descriptions.test.ts`）：每个已注册工具都有一行、不出现退役说法、
界面工具那行必须点明 `document`、以及不许给不存在的工具写摘要。

**验证**：`scripts/check-mcp-tool-pages.mjs`（真实浏览器）9 项全过——19 行、名字是真链接、
点进 `upload_screen_mockup` 后 18 行参数、3 个必填、`project_id`/`name`/`document`/`expect_no_images` 都在、
有回路、未知工具会说明。451 单元（新增 4 条）/ lint 全绿；web 与 api 镜像都已重建部署。

**没做的**：两处文案仍然分家（长描述在 `apps/mcp-remote/src/server.ts` 的 `define()`，短摘要在 API 的这张表）。
真正的修法是把长描述搬进 `@localehub/contracts`，让 MCP server 与 API 读同一份——那是 19 个工具搬一次的机械活，
这轮没做，留了口子。

### 1.58 草图上就地改译文之后，把 AI 翻译也放到同一处

用户说：「帮我把ai翻译也加上去」。AI 翻译此前**只有 MCP 工具**（`translate_entries`）和一条 REST 路由
（`POST /projects/:id/ai/translate`），**web 端没有任何入口**——编辑器页面也没有。既然刚把「就地改译文」做在草图行上，
AI 起草就应该在同一处，否则读者还是得两头跑。

- 草图每一行现在三个动作：**AI 翻译**（`Sparkles`）／**编辑**／在编辑器中打开（次级）。
- AI 那条走 `POST /projects/:id/ai/translate`，一次一条、写进**当前正在审的语言**；写完重拉详情，
  行上的值与 DRAFT 徽标立刻更新。与 MCP 的 `translate_entries` 是**同一个服务、同一个 provider、同一套术语库**，
  写进去的永远是 DRAFT——AI 不能自己通过审核。
- 权限与其他失败一样**落在那一行上**：这个接口要 `PRODUCT_MANAGER`，不够就是 403，行内显示原因。
- 不做「AI 直接覆盖后自动保存」这种隐式写：它就是一次起草，结果应当是可见、可改、可丢弃的。

**验证**：`scripts/check-inline-edit.mjs` 扩展了一段——真项目真译文上点 `AI 翻译`，断言值变了、
状态是 `DRAFT`、**URL 没变**，最后把原值写回。实测：

```
AI draft written     : "     分享文章自动带上个人名片，追踪客户线索"
its status           : DRAFT
page stayed put      : true
AI DRAFTED IN PLACE  : true
```

**一个必须写下来的坑**：`createProvider()` 只认 `anthropic` 与 `ollama` 两个分支，其余一律落到
`HeuristicProvider`（离线、不真翻）；而它读的是 `AI_DEFAULT_POLICY`（schema 默认 `'hybrid'`），
所以**只设 `ANTHROPIC_API_KEY` 不起作用**，必须同时设 `AI_DEFAULT_POLICY=anthropic`。
`OPENAI_API_KEY` 在配置 schema 里但**代码从未读取**——是个空旋钮。这次实测里 provider 就是启发式，
所以「译文」等于原文（`docs/STATUS.md:945` 早就记过这条，现在 web 端也能看见了）。已写进 `docs/MCP.md`。

### 1.59 把 pi 接进来（走它的 SDK，不是命令行）

用户说「不要补这个 把 pi 接进去」「接代码版的」。第一轮我猜成了 shell 调 `pi` CLI，被否掉——他要的是
**SDK**。`pi` 是 `@earendil-works/pi-coding-agent@1.5.2`（这台机器上全局装着），SDK 入口是
`createAgentSession` + `ModelRuntime` + `SessionManager`。

**为什么值得接**：这台机器上的 pi 已经配好了供应商与凭据（`~/.pi/agent/models.json` 里一个自定义供应商
`gpt-61-sol`，`https://io.immchina.cn`，模型 `ctyun/glm-5.3-flash`），平台不用再分发一把 key。这也解释了
最初那次 `pi -p` 报 401：**没指定 provider/model 时它挑了个没有凭据的默认**，`~/.pi/agent/auth.json` 只有 2 字节（`{}`）。

**为什么必须小心**：这是唯一一个「背后是**带 agent 运行时的模型**，而不是裸 completion」的 provider。所以调用
是先拔牙再说话（`PiProvider.complete`，注释里逐条写了理由）：

- `noTools: 'all'` —— **一个工具都没有**。被翻译的字符串是数据，它没有理由能指挥模型去读文件或跑命令。
- `expandPromptTemplates: false` —— 字符串里出现斜杠命令或技能名，不许被当成命令展开。
- **临时工作目录**（`mkdtemp`）—— 不带进 AGENTS.md、项目设置，任何从"API 恰好在哪个目录跑"发现的东西。
- **超时 + `finally` 里 `dispose()`** —— 挂住的 agent 不能把请求一直占着。

**工程上的三个决定**：

1. **SDK 是可选依赖**，用「真正的动态 import」加载：TS 编到 CommonJS 会把 `await import(x)` 改写成
   `require(x)`，而 pi 是 ESM-only、`exports` 里没有 `require` 入口，改写的调用成不成就看 Node 版本——
   所以说明符放在字符串里（`new Function('s','return import(s)')`），保住它是一次真正的 import。
   没用它的部署不装这 ~100MB 的 agent 运行时，启动也不加载。
2. **依赖没写进 package.json**：`pnpm add` 卡在 tarball 的 ECONNRESET（这条链路一贯如此），而它已经把
   依赖写进了 lockfile 却没写 package.json——那是个 CI 上 `--frozen-lockfile` 会炸的不一致状态，已回退。
   改为：代码里按名字给出安装指引，部署方自己决定装不装。
3. **失败要说人话**：任何 loader 失败都包装成一句「选了 pi，但装不上，装它或者换 provider」。
   这条包装放在失败**浮现的地方**而不是默认 loader 里——第一版的测试正是因为这个位置错了而失败
   （注入的 loader 绕过了包装），说明测试确实在测用户看到的行为。

**让它在容器里也能用**（本机 gitignore 的 `compose.override.yaml`）：挂 pi 的 agent 目录 + 全局 SDK 目录，
设 `AI_DEFAULT_POLICY=pi` / `PI_PROVIDER` / `PI_MODEL` / `PI_AGENT_DIR`。**凭据目录必须可写**——
pi 的凭据存储要在 `auth.json` 旁边建锁文件，只读挂载会以 `EROFS: mkdir '/pi-agent/auth.json.lock'` 失败
（这个错误我先撞到了才改的）。SDK 目录保持只读。

**验证**（三处，都是真调用）：宿主 SDK——`去学习` → `Start learning`（4.9s）；容器里的 REST——
`分享文章自动带上个人名片，追踪客户线索` → `Share articles with your personal card automatically attached
to track customer leads`（3.6s，`provider: pi`）；草图页上点 **AI 翻译** 按钮——
`Automatically attach your personal card when…`，状态 `DRAFT`，页面没跳。456 单元（新增 4 条，含把
`noTools: 'all'` 与 `expandPromptTemplates: false` 钉住的那条）/ typecheck / lint 全绿。

### 1.60 项目固定词库：模型、解析、策展、分级，以及后台管理里的那个页面

用户说「三个都按你倾向的做 我是说要在后台管理显示」。设计见 `docs/TERMBASE.md`（§9 是这次的实施状态）。
按设计做的七步里做了第 1–4、6、7 步；**第 5 步（改了词条触发重查）没做**——而设计里写着那一条才是"固定"成立的地方。

**模型**（迁移 `20261120000000_glossary_termbase`）：`status`（`TermStatus` 枚举）/ `do_not_translate` /
`forbidden_targets` / `disabled` / `created_by_id` / `updated_at`，以及 `(project_id, lower(term))` 的**部分唯一索引**。
`status` 默认 **DRAFT** 是刻意的：既有词条与新词条都先是草稿，QA 对它们的行为与改动前**完全一致**（警告）。
把违规升成"挡发布"的错误必须是某个人的决定，不能是迁移的决定。

**解析**（`packages/domain/src/glossary.ts`）：`resolveGlossary` 一处定优先级——组织级被项目级覆盖（并把被覆盖的
那条一起返回，不让两边悄悄打架）、项目行带 `disabled` 表示"在这里关掉"而不是"定义一个新词"。
三个读点（API QA、worker、AI 起草）都改走它，于是**同名词报两次**这个既有毛病一起消失了。
顺带修掉 AI 那条路把 `caseSensitive` 丢掉的问题（`formatGlossary` 把大小写与禁用词一并写进提示词）。

**分级**：`GLOSSARY_TERM_MISSING` 按状态定严重度——违反 `APPROVED` 是 **ERROR**（发布校验因此自动生效，
不用再改一处），`DRAFT` 是 WARNING，`DEPRECATED` 不参与；新增 `GLOSSARY_TERM_FORBIDDEN`。

**策展**：`PATCH` / `DELETE` / `POST .../glossary/import`（按 term upsert，带审计），`GET` 返回
`scope`、`overrides` 与计数。**MCP 写工具没做**，Agent 仍然只能读。

**后台管理**：新增 `/glossary`，挂在侧边栏「翻译管理」下（和「所有翻译」「待审核」并列）。三段统计、
词条表（逐语言译法、状态、来源、覆盖提示）、定稿/退回/删除、**从已有译文抽候选**、手工加一条。
项目记在 URL 上（`?project=`），所以"看看 X 项目的术语库"是一个能发给别人的链接。

**抽候选不猜译法**——这是实现时对设计的一处修正。设计里写"把现有译法作为建议值"，做的时候去掉了：
一句话和它的译文对不出其中某一个词变成了什么，给一个猜的值就等于平台替使用者背书。抽出来的是**词汇的形状**
（哪些短语反复出现、出现在几条 key、举例），由知道答案的人填。

**验证**：`scripts/check-glossary-admin.mjs`（真实浏览器）10 项全过——侧边栏入口、三段统计、词条逐行、
来源与覆盖、**定稿真的写进去**（DRAFT→APPROVED→DRAFT 原样退回）、URL 里带着项目**且页面真的打开了它**、
抽候选在真数据上出结果。456 单元 / typecheck / lint 全绿。

过程中三个坑，都值得记：

1. **抽取器对英文项目一个都抽不出**：`(?:\s+word){0,2}` 是**按 3 个词的步长**跳的，不是重叠窗口，
   所以跨边界的窗口永远试不到。中文能抽出来纯属侥幸（字符级 n-gram 是逐位推进的）。改成逐词滑窗。
2. **web 镜像 291 层**，超过 Docker 上限，`docker create` 都做不了——连拍平都拍不了。整份重建后降到 21 层。
3. **整份重建时漏了构建参数** `API_BASE_URL_INTERNAL=http://api:3001/api/v1`（compose 当 build arg 传的），
   镜像里烤进了 `localhost:3001`，在 web 容器里那就是它自己——浏览器走 Next 转发全 500，而 curl 直连 API 一切正常。
   同时发现我的检查**断言太弱**：只查了 URL 里的 `?project=`，没查页面是否真的打开了那个项目，所以它"假通过"了一次。
   断言改硬（改查选择器上显示的项目名）之后，才真正卡住。

### 1.61 术语库能写、能重查了：Agent 可以提，定稿由人；改了词条全项目跟着收敛

上一轮把词库建起来了，但留着两个洞，都是我自己在设计里写下、当时没做的那两条：**Agent 不能写**（只有 REST 和后台页面
能策展），以及**改了词条什么都不发生**——而设计里写着第二条才是「固定」成立的地方。这轮补上。

**Agent 可以提，但只能提。** 新增 `upsert_glossary_terms`（Remote MCP 第 20 个工具），需要新的
`glossary.write` scope——与 `glossary.read` **分开授权**：读是「知道这个词怎么译」，写是「决定别人以后怎么译」。
它有两个做不到的事，都是刻意的：**不能定稿**（违反 `APPROVED` 是 ERROR，会挡住发布；把这件事交给模型，词库迟早
塞满没人同意过的指令），**也改不动已定稿的词条**（会出现在返回值的 `untouched` 里，而不是被静默忽略）。
传 `term` 不传 `translations` 是合法的：那表示「这个词固定，译法待补」，平台不替谁猜。

**写一条术语 = 排一次重查。** 四条 REST 写入口与 MCP 那条都会入队一次该项目的 QA 运行，写进 `qa_run.scope` 的
`reason` 与 `terms` 里——QA 历史里突然冒出来的问题，得能回答「因为什么」。三个刻意的选择：**跑整个项目**
（设计里写的「只重排含这个词的条目」要先扫一遍全项目原文才知道挑哪些，而重跑只发生一次，结论一样；等人抱怨慢了再按词筛）；
**入队失败不抛错**（词已经写进去了，Redis 抖一下把一次成功的保存变成 500 是对使用者说谎；`recheck.queued` 如实回报，
页面据此换成「已定稿，但重查没排上——请手动跑一次 QA」）；**一个项目一个 jobId + `removeOnComplete`**
（导入一次再改一条合并成一次运行，跑完 id 立刻释放）。

**MCP server 现在也要 Redis。** `apps/mcp-remote` 为此加了 `bullmq` + `ioredis`（原来只有 API 和 worker 有）。
生产者是懒建 + 容错的：读工具在 Redis 挂掉时照常工作。生产环境的 `docker/api.Dockerfile` 会正常装上这两个依赖；
这台机器上的镜像仍是「把源码叠到上一个镜像」的层构建，所以**额外做了一步 `cp -a` 把已有的 bullmq/ioredis 符号链接
复制给 mcp-remote**——否则镜像能构建、容器能起，第一次写术语才炸 `MODULE_NOT_FOUND`。

**顺手修掉一处正在漂的字**：`/mcp` 教程页第 2 步写着「十九个工具里有十七个把它当第一个参数」——那是上一轮我亲手改的数，
这一轮加了工具又过期了。改成**从注册表数出来**（页面拿 `/mcp/tools` 自己数），并且检查脚本断言「页面说的数 = 注册表里的数」，
而不是把 20/18 再写死一遍。同一处的 `skill-delivery` 集成测试也把写死的 19 换成注册表长度（并补一条「服务端真实注册数
也要等于它」）——写死的数字只会被下一个人「顺手加一」，不会有人问它为什么在那儿。

**验证**（都在容器栈上跑，不是本地）：

| 验证 | 结果 |
| --- | --- |
| `packages/domain` 术语库单测（新增） | 17 passed：优先级/覆盖/禁用/大小写去重、`termTarget` 的 do-not-translate 与废弃、以及「已定稿违反 = ERROR、草稿 = WARNING、废弃不参与」 |
| `apps/e2e-demo/src/glossary.integration.test.ts`（新增，真 MCP + 真 worker 子进程） | 6 passed：缺 `glossary.write` 被拒且报出缺哪个 scope；提的术语落成 DRAFT；**批准后同一句话从 WARNING 变 ERROR**；Agent 改不动已定稿的词条且译文未被改写；删掉词条后它的抱怨一并消失；`qa_run.scope.reason` 记着原因 |
| 数据库实证 | `SELECT scope->>'reason', scope->>'term' FROM qa_runs` 有 `glossary.term_updated ["cart"]`（后台页面点的按钮）、`glossary.terms_proposed ["Course"]`（MCP 提的）等 8 条 |
| `scripts/check-mcp-tool-pages.mjs` | 11 项全过，含新增的「教程页说 20 / 18，注册表是 20 / 18」 |
| `scripts/check-glossary-admin.mjs` | 11 项全过，含新增的「批准会留下一次重查」 |
| `scripts/check-mcp-sketch-guide.mjs` / `check-mcp-onboarding.mjs` | 全过（guide 文本改过，重跑确认没碰坏） |
| 单元 / 集成 / lint / typecheck | 473 + 181 passed；lint 0 warning |

镜像这一步踩了两个坑，都值得记：

1. **层构建里 `WORKDIR` 会覆盖镜像原有的**。web 的层 Dockerfile 写了 `WORKDIR /app`，而运行阶段的
   `CMD` 是相对路径 `node node_modules/next/dist/bin/next start`——容器起得来、日志里是 `MODULE_NOT_FOUND`，
   因为它在 `/app` 下找 next。**修法是把 `WORKDIR /app/apps/web` 放回层构建的最后一行**。
2. **`docker compose up -d --no-build` 之后要真的看端口**，不要只看 `ps`。三个服务都报 `Up`，而 web 是崩溃重启
   循环里的 Up。
### 1.62 更正：「已定稿的术语会挡住发布」在当时是假的，现在接上了

上一轮我在四处写下同一句话：违反 `APPROVED` 的术语是 ERROR，所以「发布校验因此自动生效，不用再改一处」。
这句话是从设计文档里抄下来的，而设计文档里的那一行写的是「QA 问题已经会挡发布」——**这个前提是错的，而我没有验证它**。

读代码的结果：`validateForRelease`（`validate_release` 工具、`POST /projects/:id/sync/validate`）自己重算四类问题
——缺译、占位符不一致、过期、开放冲突——**从不读 `qa_issues`，也从不读术语库**。于是平台同时说两件相反的话：
QA 页面上 `课程 → Course` 是红色 ERROR，而发布前校验对同一个项目回 `ok: true`。

**现在**：发布前校验自己问一遍术语库，用的是 QA 那份规则（`glossaryFindings` 从 `runQaRules` 里提出来，
两处调同一个函数——不一致在结构上就不可能）。定稿的词条违规会让 `ok: false`；草稿的会出现在报告的 `issues`
里但不阻断（`ok` 只看 ERROR），这与「草稿只警告」是同一个意思，只是这次在发布这一侧也成立。

**仍然没做**：`POST /projects/:id/releases`（真正建 release）本身不调用发布前校验。「挡」目前发生在校验那一步，
不在建 release 那一步——要在那里也挡住，得先有设计里提到的那条「带备注的例外」路径，否则是一道没有出口的墙。
这一条没有偷偷加进去，因为它改的是别人的发布流程。

**顺带把措辞改准**：所有写着「挡住发布」的地方（后台管理页面文案、MCP 工具说明、guide、docs/MCP.md）
改成「发布前校验会因此不通过」——说的和做的是同一件事，才叫文档。

**验证**：`packages/domain` 新增一条断言「发布校验走的规则与 QA 走的规则逐条相同」；集成测试新增三段
——草稿阶段报告里有这条但 `ok: true`、定稿后 `ok: false` 且 `counts.glossaryProblems > 0`、删掉词条后 `ok: true`。
474 单元 / 181 集成 / lint / typecheck 全绿。
### 1.63 候选现在带着译法：从项目自己的译文里数出来的，不是猜的

用户一句话：「候选他没抽出译法啊」。上一轮我在设计文档和页面上都写了「平台不猜译法」，理由是一句原文和它的译文
对不出其中某一个词变成了什么。**这个理由没错，但它推不出「什么都不给」**：一个已经翻了 2,795 条的项目，早就把
词库的大半答案写在自己的译文里了——`学习 → 學習` 152 条、`课程 → 課程` 116 条、`选择 → 選擇` 105 条。
数出来不是猜出来，所以改成给出建议值，并且**把证据一起给**：每个语言的值 + `152/152` 这样的计数 + 一条完整的
原文→译文例子。加入后仍是草稿，表格里每一格译法也都能点开就地改——一条改不动的建议比没有建议更糟。

新模块 `packages/domain/src/term-mining.ts`（纯函数，12 条单测）。计数会错的地方有三类，都在真实数据上撞到过、
都写成了有名字有测试的规则：

| 计数会错 | 真实撞到的样子 | 现在怎么办 |
| --- | --- | --- |
| 原文边界切错了 | `ID` 只出现在 `IDA标签` 里，计数说 `ID → IDA` 95/109 | 拉丁术语必须在译文里成词出现；粘进更长的词 = 术语切错了，不给 |
| 零件当词汇 | `%@`、`\n`、`{{count}}`、纯数字在 strings 文件里和真词一样高频 | 术语本身是机器文本就不找；候选值里的机器文本也不算 |
| 窗口切在词中间 | `ース` 和 `コース` 在三句里计数完全相同 | 片假名/韩文是分词书写的，从不成词出现的窗口不是词（中文没有这条：`課程學習` 中间没空格，粘着不代表什么） |

统计本身还有三条底线：出现少于 2 条不给、覆盖率不到一半不给、在不含该术语的键里也普遍出现（背景率 > 20%）就淘汰
——没有最后一条，`的` 和 `Please` 会赢下每一次计数。

**仍然做不到的，写在页面上了**：它数的是「与术语共现」，不是对齐。`填写` 的英文建议是 `Please`（44/76），因为含
「填写」的句子多数以 Please 开头。计数、例子、语言都摆在同一行，人一眼能判断。

顺手补上的一件：**词的译法现在能就地改**（点一下那一格）。候选带着建议值进来，如果没有地方纠正它，这个功能就是死路。

**验证**：真实项目 高研院iOS（2,795 key）上实测——`学习→學習 152/152`、`课程→課程 116/116`、`选择→選擇 104/105`、
`ID → 不给`、`%@ → 不给`；浏览器实测 15 项全过，含「候选带着项目已有的译法」「加入把那个译法写进词库」
「这个检查把写进去的又删掉」；488 单元 / 182 集成 / lint / typecheck 全绿。

两个坑：一是 `data-term` 行里第一个按钮原本是状态开关，加了就地编辑后变成了语言格子，于是检查脚本点错了地方、
报「批准无效」——**检查脚本点错东西，看起来和功能坏掉一模一样**，所以给按钮加了 `data-term-status` 这种名字锚点；
二是检查脚本里裸 `fetch` 发 POST 全 403，一开始被我读成「这些项目没有可抽的东西」——其实是缺 CSRF 双提交头。
### 1.64 候选的「加入」钉在右边；以及日志里那串 prisma:error 的真身

用户两条：候选的「加入」按钮应该固定在右边；以及贴来的一串 `prisma:error: Invalid prisma.mcpClient.update()`。

**加入钉在右边**。候选行里的例子可以是一整句，行一宽就把按钮顶出屏幕——那是这一行存在的唯一理由。现在：

- 操作列 `sticky right-0`（表头一起），横向滚动时钉在右边缘；
- 例子的**两半各自截断**（原文 11rem、译文 13rem，各自带 title 全文），而不是整行截一刀——整行截会把后半句
  切掉，而**后半句正是要判断的那个译文**。

检查脚本的这条断言改过两次，两次都是「通过了，但通过的理由是错的」：第一版在 1500px 下量，表格根本没溢出，
`按钮在右边缘` 恒真；第二版把表滚到最右边再量——滚到底时最后一列**本来就**在屏幕里，钉不钉都一样。现在量的是
**不横向滚动**时按钮是否可见（820px 窗口，`scrollLeft = 0`）——这才是「固定在右边」的意思。

**那串 prisma:error**：`mcp_clients` 在 RLS 后面，而 `apps/api/src/common/auth.ts` 记录「最后使用时间」的那个
update 是**裸的**（没进 tenant scope）→ 匹配 0 行 → Prisma 抛 P2025 → `.catch()` 吞掉了 rejection 但吞不掉
Prisma 自己打的 `prisma:error`。于是症状只有日志噪音，而**数据库里每一个 token 的 last_used_at 都是 NULL**：
`/developers/tokens` 页面对所有 token 显示「从未使用」——一个用来回答「我的 token 有没有被人用」的页面，
对所有 token 都说没有。

两处都修了：API 那条改成 `withoutTenantScope` + `updateMany`（0 行不是错误，是 token 已经不在了）；
**MCP server 那条根本没有**（`apps/mcp-remote/src/main.ts` 只查不写）——而 Agent 走的就是 MCP server 而不是 REST，
所以只修 API 等于没修。实测：只经 MCP server 用过的 token（`onboarding-…`）现在也记下了使用时间，`prisma:error` 归零。

**验证**：新增集成测试「用过的 token 会记下被用过」（改之前必然失败：断言 `lastUsedAt` 非空）；488 单元 /
183 集成 / 浏览器 17 项 / lint / typecheck 全绿。
### 1.65 MCP 补上 `extract_glossary_candidates`：设计里写了、实现时漏了的那一个

用户问「术语库支持 MCP 提取吗」。答案是分两半的：**读出来支持**（`get_glossary`），**抽候选没有**——
而 `docs/TERMBASE.md` §6 的接口面里明明写着 MCP 要有 `extract_glossary_candidates`。上一轮我只做了写工具
`upsert_glossary_terms`，这条没做，而且 §9 的状态表里**也没列它**——漏掉的东西没被记成 ❌，等于把它藏起来了。
比漏做更糟的是漏记。

**顺手把抽取搬进了 domain**（`packages/domain/src/term-extraction.ts`）。理由不是洁癖：MCP 不能抄一份
（这是全平台最贵的一次读——最多 5,000 个 key，每个 key 上抽短语，再对每条译文数一遍），而且「两个入口给出
不同答案」这件事在术语库上是最不能接受的。现在 REST 的 `POST /glossary/extract` 与 MCP 工具调的是同一个
`extractTermCandidates`，路由只剩一行。

工具本身：`extract_glossary_candidates`（第 21 个），scope `glossary.read`，**只读**——什么都不写，
要落成术语用 `upsert_glossary_terms`。它存在的主要理由是**提之前先问**：一个和 152 条既有译文相矛盾的提议
比不提更糟。描述里也写清了它数的是共现而不是对齐。

**顺带补上了短语抽取器的第一组单元测试**。它此前只在浏览器检查里被端到端跑过，所以「英文项目一个候选都抽不出」
那个 bug（窗口按三个词的步长跳，跨边界的两个窗口永远试不到）能活下来：中文项目能抽出二十个，看起来一切正常。
现在钉住了「每个窗口都试」和「标点与空白不能当术语」两条。

**验证**（都在容器栈上）：部署后的 MCP server `tools/list` 21 个、含新工具；真实项目 高研院iOS 上调用——
`课程 116条 → zh-TW 課程 116/116`、`您的 91条 → zh-TW 您的 91/91 · en-US your 66/91`；
新增集成测试「MCP 抽出来的词表与 REST 一致」；短语抽取器 10 条单测；498 单元 / 184 集成 / 浏览器 17 项 /
工具页 11 项 / lint / typecheck 全绿。
### 1.66 从文档读回数据库：译文一直支持，术语库补上了 `import_glossary_terms`

用户问「支持从文档读回数据库吗」。答案分两半：**译文支持**（CLI `scan` 用适配器读 `.strings`/`.xcstrings`/Android XML/`.po`/`.xliff`/JSON/YAML/CSV/XLSX 再 push；MCP `import_translations` 收已解析的条目；反方向 `GET /export` + release bundle）；
**术语库不支持**——只有 `POST /glossary/import`，要的是排好的 JSON，Excel/TBX 得自己先转，MCP 连这个都没有。这正是设计文档 §4 ③ 里写着的那条。

用户选了**只走 MCP 一个入口**，并要**默认草稿、导入者可勾选直接定稿**。于是：

**`import_glossary_terms`（第 22 个工具，scope `glossary.write`）**：收**已解析的词条，不是文件**——和 `import_translations` 同一个道理，平台看不见调用方的磁盘，Excel/TBX 由调用方自己解析，这不是要绕开的限制，是整个产品立在上面的那条界线。按 term 覆盖、重复导入不重复；`status` 默认 `DRAFT`，写 `APPROVED` 需要 `PROJECT_MANAGER`（**从侧门定稿也是定稿**）；已定稿的词条不被草稿导入改写，出现在 `untouched` 里。

**顺手修了 REST import 的两个真问题**（同一个入口的另一半，不改就是两套行为）：

- **事务预算是 5 秒**：`POST /glossary/import` 允许一次 2,000 条，而它用的是默认的 5 秒事务——调用方决定行数，预算却不是。`withOrganizationBulk`（60 秒，可用 `BULK_TRANSACTION_TIMEOUT_MS` 调）早就为这种调用存在，译文导入走的就是它，术语导入漏了。
- **导入写进一条被关掉的词条里，是静默无效的**：项目里可以有一条 `disabled: true` 的行（在本地关掉组织级词条），导入时 `data` 里没有 `disabled`，于是译法写进去了、词条仍然关着——导入成功但什么也没发生。现在导入会把这个标志清掉：**导入一个术语就是在定义它**。

**验证**：真实栈上调用——`created: ["Probe Alpha","Probe Beta"]`、再导入同一条 → `updated: ["Probe Alpha"]`（没有留下两条）、`status: APPROVED` 的导入也通；
新增 5 条集成测试（草稿导入、重复导入不重复、草稿改不动已定稿、译者能提不能定、关掉的词条被导入重新打开）；498 单元 / 188 集成 / 22 个工具页 / lint / typecheck 全绿。

两处我自己的测试错误，都值得记，因为**它们都会让测试通过而其实什么都没测**：

1. 第一版「译者不能定稿」是用**管理员的 session** 签发译者 token 的——`POST /mcp-tokens` 把 token 记在调用者名下，于是那个"译者"是个换了标签的管理员，断言 `isError` 拿到 `undefined` 才发现。
2. 顺着这条查下去还发现一个产品事实：**`POST /mcp-tokens` 要求 PROJECT_MANAGER，所以译者根本拿不到 token**。测试里那条 token 因此是直接种进库的（用真实的 `hashToken`），它代表的其实是**一个管理员被降权之后**的情形——也是低权限者唯一能碰到工具的方式，而角色是每次调用校验的，所以这恰恰是值得钉住的用例。
### 1.67 又见 CSRF：这次是我自己把配置弄丢的——`docker compose` 少了一个 `--env-file`

用户报「又出现这个 CSRF_VERIFICATION_FAILED: Origin http://192.168.200.172:3000」。上一轮修过（把 LAN 地址加进 `CORS_ORIGINS`），
所以先问的是「修的东西为什么没留住」。

**根因，两个，第一个是我的错。** `localehub.env` 里有 `CORS_ORIGINS=http://localhost:3000,http://192.168.200.172:3000`，
而 `compose.yaml` 写的是 `CORS_ORIGINS: ${CORS_ORIGINS:-http://localhost:3000}`——**插值只读 shell 环境或 `--env-file` 指定的文件**。
README 教的是 `docker compose --env-file localehub.env up -d`，而我这一轮所有重启都是裸的 `docker compose up -d --no-build api worker mcp-remote`：
**每一次都在把 `localehub.env` 里的全部配置换成默认值**（CORS 来源、AI provider、存储设置……），而且什么都不说，直到有人从别的机器打开页面。

**第二个是设计上的脆弱**：就算配置对了，自建部署的地址是会变的（换机器、换网段、加个主机名），
而白名单只能猜。所以顺手做了更根本的一层：`trustedOrigins` 现在还信任**这次请求实际被访问到的那个 host**
（先看 `x-forwarded-host`，再退回 `Host`）。这不是给攻击者开的口子——`Origin` 和 `Host` 是浏览器分别设置的，
`evil.example` 上的页面发到这台主机的请求，`Origin` 就是 `https://evil.example`，两者必须相等才放过；
页面没法声称一个它没发过去的 `Host`，也没法在预检被拒的情况下设 `x-forwarded-host`。实测：

| 请求 | 结果 |
| --- | --- |
| `Host` 与 `Origin` 都是 `192.168.200.172:3000`（别人从局域网登录） | 通过（原来是 403） |
| 同一个 Host，`Origin: https://evil.example` | 403，仍然拒绝 |
| `Host: localhost:3000` 而 `Origin` 是 LAN 地址 | 403（不匹配就得拒） |

**修完才敢说的另一件事：`AI_DEFAULT_POLICY` 一直是 `hybrid`，而 `hybrid` 不是 provider。**
读 `createProvider` 会发现它只认 `pi | anthropic | ollama`，别的值——包括 schema 默认和 `env.example` 里的 `hybrid`——静默落到
`HeuristicProvider`：离线、只做术语替换、其余原样返回原文。也就是说**按文档配出来的部署，AI 翻译其实没在翻译，而且从不吭声**。
一天之内撞到两次同一类问题（「看着配好了，其实没有」），所以这次把它做成会响的：无法构造出请求的 provider 时，
**启动后第一次用到时警告一次**，说清是哪一个值、缺了哪个前置条件、以及落到的是启发式。`env.example` 也改成列出四个真实取值并把 `hybrid` 标成错的。

**`scripts/up.sh`**：唯一入口，永远带上 `--env-file localehub.env`；`README`、`docs/DEPLOYMENT.md`、`scripts/init-db.sh` 里
所有教人跑 `docker compose` 的地方都改成它。本机 `localehub.env` 的 `AI_DEFAULT_POLICY` 也从 `hybrid` 改成 `pi`（该文件被 gitignore，不进仓库）。

**验证**：局域网地址模拟登录通过、攻击者来源仍 403；部署栈上 `POST /ai/translate` 返回 `provider: "pi"`（不是启发式）；
503 单元（新增 5 条：代理转发的 host 被信任、跨站仍被拒、`hybrid` 警告一次且指名、缺 key 时说明缺哪个、显式 heuristic 不吭声）
/ 188 集成 / 浏览器检查 / MCP 检查 / lint 全绿。
### 1.68 pi 是怎么装上的：一层全局安装 + 一条挂在 node_modules 里的路径（以及它是怎么"碰巧能用"的）

用户问「pi 他是怎么安装的」。查完发现答案里有三件事，其中一件**不是有意设计的**：

1. **pi 本体是全局安装**：`npm i -g @earendil-works/pi-coding-agent`——**一个包同时提供 `pi` 命令行和 SDK**
   （本机 v1.5.2，`pi` 在 PATH 上，走 nvm 的 global node_modules）。凭据和模型目录在 `~/.pi/agent`。
2. **平台按裸模块名加载它**：`packages/domain/src/ai.ts` 用真正的动态 `import('@earendil-works/pi-coding-agent')`
   （这包是 ESM，CommonJS 编译会把 `await import` 改写成 `require`，所以 specifier 藏在字符串里）。
3. **但它不是 workspace 的依赖**，而且现在**故意不是**：这个包 **153 MB**（里面是一整个终端 agent），
   写进 `package.json` 会让每次 `pnpm install`（含 CI 与镜像构建）都为它买单。

于是两条路各自成立、也各自脆弱：

| 在哪跑 | 现在靠什么找到 SDK |
| --- | --- |
| 容器（部署栈） | `compose.override.yaml` 把宿主机的全局 `@earendil-works` **只读挂**进 `/app/node_modules/@earendil-works`。这条是可靠的 |
| 宿主机（本地跑 API / 集成测试会起本地 API） | **靠一个残留的符号链接**：`packages/domain/node_modules/@earendil-works/pi-coding-agent` → nvm 全局目录，是我当初那次被网络掐断的 `pnpm add` 留下的，文件时间 11:07 |

也就是说：**换一台机器 clone 下来，宿主机这条路是不通的**——没有任何声明、没有那个链接，只有容器里的挂载能救。
运行时报错文案会说是哪个 provider 加载不到，但让人去 `pnpm add` 一个 153 MB 的包并不是好答案。

**修法**：新增 `PI_SDK_PATH`——指向这台机器**已经装好的那份 pi**（给目录就用它的 `dist/index.js`，
给文件就按文件加载）。不设时行为完全不变（裸模块名）。同时：

- 报错文案改成先让人设 `PI_SDK_PATH`（并给出 `$(npm root -g)/@earendil-works/pi-coding-agent` 这个写法）；
- `env.example` 与 `docs/MCP.md` 的 pi 一节改写成上面那张三条路的表，并写清「为什么它不是依赖」；
- 4 条单测钉住 specifier 的四种输入（不设 / 空串 / 目录 / 文件）。

**验证**：用 `PI_SDK_PATH` 指向本机那份 pi，路径形式能加载到真的 `createAgentSession`；
容器栈上 `POST /ai/translate` 对一个 ja-JP 条目真的跑了模型——**3.9 秒**返回 `カートは空です`（provider `pi`），
启发式不可能花 3.9 秒也不可能给出这个句子。507 单元 / lint 全绿。

**没有删那个残留链接**：本地跑 API 和集成测试现在仍靠它，删掉等于让本地静默退回启发式。
它现在是多余的（`PI_SDK_PATH` 覆盖了这个场景），但没有害处——记在这里，免得下次有人看到它以为是设计。
### 1.69 更正：pi 的 SDK 现在**是**依赖了——1.68 里那个「153 MB，所以不该声明」是错的

用户看完 1.68 直接问「不是应该加到依赖吗」。对。我去量了自己引用的那个数字，发现**量错了东西**：

| 我当时说的 | 实际 |
| --- | --- |
| 「这个包 153 MB」 | 153 MB 是**整个全局安装目录**，其中 127 MB 是它自己的依赖树（那些依赖由包管理器本该装） |
| | 发布包 `dist.unpackedSize` = **24.8 MB**。这是个普通依赖的大小 |

**结论也因此是错的**：代码 `import` 了一个没有任何 `package.json` 声明的包，只靠「宿主机上一个残留的符号链接 + 容器里一个挂载」凑合用；
而我用「太大了」去为一个隐藏前置条件辩护——那个数字还是错的。这正是这几天反复在修的那类问题（"看着配好了，其实没有"）。

现在 `@localehub/domain` 的 `optionalDependencies` 里写着 `@earendil-works/pi-coding-agent`，`pnpm install` 就会装，
`pnpm-lock.yaml` 里钉着版本。**为什么是 optional 而不是普通依赖**：只有一种情形不同——Registry 取不到时，
普通依赖会让整个 workspace 装不上，而这条路本来就有明确的运行时错误（说清设哪个变量）和 `PI_SDK_PATH` 兜底。
这个取舍写在 docs/MCP.md 的 pi 一节里，不是一个只有我知道的决定。

**换版本这件事本身要验**：全局装的是 1.5.2，声明后 workspace 装到的是 **1.6.0**，而此前所有「pi 能用」的验证都是对着 1.5.2 做的。
所以按 `ai.ts` 实际用到的那几个接口（`createAgentSession` / `ModelRuntime.create` / `SessionManager.inMemory` / `prompt` /
`getLastAssistantText`）在 workspace 里跑了一遍真的：模型解析成功，返回 `カートは空です`。**声明之后，宿主机那条路第一次是"装上就有"，
不再是碰巧。**

**验证**：`pnpm install --frozen-lockfile --offline` 通过（CI 一致性）、`pnpm-lock.yaml` 里有它（3 处）、
16 个包 typecheck 通过、507 单元、lint 全绿。顺带说明：`PI_SDK_PATH` 保留，但角色变了——从「没有它就不通」变成
「想用这台机器已装的那份（省一次 24.8 MB、或跟着全局版本走）时的覆盖开关」。
### 1.70 只留 pi：删掉 anthropic、ollama 和那个离线启发式，以及两张"配了等于没配"的表面

用户：「不需要其他 只需要pi」。查完依赖面之后删的东西比三个 provider 多——都是同一类问题（看着像配置，其实没有作用）：

| 删掉 | 为什么 |
| --- | --- |
| `AnthropicProvider` / `OllamaProvider` | 机器上已经有 pi（自带供应商与凭据），再多一把要分发的 key、一份要解释的账单，换不到什么 |
| `HeuristicProvider` | 它不是"备选 provider"，是**假产出**：把术语替换过的原文当译文返回。没有 pi 的部署现在拿到的是指名道姓的错误，而不是一份看着像译文的原文 |
| `AI_DEFAULT_POLICY` | 只剩一个 provider，没有可选的策略；而它的默认值 `hybrid` 根本不是 provider |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OLLAMA_BASE_URL` | 前两个所配的 provider 没了；`OPENAI_API_KEY` **从来没有任何代码读它** |
| `GET /ai/providers` + `ai_provider_configs` 表 + `AiProviderKind` 枚举 | 迁移 `20261123000000_drop_ai_provider_configs`。这张表**没有任何写入方、一行数据都没有**，却列着 anthropic / openai / azure_openai / ollama / custom 五种这个平台没有的 provider |

**删之前先确认过没人用**：`grep` 全仓（含 web、e2e-demo、cli）只有三处引用——provider 自己的实现、配置 schema、它自己的测试；
**测试与演示都没有真的调过 AI 起草**，所以删掉启发式不会连累 CI 或离线 demo。

**留下的一个字段**：`provider` 仍然在 REST 与 MCP 的 schema 里，但类型收成 `z.literal('pi')`。旧调用方传 `anthropic`
会拿到 `VALIDATION_ERROR: Invalid literal value, expected "pi"`，而不是被静默换成别的模型——实测：

| 调用 | 结果 |
| --- | --- |
| 不传 provider | 201，`provider: "pi"`，3.6 秒，返回 `カートは空です` |
| `provider: "pi"` | 201 |
| `provider: "anthropic"` | **422** `VALIDATION_ERROR`，指名要求 `pi` |
| `GET /ai/providers` | **404** |

**删设置项还有个尾巴**：不在 schema 里的环境变量 zod 会直接忽略，也就是说"升级后 env 里还留着 `AI_DEFAULT_POLICY=anthropic`"
会**静默**变成 pi。我在 `env.example` 里先写了"会响亮地失败"，随即发现那是假的——所以改成让它真的响：
`loadEnv` 现在会检查这四个名字是否还在环境里，在就打印一行说它们不再起作用。本机 `localehub.env` 与 `compose.override.yaml`
里的那行已删除。

**验证**：505 单元 / 188 集成 / 浏览器检查 / lint / typecheck 全绿；`docs/openapi.json` 重新生成（83 paths，少了一条）。
## 附：最终验证记录（本文件写入后重跑）

| 命令                                             | 结果                                    |
| ------------------------------------------------ | --------------------------------------- |
| `pnpm -r typecheck`                              | 全部 17 个 workspace 项目通过           |
| `pnpm lint`（`eslint . --max-warnings 0`）       | 0 error / 0 warning                     |
| GitHub Actions `CI`（main）                      | **通过**（Run 5）                       |
| Local / Remote MCP 真实客户端握手                | 通过（见附二）                          |
| 端到端演示连续两次运行                           | 均通过（demo 自带项目清理，可重复执行） |
| `pnpm test`                                      | 217 passed                              |
| `pnpm test:integration`                          | 132 passed                              |
| `node apps/e2e-demo/dist/run-demo.js`            | ALL ACCEPTANCE CHECKS PASSED            |
| `docker compose config`（含 production overlay） | valid                                   |
| `docker compose up -d --build`（整套栈）         | 5 个服务全部起，浏览器实测 24/24        |
| `docker buildx build --network host`             | api / web 镜像均构建成功（见下方说明）  |
| 容器栈上的 MCP 写入 → 审计页（无头 Chrome）      | 通过：`/settings/audit` 的「Agent 操作」筛出 100 行，每行标出 Token 名与前缀 |
| `/mcp` 教程页第五步（无头 Chrome）               | 通过：5 个步骤、闭环说明与 `translation_version_id` 提示均渲染，无溢出     |
| `docker build -f docker/api.Dockerfile .`        | 见下方说明                              |

Docker 镜像构建第一次因 Dockerfile 在 `prisma generate` 之前编译 `packages/database` 而失败
（`@prisma/client` 尚无导出），已修正构建顺序（先生成 Prisma Client，再编译）。修正后的构建结果
见仓库根目录最后一次 `docker build` 输出；若网络受限导致依赖下载失败，请在网络可用环境重试：

```bash
docker build -f docker/api.Dockerfile -t localehub-api:local .
docker build -f docker/web.Dockerfile -t localehub-web:local .
```

两个镜像均已成功构建并运行验证。首次 Web 重构建曾在下载 `@next/swc-linux-arm64-*` 时遇到
`ECONNRESET`，重试后完成；这是网络抖动，不是代码问题。

**本轮又踩了同一个坑，顺手把它修掉**：BuildKit 报 `apk add` 的包「masked in: --no-network」，
旧版构建器能连网但 `pnpm install` 反复在 640–660/664 处被 registry 掐断。两处改动：

1. `docker/api.Dockerfile` 的 `deps` 阶段原本 `COPY packages ./packages`（**整个源码树**），
   于是改一个 `.ts` 文件就会让依赖层失效、重下整棵依赖树。现在只 COPY 各包的 `package.json`
   ——这一层从此与源码无关，重构建只跑编译。
2. 两个 Dockerfile 的 `pnpm install` 都加上 `--fetch-retries=10 --fetch-timeout=600000`。
   默认重试 2 次，对「只是慢」的 registry 等于放弃。

网络本身仍不通 BuildKit 的默认网络（容器里 `curl` 25 秒只下到 5 MB），所以构建命令是：

```bash
docker buildx build --network host -f docker/api.Dockerfile -t localehub-api .
docker buildx build --network host -f docker/web.Dockerfile -t localehub-web .
```

## 附二：MCP 传输层实测

平台只有一个 MCP，下表的「工具」一列是它的 19 个平台工具；本地动作在 CLI 里，另表列出。

| 验证                                                | 结果                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Remote MCP（Streamable HTTP）被真实 MCP Client 连接 | `connected: localehub-remote 0.1.0`                                                             |
| Remote MCP 工具数                                   | 19（规格 §6.4 的 15 个 + `create_project` / `import_translations` / `mark_applied` / `upload_screen_mockup`，见 §1.27、§1.29、§1.35） |
| MCP 是否校验 Token scope                            | 是：`REMOTE_MCP_TOOL_SCOPES` 在包装层统一断言，映射逐条对齐 REST（集成测试断言，见 §1.29）      |
| MCP 是否教怎么用                                    | 是：`instructions` + `localehub://import-guide` + `import-localization-files` 提示词 + 字段级描述（见 §1.30） |
| 仓库有、平台没有的语言                              | 自动新增并报告；等价标签归入已有语言（`zh-Hans` → `zh-CN`）；歧义则拒绝（见 §1.31） |
| MCP 写入是否进审计                                  | 是：7 个写工具写 `audit_logs`，`actor_type='mcp'`，只读与 dry-run 不写（集成测试断言，见 §1.28） |
| `mark_applied` 闭环（容器栈实测）                   | 通过：pending → dry-run（不建 session）→ 确认（建 session）→ 平台不再下发 → 审计有 `sync.apply` |
| 只带 `project.read` 的 Token 调 `import_translations` | 被拒（`SCOPE_INSUFFICIENT`）——修复前实测可写库，见 §1.29                                    |
| 只带 `sync.push` 的 Token 调 `mark_applied`         | 被拒（`SCOPE_INSUFFICIENT: translation.apply`）                                              |
| Remote MCP 是否暴露本地文件工具                     | 否（检查 `read_local_file` / `write_local_file` / `read_file` / `exec` 均不存在）               |
| `list_projects` / `get_project_sync_status`         | 正常返回                                                                                        |
| Remote MCP Resources / Prompts                      | 8 / 8（`qa-rules` + `import-guide` + `skills` + `skills/{slug}` + 3 个 Skill resource；3 内置 + 5 Skill prompt） |
| `localehub://skills/{slug}`                         | 返回完整 `SKILL.md`（含 frontmatter），`text/markdown`                                          |
| 未发布 slug 的 resource 读取                        | 被拒绝（`NOT_FOUND`），不是返回空文档                                                           |
| `/mcp/tools` 声明的 resource 与 prompt              | 与上面实测逐条一致（集成测试断言，非人工比对）                                                  |

本地动作（CLI，不经过 MCP）：

| 验证                                        | 结果                                                    |
| ------------------------------------------- | ------------------------------------------------------- |
| `localehub info`                            | 返回配置、workspace root、项目、apiUrl、Git 状态        |
| `localehub scan`                            | `scanned 2 file(s), 6 entr(ies), locales: en-US, ja-JP` |
| `localehub sync preview` / `push --confirm` | 走通（见验收脚本 A–E）                                  |
| `localehub mcp-config`                      | 输出单条 `localehub-remote`，URL 由平台报告             |
| `apply --confirm`                           | 备份 + 原子写 + 重解析校验（24 个 workspace 测试）      |

修复记录：Remote MCP 最初把数组作为 `structuredContent` 返回，被 MCP 客户端以
`-32602 Invalid tools/call result` 拒绝；已在两个 MCP 服务端统一做「数组包装为 `{items}`」规范化。
`apps/mcp-remote` 缺少 `reflect-metadata` 运行时依赖也已补上。

## 附三：本次交付中发现并修复的问题

| 问题                                                                     | 影响                                               | 修复                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| 归档动作映射颠倒（`ARCHIVE_CANDIDATE` / `REMOTE_ARCHIVE_CANDIDATE`）     | 本地删除会被误判为远端删除                         | 交换两处返回值并补分支测试                                                     |
| YAML 补丁丢失注释                                                        | 回写会破坏 YAML 文件注释                           | 改用 `yaml` 的 Document API                                                    |
| JSON 新增嵌套 Key 时空节点不存在                                         | 新增 Key 报错                                      | 递归创建中间对象                                                               |
| JSON 插入点落在收尾换行之后                                              | 生成非法 JSON（逗号独占一行）                      | 插入点回退到末尾空白之前                                                       |
| 认证查询未走特权路径                                                     | RLS 导致登录/Token 校验查不到 membership           | 统一走 `withoutTenantScope`                                                    |
| `getChanges` 用 `array_contains` 过滤 JSON 字符串                        | 平台变更永远拉不到                                 | 移除 SQL 过滤，改为应用层按 locale 过滤                                        |
| 新版本未清空 `applied_to_repo_at`                                        | 已应用的条目标记污染新版本，pull 过滤掉真实变更    | 仅仓库推送才标记为已应用                                                       |
| 冲突解决写回使用扁平字段缺失                                             | 解决冲突后平台值不更新                             | 补齐 `baseValue/localValue/remoteValue`                                        |
| 冲突解决的 Key 查询忽略 namespace                                        | 带 namespace 的项目无法写回                        | 通过 namespace 行再查 Key                                                      |
| Remote MCP 返回数组作为 `structuredContent`                              | MCP 客户端报 `-32602`                              | 两个 MCP 服务端统一包装为 `{items}`                                            |
| `apps/mcp-remote` 缺少 `reflect-metadata`                                | 远程 MCP 无法启动                                  | 补依赖                                                                         |
| AuthGuard 把 `params.id` 当 projectId                                    | 项目级成员（组织角色为 READONLY）被误拒            | 仅在路由确有 projectId 时做项目级角色判断，其余由服务层显式断言                |
| 缺少 `DELETE /projects/:id`                                              | 无法清理项目，演示不可重复                         | 新增删除端点（需 `confirmName` 二次确认）                                      |
| Dockerfile 在 `prisma generate` 前编译 database 包                       | 镜像构建失败                                       | 调整构建顺序                                                                   |
| Docker runtime 阶段只拷贝部分目录                                        | 容器内 `MODULE_NOT_FOUND`                          | 拷贝完整构建产物                                                               |
| Web 容器用 corepack 启动 pnpm                                            | 启动时联网下载 pnpm 导致启动失败                   | 直接执行 next                                                                  |
| Web 容器 `next start` 工作目录为 `/app`                                  | 找不到 `.next`，容器无法启动                       | 运行时 `WORKDIR /app/apps/web`                                                 |
| `POST /projects` 的角色校验从未生效（任何成员可建项目）                  | 只读成员也能创建项目                               | service 内补 `assertRole(actor,'',PROJECT_MANAGER)` + 集成回归测试（见 §1.15） |
| `POST /projects/:id/members` 可绕过全部成员守卫                          | 项目级 PM 能把外部用户拉进组织并给更高组织角色     | 删除该路由（无调用方），回归测试断言 404（见 §1.16）                           |
| `LOCALEHUB_API_URL` 覆盖被静默丢弃                                       | 所有调用方都在和 config 文件里的地址通信           | 移到 `LocalSyncServices.config()`（见 §1.12）                                  |
| 去掉 Local MCP（用户决定）                                               | 两个 MCP 意味着版本/能力无法统一管理，发现接口失真 | 删除 `apps/mcp-local`；引擎移到 `packages/local-sync`，由 CLI 驱动             |
| `/mcp/tools` 声明了 6 条未实现的 resource 与 1 个已删除 Server 的 prompt | 发现接口高估能力                                   | 资源/prompt 清单进契约，集成测试断言「声明 == 实际注册」                       |
| 浏览器端硬编码 API 主机                                                  | 反向代理部署下前端打不到 API                       | 未配置 `NEXT_PUBLIC_API_BASE_URL` 时回退到同源 `/api/v1`                       |
| MCP 的写入不写审计（`audit_logs` 对 Agent 全盲）                         | 审计页看不到任何 MCP 操作，无法追溯、无法撤销对应 Token | 抽 `packages/domain/src/audit.ts`，六个写工具补审计 + 8 单元 / 2 集成测试（见 §1.28） |
| 容器（卡片、面板）画在自己的子元素之上，草图是一张空卡片 | 位置全对但画面里什么都没有，几何测试看不见 | 渲染改成「先所有面（按深度）再所有内容」+ 2 条叠放次序测试（见 §1.40） |
| 组件名写在 class 里就不认识（`<div class="card">`、`<div class="tabbar">`） | 卡片只是「有背景的分组」，标签栏完全画不出 | 分类先看组件名（标签或类名任一处），只有剩下的按标签归类（见 §1.41） |
| 没有文案的控件被清理逻辑整棵剪掉（`<input type="checkbox">`） | 设置页只有标签、旁边没有开关 | `switch`/`slider`/`image`/`icon`/`divider`/`input` 即使无文案也保留（见 §1.41） |
| 贴底的标签栏被当成普通子节点，排在内容之后 | 内容一长它就被挤到折叠线以下 | 排版分两段：定出画布高度后再把贴底栏放到 `画布高 - 栏高`（见 §1.41） |
| 单个英文单词的文案被 `looksLikeUiText` 判成类名丢掉（`Checkout`/`Cancel`/`Settings`） | 页面标题只有一个词的页面留下没有标记的空洞 | 标点判 id/类/路径、全小写带连字符或数字判工具类，其余当文案（见 §1.40） |
| `aria-label={label}` 这类表达式属性被读成文案 | 草图里多出「label」这种变量名标记 | 属性值的字面量与表达式分开，表达式不读（见 §1.40） |
| `<script>` / `<style>` 的内容被当成界面文案 | 内联脚本产生文字为 `const x = 1` 的标记，样式表产生 CSS 标记 | 解析前剥掉脚本与注释，样式只读颜色（见 §1.40） |
| 草图是一套灰阶线框，认不出是哪个页面 | 「这句话在哪个界面」仍然要译者猜 | 节点带 `style`、渲染器按页面颜色画、样式从源码读（见 §1.40） |
| MCP 教程只教手画草图（`instructions` / 导入指南 / 提示词都没提 `ui`）                | 照教程做的 Agent 会去画图量坐标，`ui` 输入形同不存在 | 改 `instructions`、新增 `localehub://screen-sketch-guide` 与 `upload-screen-sketch` 提示词（见 §1.38） |
| 指南与文档让 `ui` 只传 `root`，schema 却把 `ui.name` 设成必填                          | 照抄教程的第一个调用方被 `Required at ui.name` 拒收   | `ui.name` 改可选且忽略（平台从不读它）+ 回归测试校验教程里的示例（见 §1.38）                       |
| `ui` 渲染忽略调用参数里的 `platform`，画布固定按 web 尺寸                              | iOS 屏幕被画在 1280×800 画布上                        | `resolveMockupInput` 增加画布回退参数，两个入口都传（见 §1.38）                                    |
| MCP 完全不校验 Token scope（只有 `project.read` 也能写库）               | 规格 §2.2 的 scope 分离在唯一依赖它的入口上失效，默认 Token 能把平台变更标记为已落地 | 契约里声明 `REMOTE_MCP_TOOL_SCOPES`，`define` 包装层统一断言 + 5 单元 / 1 集成测试（见 §1.29） |
