# 5 分钟快速上手

## 1. 起服务

```bash
pnpm install
pnpm db:up                 # postgres:55432 / redis:56379
pnpm db:migrate
pnpm db:generate
pnpm -r build
pnpm db:seed
pnpm dev:api &             # :3001
pnpm dev:web &             # :3000
```

浏览器打开 http://localhost:3000 ，用 `demo@localehub.dev` / `demo-password-123` 登录。

`pnpm db:seed` 会创建组织、5 种角色的用户、一个 Demo App 项目与示例译文。Web 端不需要配置 API 地址：
它默认走同源 `/api/v1`，由 Next 的重写转发到 API（部署时由 nginx 承担同一职责）。

**加人**：平台不开放自助注册，也没有邀请邮件。用组织所有者 / 管理员登录后进「组织设置 → 组织成员」，
直接创建账号（邮箱 + 姓名 + 初始密码 + 角色），再把凭据通过安全渠道交给本人；忘了密码由管理员在同一个
页面重置。`/auth/register` 只在实例一个用户都没有时可用，用于首次引导（或用 `pnpm db:seed`）。

## 2. 看端到端闭环（不接真实仓库）

```bash
node apps/e2e-demo/dist/run-demo.js
```

输出会逐条打印 A–E 五个场景的检查结果，最后是 `ALL ACCEPTANCE CHECKS PASSED`。

## 3. 接自己的仓库

```bash
cd /path/to/your/repo
node /path/to/localehub/apps/cli/dist/bin.js init \
  --project <project-id> \
  --api http://localhost:3001/api/v1 \
  --source-locale en-US \
  --locales ja-JP,zh-CN

# 在平台「开发者 → API / MCP Token」签发一个含 sync.push + translation.apply 的 Token
export LOCALEHUB_TOKEN="lh_mcp_..."

# init 生成的是通用模板，paths 默认指向 `locales/**`。改成你仓库的真实布局，
# 否则 scan 会报 0 file 并列出 UNMAPPED_FILE —— 它不会猜你的目录结构。
node /path/to/localehub/apps/cli/dist/bin.js info      # 看 mappings 解析成了什么
# 编辑 .localehub/config.yaml: files[].paths 与 workspace.allowWrite
node /path/to/localehub/apps/cli/dist/bin.js scan
node /path/to/localehub/apps/cli/dist/bin.js sync preview
node /path/to/localehub/apps/cli/dist/bin.js sync push --confirm
```

然后在平台修改并审核译文，回到仓库：

```bash
node /path/to/localehub/apps/cli/dist/bin.js pull --locale ja-JP
node /path/to/localehub/apps/cli/dist/bin.js apply preview
node /path/to/localehub/apps/cli/dist/bin.js apply --confirm --apply-plan <id>
git diff          # 只应包含预期的语言文件条目
```

## 3.5 仓库里的 `.localehub/`

`localehub init`（或让 Agent 用 `create_project`）会在仓库里建一个 `.localehub/`，它是仓库与项目的对应关系所在：

| 文件 | 提交吗 | 内容 |
| --- | --- | --- |
| `config.yaml` | **要** | project id、语言目录、端点映射、workspace 白名单。没有它，换台机器／换个人就接不上 |
| `mockups/*.html` + `*.json` | **要** | 整页复刻生成的页面（`--page` 指到一整页 `.html` 时），加同一份说明。浏览器照它渲染，标记由浏览器实测 |
| `mockups/*.svg` + `*.json` | **要** | `localehub mockup --page` 生成并上传的那张图，加一份说明（哪一页、多少标记、平台的校验和）。审查 PR 时能看到 Agent 往平台上放了什么；图或页面变了就重跑一次，别手改 |
| `state.json` | 不要 | 本机的同步游标与历史（已 gitignore） |
| `backups/` / `cache/` / `patches/` / `*.local.yaml` | 不要 | 本地回滚、缓存、本地覆盖（已 gitignore） |

只用 MCP 不跑 CLI 的 Agent 也应该把上传的东西写进 `.localehub/mockups/` 并提交：平台的改动在仓库里要留痕。

## 4. 在 Claude Code / Cursor 里用

把 `docs/MCP.md` 中的 `.mcp.json` 片段放到仓库根目录（只有一条远端条目，不需要在仓库里装东西），
重启客户端。读写仓库用 CLI，让 Agent 用 Bash 调它：

> 用 localehub 扫描这个仓库，先预览同步计划给我看，我确认后再推送。

Agent 会依次跑 `localehub info` → `localehub scan` → `localehub sync preview`，
并把计划展示出来；只有你说"确认"之后才会跑 `localehub sync push --confirm`。

**想让翻译编辑器里看到UI 页面**（译文旁边并排显示界面、点标记跳到对应译文），让 Agent 从页面代码
生成即可——不需要截图，也不需要手量坐标：

> 用 `localehub mockup --page src/app/projects/page.tsx --name 项目列表` 生成 UI 页面给我看，
> 确认后再加 `--confirm` 提交。

它会读这个页面的元素结构和界面文案，画出 SVG，并给每个字符串一个位置标记；页面改了就再跑一次。
详见 `docs/MCP.md` §2.10。

## 5. 常见问题

| 现象                                                           | 原因 / 处理                                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `CONFIG_INVALID: No .localehub/config.yaml found`              | 在仓库根目录执行 `localehub init`，或用 `--workspace` 指定路径                            |
| `INVALID_TOKEN`：Environment variable LOCALEHUB_TOKEN is empty | 导出 Token；配置里的 `tokenEnv` 可改名                                                    |
| `PATH_NOT_WRITABLE`                                            | 目标路径不在 `workspace.allowWrite` 或不在 `files` 映射内                                 |
| `SYNC_PLAN_EXPIRED`                                            | 预览超过 30 分钟（`SYNC_PLAN_TTL_SECONDS`），重新 `preview_sync`                          |
| `REVISION_MISMATCH`                                            | 预览后平台被别人改过，重新预览                                                            |
| `APPLY_REJECTED_STALE_PREVIEW`                                 | 预览后本地文件被改过，重新 `preview_apply`                                                |
| `NOT_APPROVED` 条目                                            | 平台译文没有审核通过；让审核人批准，或显式 `include_drafts`                               |
| `POLICY_VIOLATION`（`allowDraftApply`）                        | 组织未开启草稿回写。到「组织设置 → 同步安全策略」开启，或 `PATCH /organization/settings`  |
| `RATE_LIMITED`                                                 | 触发了限流；响应头 `Retry-After` 给出等待秒数                                             |
| `CSRF_VERIFICATION_FAILED`                                     | 用 Cookie 认证的写请求缺少 `X-CSRF-Token`。脚本请改用 Bearer Token，不要复用浏览器 Cookie |
| `SCOPE_INSUFFICIENT`                                           | Token 缺少 `sync.push` 或 `translation.apply`；重新签发                                   |
