# 我们自己的 agent2api 部署（deploy/docker）

与 `deveco-fix` 的 `deploy/docker/` 同一套习惯：**CI 出镜像 → 目标机 compose 拉取运行**。

## 1. 镜像从哪来

`.github/workflows/docker.yml`：

| 触发 | 产物 tag |
| --- | --- |
| push `main` | `latest` + `sha-<短sha>` |
| 打 `v*` 标签 | 版本号 + `latest` |
| 手动 dispatch | `dev` |

镜像：`ghcr.io/knownothing20/agent2api-fix`（GHCR，私有包；124 上已有 ghcr 凭据）。

> 首次构建要编整棵 Rust 依赖树（Dockerfile 用空桩层 + `type=gha` 缓存），十几到几十分钟属正常；第二轮起只重编源码层。

## 2. 目标机上怎么跑

```bash
cd /vol1/1000/docker/agent2api
cp deploy/docker/.env.example .env   # 或手写：镜像、监听地址、管理员凭据
docker compose pull && docker compose up -d
```

数据在命名卷 `agent2api-data` 里（SQLite + 各渠道凭据）⇒ **重建容器不用重新登录**。

## 3. 部署核对（与 deveco 一样）

```bash
docker inspect agent2api --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
gh api repos/knownothing20/agent2api-fix/commits/main --jq .sha
```

两者一致才算部署成功。

## 4. 端口

`3065` 同时提供面板与 OpenAI 兼容端点：

- 面板：`http://<bind>:3065/`
- 客户端：`base_url = http://<bind>:3065/v1`，`api_key` 用面板「网关 Key」页建的那把

## 5. 同步上游更新

本仓库配置了 `upstream` remote 指向上游开源项目（见 [README](../../README.md) 文末「关于本仓库」）：

```bash
git fetch upstream && git merge upstream/main
```

合并后重新 push `main` 即可出新镜像。
