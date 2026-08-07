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

## 二、查询 DO 用量（GraphQL Analytics API）

### 端点与认证

```
POST https://api.cloudflare.com/client/v4/graphql
Authorization: Bearer $OAUTH     # ← 用 wrangler OAuth token
Content-Type: application/json
```

请求体是一个标准 GraphQL JSON：`{"query": "..."}`。

> 用 Python 生成请求体最稳（避免 shell 转义破坏 JSON）。下面所有请求都以 `OAUTH`、`ACCOUNT`、当天日期为变量，**不含任何真实 secret**，可直接复用。

### 数据集总表（本次验证过有效的）

在 **Account 根对象**下可用（`viewer.accounts`），命名规律：`durableObjects*Groups`。

| GraphQL 数据集 | 类型 | 关键 sum 字段 | 用途 |
|---|---|---|---|
| `durableObjectsInvocationsAdaptiveGroups` | 每次调用 | `requests`、`wallTime` | **请求数**、**时长**（按分钟聚合） |
| `durableObjectsPeriodicGroups` | 每日 | `rowsRead`、`rowsWritten`、`duration`、`activeTime`、`storageDeletes` | **SQL 行读写统计（每日）** ⭐ |
| `durableObjectsSqlStorageGroups` | — | 无 `sum`（是纯表） | 按 `namespaceId` 细分存储（字段结构特殊，见下） |
| `durableObjectsSubrequestsAdaptiveGroups` | 每次调用 | `sum` | 子请求 |

### 字段清单

- **Invocations**（`durableObjectsInvocationsAdaptiveGroups`）:
  - `sum.requests` — 请求数（含 HTTP / RPC / WebSocket / alarm）
  - `sum.wallTime` — 运行时长，**毫秒**。Free 限额是 **13,000 GB-s/天**（GB-s = wall 秒 × 0.128，因为 DO 按 128MB 内存核算）
  - dimensions：`datetime`（可按小时/分钟分桶）
- **Periodic**（`durableObjectsPeriodicGroups`，每天 1 条汇总）:
  - `sum.rowsRead` — SQL 读行数 ⭐ 免费配额 **5,000,000/天**
  - `sum.rowsWritten` — SQL 写行数（含 INSERT/UPDATE/DELETE/alarm）⭐ 免费配额 **100,000/天**
  - `sum.duration` — 当天运行时长
  - `sum.activeTime`、`sum.storageDeletes`
  - dimensions：`date`
- dimensions 通用可用：`date`、`datetime`、`datetimeHour`、`namespaceId`（部分数据集）

### Free 计划每日限额速查

| 指标 | Free 每日配额 | 重置 |
|---|---|---|
| DO Requests | 100,000 | 00:00 UTC |
| DO Duration | 13,000 GB-s | 00:00 UTC |
| **SQL rows read** | **5,000,000** | 00:00 UTC |
| **SQL rows written** | **100,000** | 00:00 UTC |
| 单个 DO SQLite 存储 | 1 GB（总量，非每日） | — |

---

### 请求例子 1：当天 DO 请求数 + 时长（Invocations）

```bash
WR="C:\Users\wangyu\AppData\Roaming\xdg.config\.wrangler\config\default.toml"; [ -f "$WR" ] || WR="$HOME/.config/.wrangler/config/default.toml"
OAUTH=$(grep -E '^oauth_token' "$WR" | sed 's/.*= "//; s/"//')
ACCOUNT="<YOUR_ACCOUNT_ID>"
DAY="$(date -u +%Y-%m-%d)"          # 当天 UTC

python - "$OAUTH" "$ACCOUNT" "$DAY" <<'EOF'
import sys, json, urllib.request
oauth, account, day = sys.argv[1], sys.argv[2], sys.argv[3]
query = """
{ viewer { accounts(filter: {accountTag: "%s"}) {
    durableObjectsInvocationsAdaptiveGroups(
      limit: 200,
      filter: { datetime_geq: "%sT00:00:00Z", datetime_leq: "%sT23:59:59Z" }
    ) {
      sum { requests wallTime }
      dimensions { datetime }
    }
} } }
""" % (account, day, day)
body = json.dumps({"query": query}).encode()
req = urllib.request.Request("https://api.cloudflare.com/client/v4/graphql",
    data=body, headers={"Authorization":"Bearer "+oauth, "Content-Type":"application/json"})
d = json.loads(urllib.request.urlopen(req).read().decode())
rows = d["data"]["viewer"]["accounts"][0]["durableObjectsInvocationsAdaptiveGroups"]
tot_req = sum(r["sum"]["requests"] for r in rows)
tot_wt_ms = sum(r["sum"]["wallTime"] for r in rows)
print(f"requests={tot_req}")
print(f"wallTime_ms={tot_wt_ms} -> wall_sec={tot_wt_ms/1e3:.1f} -> GB-s(128MB)={tot_wt_ms/1e3*0.128:.2f}")
EOF
```

### 请求例子 2：当天 SQL 行读写用量（Periodic，重点）

```bash
WR="C:\Users\wangyu\AppData\Roaming\xdg.config\.wrangler\config\default.toml"; [ -f "$WR" ] || WR="$HOME/.config/.wrangler/config/default.toml"
OAUTH=$(grep -E '^oauth_token' "$WR" | sed 's/.*= "//; s/"//')
ACCOUNT="<YOUR_ACCOUNT_ID>"
DAY="$(date -u +%Y-%m-%d)"

python - "$OAUTH" "$ACCOUNT" "$DAY" <<'EOF'
import sys, json, urllib.request
oauth, account, day = sys.argv[1], sys.argv[2], sys.argv[3]
query = """
{ viewer { accounts(filter: {accountTag: "%s"}) {
    durableObjectsPeriodicGroups(limit: 5, filter: { date: "%s" }) {
      dimensions { date }
      sum { rowsRead rowsWritten storageDeletes duration activeTime }
    }
} } }
""" % (account, day)
body = json.dumps({"query": query}).encode()
req = urllib.request.Request("https://api.cloudflare.com/client/v4/graphql",
    data=body, headers={"Authorization":"Bearer "+oauth, "Content-Type":"application/json"})
d = json.loads(urllib.request.urlopen(req).read().decode())
for r in d["data"]["viewer"]["accounts"][0]["durableObjectsPeriodicGroups"]:
    s = r["sum"]
    print(f"{r['dimensions']['date']}  rowsRead={s['rowsRead']}  rowsWritten={s['rowsWritten']}  duration={s['duration']}")
EOF
```

---

## 三、已知踩坑记录（前人踩过，别再踩）

1. **`CF_API_TOKEN` 不能调 API**：`.dev.vars` 里的 `CF_API_TOKEN`（`cfoat_` 开头）调 `api.cloudflare.com` 会报 `Invalid access token (9109)` 或 `Authentication error (10000)`。必须用 **wrangler 登录的 OAuth token**。
2. **`duration` 字段不存在于 Invocations**：Invocations 的 sum 里时长字段叫 **`wallTime`**（ms），不是 `duration`。实测 `duration` 报 `unknown field`。
3. **`sqlStorageGroups` 没有 `sum`**：它是个纯表数据集，直接 `{ rowsRead rowsWritten }` 会报 `unknown field "sum"`。要看行读写，请用 **`durableObjectsPeriodicGroups`**。
4. **请求体必须由程序生成 JSON**：不要用 bash 拼接 GraphQL 字符串，换行/引号会被 shell 破坏（报 `invalid character '3' after object key` / `unexpected EOF`）。用 Python `json.dumps`。
5. **当天 `datetime` 用 UTC**：GraphQL filter 的 `datetime` / `date` 都是 **UTC**。限额在 **00:00 UTC** 重置。
6. **`wallTime` 单位是毫秒，计费按 GB-s**：Free 配额 13,000 GB-s/天。换算：`GB-s = wall_ms / 1000 * 0.128`（DO 按 128MB 内存计费）。

## 四、账号 ID 从哪拿

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
