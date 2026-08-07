# pi-on-cf — Agent 工作手册

本项目运行在 Cloudflare Workers 上，使用两个 **SQLite-backed Durable Objects**（`PiSession`、`PiRegistry`），并有一个 R2 桶用于 computer 会话产物。

本文件记录运维、调试、用量查询的标准做法，供 agent（以及任何从这里接手的人）使用。

> ⚠️ 安全红线：任何 token / API key / secret **一律不得**写进本文件、写进代码、写进提交。运行时从 `.dev.vars` 或 Cloudflare secret 读取。

---

## 一、关键配置与密钥位置

| 项 | 位置 | 用途 |
|---|---|---|
| `AI_API_KEY` | `.dev.vars` + Cloudflare secret | LLM 的 key（DeepSeek `sk-`） |
| `CF_API_TOKEN` | `.dev.vars`（`cfoat_` 开头） | **仅 Worker 运行时内部**使用，**不能**用于调 Cloudflare API |
| `CLOUDFLARE_ACCOUNT_ID` | `.dev.vars` | 账号 ID |
| wrangler OAuth token | `~/.wrangler/config/default.toml`（`cfoat_` 开头） | **调 Cloudflare API / GraphQL 用这个** |

### 认证陷阱（容易踩）

- `.dev.vars` 里那个 `CF_API_TOKEN` 是 **`cfoat_` 开头的 OAuth 部署凭证**，它虽然写给 Worker 用，但**实际上它是个 OAuth token，缺少 analytics 读 scope**，直接拿它调 `api.cloudflare.com` 会得到 **`Invalid access token` (9109)** 或 **`Authentication error` (10000)**。
- 真正能调 GraphQL Analytics API 的是 **wrangler 已登录的 OAuth token**（存在 `~/.wrangler/config/default.toml` 的 `oauth_token` 字段）。它带 `workers:write`、`d1:write` 等 scope，够查用量。

### 读取 wrangler OAuth token（不要落盘 / 不打印全量）

OAuth token 存在 wrangler 登录配置里，从该配置读取即可：

- **Windows 本机**：`C:\Users\wangyu\AppData\Roaming\xdg.config\.wrangler\config\default.toml`
- **Linux / macOS**：`~/.config/.wrangler/config/default.toml`
- **字段**：`oauth_token`（值以 `cfoat_` 开头）

```bash
# 从 wrangler 登录配置里读 token（注意不要 echo 出完整 token）
WRANGLER_CONFIG="C:\Users\wangyu\AppData\Roaming\xdg.config\.wrangler\config\default.toml"
[ -f "$WRANGLER_CONFIG" ] || WRANGLER_CONFIG="$HOME/.config/.wrangler/config/default.toml"
OAUTH=$(grep -E '^oauth_token' "$WRANGLER_CONFIG" | sed 's/.*= "//; s/"//')
echo "已读取 OAuth token，尾4位=...${OAUTH: -4}"
```

---

## 二、查用量：直接用脚本（推荐）

```bash
python scripts/cf-usage.py            # 今天（默认）
python scripts/cf-usage.py --days 7   # 最近 7 天
python scripts/cf-usage.py --json     # 原始 JSON
python scripts/cf-usage.py --debug    # 调试
```

脚本**自动**读取 wrangler OAuth token（跨平台定位配置文件）和账号 ID（读 `.dev.vars` 的 `CLOUDFLARE_ACCOUNT_ID`），无需传 key。

覆盖指标：Workers 入口请求（按域名 Top10）、Durable Objects（requests / duration GB-s / rows read / rows written）、D1、R2、KV，每项都对照 Free 配额显示占用百分比。

## 三、Free 计划每日限额速查

| 指标 | Free 每日配额 | 重置 |
|---|---|---|
| Workers 请求 | 100,000 | 00:00 UTC |
| DO Requests | 100,000 | 00:00 UTC |
| DO Duration | 13,000 GB-s | 00:00 UTC |
| DO SQL rows read | 5,000,000 | 00:00 UTC |
| DO SQL rows written | 100,000 | 00:00 UTC |
| 单个 DO SQLite 存储 | 1 GB（总量） | — |
| D1 rows read / written | 5,000,000 / 100,000 | 00:00 UTC |
| KV 读 / 写删 | 100,000 / 1,000 | 00:00 UTC |
| R2 存储 / Class A / Class B | 10 GB / 1M / 10M（月） | 月 |

> 备注：DO duration 按 128MB 内存核算 GB-s；GraphQL 里 wallTime 单位是微秒（µs），脚本已处理。

## 四、已知踩坑记录（简短版）

1. **`CF_API_TOKEN` 不能调 API**：`.dev.vars` 里那个 `cfoat_` 开头的是 OAuth 部署凭证，缺少 analytics scope，调 `api.cloudflare.com` 会报 `Invalid access token (9109)` / `Authentication error (10000)`。必须用 wrangler 登录的 OAuth token（`scripts/cf-usage.py` 已自动处理）。
2. **DO 时长字段是 `wallTime`（微秒），不是 `duration`**；计费换算 GB-s = 秒 × 0.128（128MB 内存核算）。
3. **GraphQL filter 的日期都用 UTC**，限额 00:00 UTC 重置。

## 五、账号 ID 从哪拿

`ACCOUNT`（`viewer.accounts` 的 `accountTag`）取账号 ID，一是从 `.dev.vars` 的 `CLOUDFLARE_ACCOUNT_ID=`，二是跑 `npx wrangler whoami`，会打印 Account ID 和你关联的邮箱。两者一致，选任一个。

### 运维命令清单

```bash
# 部署（build + deploy）
pnpm run deploy

# 本地查看登录状态 / 权限（同时能看到 Account ID）
npx wrangler whoami

# 实时日志
npx wrangler tail

# 更新线上 secret（本地 .dev.vars 是另一套，部署后线上用 Cloudflare secret）
npx wrangler secret put AI_API_KEY
```
