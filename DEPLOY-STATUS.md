# agent2api（我们自己的副本）：现状与交接

> 本文档面向「接手继续开发的人/会话」。所有事实都经 2026-09-28 实测核对，不是推测。
> 相关自动化知识另见用户级 skill `agent2api-deploy`。

---

## 1. 这是什么

**agent2api** = 多提供商本地网关：把各家 AI 桌面客户端的**登录态**包装成本地 OpenAI 兼容 API。
上游项目 `aimod-cc/agent2api`（MIT）。本项目是它的**私有副本**，用于自建部署与本地修改。

- 语言：Rust（网关本体）+ React/Vite（面板前端）+ Tauri（桌面壳，我们不用）
- 我们只跑它的 **headless 服务端二进制**（`/usr/local/bin/agent2api-server`），不做桌面端

---

## 2. 部署现状（主机 124）

| 项 | 值 |
| --- | --- |
| 容器 | `agent2api`（`restart: unless-stopped`） |
| 镜像 | `ghcr.io/knownothing20/agent2api-fix:latest`（**我们自己的 CI 产物**） |
| 端口 | `192.168.31.124:3065`（面板与 `/v1` 共用；**只绑局域网**，宿主 `127.0.0.1:3065` 探不到属正常） |
| 部署目录 | `/vol1/1000/docker/agent2api/`：`compose.yaml` + `.env`（均 chmod 600） |
| 数据卷 | 命名卷 `agent2api_agent2api-data` → 容器 `/data`（SQLite + 各渠道凭据） |
| 管理员 | 用户 `admin`，密码存 `/vol1/1000/docker/agent2api/.admin_password`（600） |
| 面板 | `http://192.168.31.124:3065` |
| OpenAI 端点 | `http://192.168.31.124:3065/v1`（客户端 `base_url`），`api_key` = 面板「网关 Key」页建的那把 |
| 容器加固 | `read_only` 根文件系统 + `tmpfs /tmp` + `cap_drop: ALL` + `no-new-privileges` + `mem_limit 1g` + `pids_limit 512` |
| 旧文件 | `docker-compose.yml`（官方镜像 + 绑定挂载）已停用，备份 `.pre-ghcr-<ts>`；`./data` 目录保留未删 |

**与另一套网关完全独立**：`deveco-gateway`（端口 17128）是另一个项目、另一个容器、另一套 skill，两者互不影响。

### 当前账号

面板已添加 **2 个 CodeArts 账号**（`priority=100` / `101`，均启用）。凭据在数据卷里 ⇒ **重建容器不用重新登录**。

---

## 3. 代码与仓库

| 项 | 值 |
| --- | --- |
| 本地路径 | `D:\GitHub\agent2api-fix` |
| `origin` | `knownothing20/agent2api-fix`（**PRIVATE**） |
| `upstream` | `aimod-cc/agent2api` |
| 基线 | 上游 `4a0d741`（v2.8.0，接入 CodeArts/Trae 那版），28 个标签已带上 |
| 跟上游 | `git fetch upstream && git merge upstream/main` |
| 许可证 | MIT（可改可分，保留 LICENSE 与版权声明） |

### CI（`.github/workflows/docker.yml`）

| 触发 | 产物 |
| --- | --- |
| push `main` | `latest` + `sha-<短sha>` |
| 打 `v*` 标签 | 版本号 + `latest` |
| 手动 dispatch | `dev` |

- 推送到 **`ghcr.io/knownothing20/agent2api-fix`**，凭据用内置 `GITHUB_TOKEN`（`permissions: packages: write`），**不需要任何 secret**
- 架构只出 `linux/amd64`（要 arm64 把 `platforms:` 改回 `linux/amd64,linux/arm64`，**不需要 QEMU**）
- 用 `type=gha` 缓存：首次要编整棵 Rust 依赖树，之后只重编源码层（实测首次约 6 分钟、增量约 50 秒）
- 镜像带 `org.opencontainers.image.revision`（= 提交 sha）⇒ 部署后可核对

### ⚠️ 改前端必须重建产物

Dockerfile **只 `COPY desktop-tauri/ui`，不在构建镜像时跑 npm**。所以：

```bash
cd desktop-tauri/ui-kit && npm ci --no-audit --no-fund
cd ../ui-islands && npm ci --no-audit --no-fund && npm run build   # tsc --noEmit && vite build → ../ui/islands/
git add -A   # 源码 + ui/islands/ui.js 一起提交
```

（`npm ci` 偶发网络失败，重跑一次即可；**别用 `| tail` 判断成败**，它会把失败退出码吃掉。）
纯 CSS 在 `desktop-tauri/ui/css/*.css`（静态目录，不需要重建）。

---

## 4. 124 侧部署 / 更新 / 回滚

```bash
# 更新镜像（数据卷保留 ⇒ 账号与凭据不掉）
cd /vol1/1000/docker/agent2api && docker compose pull && docker compose up -d

# 版本核对
docker inspect agent2api --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
gh api repos/knownothing20/agent2api-fix/commits/main --jq .sha

# 探活（在 124 上也要用局域网 IP）
curl -s --noproxy '*' http://192.168.31.124:3065/health      # {"status":"ok"}
```

`.env` 关键项：

```
AGENT2API_IMAGE=ghcr.io/knownothing20/agent2api-fix:latest
AGENT2API_BIND_ADDRESS=192.168.31.124
AGENT2API_ADMIN_USER=admin
AGENT2API_ADMIN_PASSWORD=***          # 与 .admin_password 同值
AGENT2API_CAPTCHA_ENABLED=0           # 面板人机验证已关（登录页曾卡在验证）
WORKBUDDY_UPDATE_REPO=aimod-cc/agent2api   # 「检查更新」读公开上游（见 §6）
```

**回滚**：把 `image:` 换回 `aimodcc/agent2api:latest`（或用备份的 `docker-compose.yml.pre-ghcr-*`）再 `up -d`；数据卷不动，账号不丢。

---

## 5. 码道（CodeArts）渠道

- **已内置**（`ProviderKind::CodeArts`），面板「账号」页 → 添加账号 → 选 CodeArts → **网页登录**或**粘贴凭证**（不支持导入本机登录态）
- 上游 `codearts.huaweicloud.com`；OAuth/PKCE（`client_id=vscode-codebot`）+ DPoP + 华为云 **SDK-HMAC-SHA256** 签名
- **每账号仅 3 路并发**（第 4 路报 `TM.00001041`）；本地准入闸满员回 **409**
- 凭据是**临时**的（约 24 小时），提前 15 分钟自动续；**续期必须同时有 refresh token + PKCE verifier + DPoP 私钥**
- 模型目录三源合并（agent-center / builtin / benefit）；**trial 账号可能一个模型都没有**

### 多账号调度语义（2026-09-28 实测更正，之前写错过）

⚠️ **本文档与 skill 早前写过「409 与 400 归 Fatal → 不换账号 ⇒ 2 个码道账号 ≠ 6 路并发」—— 那个结论是错的**，
它是照着「错误分类表」推出来的，而那张表**只管无状态那几家**。实测与读码结论：

- `CodeArtsAdapter::is_stateful()` 为 **true**（`providers/codearts/mod.rs`）⇒ 码道走的是
  `attempt_stateful` 那条路，**根本不经过错误分类**。
- `classify_error` 全仓只有**一个**调用点（`upstream/provider_loop.rs` 的 `send_with_retry`，无状态路径专属）
  ⇒ `codearts/mod.rs::classify_error`（403/429→QuotaLimited）**在转发链上是死代码**。
- 有状态路径的失败处理是**无条件换号**：`Err` → 记入 `tried_ids` → `pick_next_account` → 顺延下一个账号
  （换号预算 = 面板「切换账号重试次数」，默认 5）。
- 另有**路由层并发过滤**：`routing::at_concurrency_limit`（`maxConcurrent > 0` 且在途数达上限就跳过）。

⇒ **两个码道账号本来就能跑 6 路**（2 × 3），第 4 个并发请求会被两重机制接住：① 路由层因账号 1 达
`maxConcurrent=3` 直接跳过它；② 万一竞态挤进账号 1，本地闸回 409 后有状态路径也会顺延到账号 2。

#### 会话调度（2026-09-28 新增）

在原来的「优先级主备」之上加了一档**会话粘性 + 额度/空闲调度**，只在**首次选路**生效：

1. **会话粘性**：客户端带 `x-session-id` 时，网关记住「这条会话 → 账号」；命中且该账号此刻可用
   （启用 / 未限流 / 未满并发）就直接复用，**同一条会话的每一轮都落在同一个账号上**。
   账号不可用时照常另选一个，并**改写映射**（换号也跟着走）。
2. 否则按这个顺序挑（升序取第一个）：**到期早 → 积分多 → 在途少 → 优先级**。
   - 「到期」取账号的 `subscription.resetDate`（上游**没给**每个积分池各自的到期日，只有账号级重置日）；
   - 「积分」取定时余额快照的 `available`；两项都取不到时排在能取到的之后；
   - 数据源是 `core::usage_query` 的定时快照（`GET /api/accounts/usage/snapshot` 那份），
     不额外发请求。

失败后的顺延仍走原来的优先级口径（`pick_next_account` 未改），只是顺延后会改写会话映射。

**当前两个账号的额度读数完全相同**（都是 `resetDate=2026-10-29`、都是 11000 积分），所以实际起作用的
是「空闲优先」——「积分优先」要等两账号额度拉开差距才看得出来。

---

## 6. 面板「更新」页（我们改造过）

页面只显示五行读数：**本项目仓库 / 参考仓库 / 当前版本 / 参考仓库最新版本 / 最近更新**（+ 一颗「检查更新」）。

设计要点 —— **「检查目标」与「显示对象」是两件事**：

| | 取值 | 说明 |
| --- | --- | --- |
| 本项目仓库 | 常量 `knownothing20/agent2api-fix` | 私有；匿名读不到它的 Release，**不拿它做检查** |
| 参考仓库 | 常量 `aimod-cc/agent2api` | 公开 ⇒ 匿名可读，**版本信息与更新日志都来自它** |
| 后端 `WORKBUDDY_UPDATE_REPO` | `aimod-cc/agent2api` | 决定「检查更新」去读谁 |

⚠️ **私有仓库的坑**：GitHub 对私有仓库的匿名 API 请求一律 **404**。若哪天要改回读本项目仓库，必须给凭据：
① 面板「更新设置」贴**细粒度只读 PAT**（该仓库 `Contents: Read-only`）——注意**本页已按需求删掉了「更新设置」按钮**，届时需从 env 给 `GITHUB_TOKEN` / `WORKBUDDY_GITHUB_TOKEN`；
② 别用 124 上那份 ghcr 凭据（实测 scope 只有 `read:packages`）。

**接口口径**：检查是 **GET** `/api/update/check?current=<版本>`（POST 会 404）；`GET /api/update/status` 读缓存。
面板登录返回的是 **cookie**（不是 Bearer），`/api/accounts` 的数组在 `data.accounts`。

---

## 7. 已知待办 / 可继续开发的方向

1. ~~**让「本地会话满员」也换账号**（把 2 个码道账号真正变成 6 路并发）~~
   **2026-09-28 核实：这条待办的前提是错的，本来就通**（有状态路径无条件换号 + 路由层并发过滤，
   见 §5 的实测更正）。**已改为**实现「会话粘性 + 到期/积分/空闲调度」，见 §5「会话调度」。
2. **更新页显示「当前部署的构建时间/提交」**：现在只有版本号与参考仓库发布时间。可在 CI 传 build-arg → Dockerfile `ARG/ENV` → 后端暴露 → 前端显示（离线可得，不依赖 GitHub API）
3. **码道并发上限可配**：`DEFAULT_SESSION_LIMIT=3` / `MAX_SESSION_LIMIT=64`，目前是每账号设置
4. **可选**：把「更新」页的 `检查更新` 换成「同时看上游有没有新版本」（我们 fork 场景下最实用）

---

## 8. 速查：本仓库改过哪些地方（相对上游）

| 提交 | 内容 |
| --- | --- |
| `8c8677f` | CI 改为推我们自己的 GHCR；新增 `deploy/docker/`（compose + .env.example + README） |
| `6717e0d` | 面板「更新」页：显示本项目仓库 / 参考仓库 / 最近更新时间 |
| `607ff7b` | 两者拆开取（本项目仓库用常量，版本信息固定读公开上游） |
| `6fd32e3` | 页面精简：只留仓库地址 / 版本 / 最近更新时间（删掉下载、更新设置、更新日志、关于作者） |
| 本次 | 新增本文档 |

查看完整差异：`git log --oneline upstream/main..main` / `git diff upstream/main..main --stat`
