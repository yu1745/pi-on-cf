#!/usr/bin/env python3
"""
pi-on-cf 账号用量查询脚本（Cloudflare GraphQL Analytics API）

自动读取 wrangler 已登录的 OAuth token，查询"当天"(UTC 00:00 - now)
所有 Cloudflare 产品的免费额度用量，并对照 Free plan 配额打印。

用法:
    python scripts/cf-usage.py                 # 查今天
    python scripts/cf-usage.py --days 7        # 查最近 7 天
    python scripts/cf-usage.py --account xxx   # 指定账号 ID（默认读 .dev.vars）
    python scripts/cf-usage.py --json          # 输出原始 JSON

依赖: 仅 Python 3 标准库（urllib）。无需 pip install。

安全: 只读取 wrangler 配置里的 OAuth token，不写盘、不打印完整 token。
"""

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Windows 终端默认 GBK，强制 UTF-8 输出避免中文乱码/编码错误
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

API_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql"


# ---------------------------------------------------------------------------
# token / account 获取
# ---------------------------------------------------------------------------

def find_wrangler_config() -> Path:
    """定位 wrangler 登录配置文件（跨平台）。"""
    candidates = [
        Path(os.environ.get("WRANGLER_HOME", "")) / "config" / "default.toml",
        Path.home() / ".config" / ".wrangler" / "config" / "default.toml",  # Linux/macOS
        Path.home() / ".wrangler" / "config" / "default.toml",
        Path("C:/Users") / os.environ.get("USERNAME", "USER") / "AppData/Roaming/xdg.config/.wrangler/config/default.toml",  # Windows
        Path(os.environ.get("APPDATA", "")) / "xdg.config" / ".wrangler" / "config" / "default.toml",
    ]
    for p in candidates:
        if p.is_file():
            return p
    raise FileNotFoundError(
        "未找到 wrangler 配置文件。请先运行 `npx wrangler login`，或设置 WRANGLER_HOME。"
    )


def read_oauth_token() -> str:
    """从 wrangler 配置读取 OAuth token（oauth_token = "cfoat_..."）。"""
    cfg = find_wrangler_config()
    for line in cfg.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("oauth_token"):
            val = line.split("=", 1)[1].strip().strip('"').strip("'")
            if val:
                return val
    raise RuntimeError(f"配置文件中未找到 oauth_token: {cfg}")


def read_account_id() -> str:
    """从项目 .dev.vars 读取账号 ID；失败则回退到环境变量。"""
    env = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if env:
        return env
    for dotfile in ("dev.vars", ".dev.vars"):
        p = Path(dotfile)
        if p.is_file():
            for line in p.read_text(encoding="utf-8").splitlines():
                if line.startswith("CLOUDFLARE_ACCOUNT_ID"):
                    return line.split("=", 1)[1].strip()
    raise RuntimeError("未找到账号 ID：请设置 CLOUDFLARE_ACCOUNT_ID 或提供 --account。")


# ---------------------------------------------------------------------------
# GraphQL 客户端
# ---------------------------------------------------------------------------

def gql(token: str, query: str) -> dict:
    body = json.dumps({"query": query}).encode("utf-8")
    req = urllib.request.Request(
        API_ENDPOINT,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data.get("errors"):
        msgs = "; ".join(e.get("message", "?") for e in data["errors"])
        raise RuntimeError(f"GraphQL 错误: {msgs}")
    return data


def account_query(token: str, account: str, dataset: str, fields: str, filter_s: str, dims: str = "") -> list:
    dims_part = f"dimensions {{ {dims} }}" if dims else ""
    query = (
        '{ viewer { accounts(filter: {accountTag: "%s"}) { '
        '%s(limit: 100, filter: %s) { sum { %s } %s } } } }'
        % (account, dataset, filter_s, fields, dims_part)
    )
    data = gql(token, query)
    acct = data["data"]["viewer"]["accounts"][0]
    return acct.get(dataset, [])


# ---------------------------------------------------------------------------
# 配额速查
# ---------------------------------------------------------------------------

QUOTA = {
    "Workers requests":        {"unit": "次", "free": 100_000, "per": "天"},
    "DO requests":             {"unit": "次", "free": 100_000, "per": "天"},
    "DO duration":             {"unit": "GB-s", "free": 13_000, "per": "天"},
    "DO rows read":            {"unit": "行", "free": 5_000_000, "per": "天"},
    "DO rows written":         {"unit": "行", "free": 100_000, "per": "天"},
    "D1 rows read":            {"unit": "行", "free": 5_000_000, "per": "天"},
    "D1 rows written":         {"unit": "行", "free": 100_000, "per": "天"},
    "KV reads":                {"unit": "次", "free": 100_000, "per": "天"},
    "KV writes/deletes":       {"unit": "次", "free": 1_000, "per": "天"},
    "R2 Class A ops":          {"unit": "次", "free": 1_000_000, "per": "月"},
    "R2 Class B ops":          {"unit": "次", "free": 10_000_000, "per": "月"},
}


def pct(used: float, free: float) -> str:
    if free <= 0:
        return "-"
    return f"{used / free * 100:.2f}%"


# ---------------------------------------------------------------------------
# 主逻辑
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="查询 Cloudflare 账号当天用量（Free 配额对照）")
    ap.add_argument("--days", type=int, default=1, help="查询最近 N 天（默认 1=今天）")
    ap.add_argument("--account", help="账号 ID（默认读 .dev.vars 的 CLOUDFLARE_ACCOUNT_ID）")
    ap.add_argument("--json", action="store_true", help="输出原始 JSON（不打印配额表）")
    ap.add_argument("--debug", action="store_true", help="打印调试信息")
    args = ap.parse_args()

    try:
        token = read_oauth_token()
        account = args.account or read_account_id()
    except Exception as e:
        print(f"✗ {e}", file=sys.stderr)
        return 1

    if args.debug:
        print(f"[debug] account={account} token尾4位=...{token[-4:]}")

    # 时间窗口（UTC）
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=args.days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    f_dt = 'datetime_geq: "%sT00:00:00Z", datetime_leq: "%sT23:59:59Z"' % (
        start.strftime("%Y-%m-%d"),
        now.strftime("%Y-%m-%d"),
    )
    f_dt_now = 'datetime_geq: "%sT00:00:00Z", datetime_leq: "%sT23:59:59Z"' % (
        start.strftime("%Y-%m-%d"),
        now.strftime("%Y-%m-%d"),
    )
    date_filters = []
    for i in range(args.days):
        d = (start + timedelta(days=i)).strftime("%Y-%m-%d")
        date_filters.append('date: "%s"' % d)
    f_periodic = "{ %s }" % " OR ".join(date_filters)

    results = {}
    errors = []

    def safe(name, fn):
        try:
            results[name] = fn()
        except Exception as e:
            errors.append(f"{name}: {e}")
            results[name] = None

    # --- Workers 入口请求（HTTP，按 host） ---
    def workers_http():
        rows = account_query(token, account, "httpRequestsAdaptiveGroups",
                             "visits edgeResponseBytes edgeRequestBytes",
                             "{" + f_dt + "}", "clientRequestHTTPHost")
        total = sum(r["sum"]["visits"] for r in rows)
        bytes_out = sum(r["sum"]["edgeResponseBytes"] for r in rows)
        top = sorted(rows, key=lambda r: -r["sum"]["visits"])[:10]
        return {"total_visits": total, "response_bytes": bytes_out,
                "by_host": [{h: {"visits": r["sum"]["visits"], "resp_bytes": r["sum"]["edgeResponseBytes"]}}
                            for r in top for h in [r["dimensions"]["clientRequestHTTPHost"] or "(none)"]]}
    safe("Workers requests (HTTP visits)", workers_http)

    # --- DO compute ---
    def do_compute():
        rows = account_query(token, account, "durableObjectsInvocationsAdaptiveGroups",
                             "requests wallTime", "{" + f_dt + "}")
        req = sum(r["sum"]["requests"] for r in rows)
        wall_us = sum(r["sum"]["wallTime"] for r in rows)
        wall_s = wall_us / 1e6
        gbs = wall_s * 0.128  # 128MB 内存核算
        return {"requests": req, "wall_seconds": wall_s, "gb_seconds": gbs}
    safe("DO requests+duration", do_compute)

    # --- DO SQLite storage（每日） ---
    def do_sql():
        rows = account_query(token, account, "durableObjectsPeriodicGroups",
                             "rowsRead rowsWritten storageDeletes duration",
                             f_periodic)
        rr = sum(r["sum"].get("rowsRead", 0) for r in rows)
        rw = sum(r["sum"].get("rowsWritten", 0) for r in rows)
        deletes = sum(r["sum"].get("storageDeletes", 0) for r in rows)
        return {"rows_read": rr, "rows_written": rw, "deletes": deletes}
    safe("DO SQLite storage", do_sql)

    # --- D1 ---
    def d1():
        rows = account_query(token, account, "d1AnalyticsAdaptiveGroups",
                             "rowsRead rowsWritten readQueries writeQueries",
                             "{" + f_dt + "}")
        return {
            "rows_read": sum(r["sum"].get("rowsRead", 0) for r in rows),
            "rows_written": sum(r["sum"].get("rowsWritten", 0) for r in rows),
            "read_queries": sum(r["sum"].get("readQueries", 0) for r in rows),
            "write_queries": sum(r["sum"].get("writeQueries", 0) for r in rows),
        }
    safe("D1", d1)

    # --- R2 ---
    def r2():
        rows = account_query(token, account, "r2OperationsAdaptiveGroups",
                             "requests responseBytes responseObjectSize",
                             "{" + f_dt + "}")
        return {
            "requests": sum(r["sum"].get("requests", 0) for r in rows),
            "response_bytes": sum(r["sum"].get("responseBytes", 0) for r in rows),
        }
    safe("R2", r2)

    # --- KV ---
    def kv():
        rows = account_query(token, account, "kvOperationsAdaptiveGroups",
                             "requests objectBytes", "{" + f_dt + "}")
        return {"requests": sum(r["sum"].get("requests", 0) for r in rows)}
    safe("KV", kv)

    # --- 输出 ---
    if args.json:
        print(json.dumps({"window": {"start": start.isoformat(), "end": now.isoformat(),
                                      "days": args.days},
                          "account": account, "results": results, "errors": errors},
                         indent=2, ensure_ascii=False))
        return 0

    w = now.strftime("%Y-%m-%d %H:%M") + " UTC"
    print("=" * 70)
    print(f"  Cloudflare 账号用量  (查询时间 {w}, 最近 {args.days} 天)")
    print(f"  账号 ID: {account}")
    print("=" * 70)

    # Workers
    print("\n[1] Workers 入口请求")
    w_h = results.get("Workers requests (HTTP visits)")
    if w_h:
        print(f"    visits 合计: {w_h['total_visits']:,}  (Free 配额 100,000/天)")
        if w_h["by_host"]:
            print("    按域名 Top10:")
            for h in w_h["by_host"]:
                for host, v in h.items():
                    print(f"      {host:<45} {v['visits']:>6,} visits  {v['resp_bytes']/1e6:>8.2f} MB")
    else:
        print(f"    ✗ {errors[-1] if errors else '查询失败'}")

    # DO
    print("\n[2] Durable Objects")
    do = results.get("DO requests+duration")
    if do:
        q = QUOTA["DO requests"]
        print(f"    requests: {do['requests']:,} / {q['free']:,} 次/天  ({pct(do['requests'], q['free'])})")
        q = QUOTA["DO duration"]
        print(f"    duration: {do['wall_seconds']:.0f}s = {do['gb_seconds']:.1f} GB-s / {q['free']:,} GB-s/天  ({pct(do['gb_seconds'], q['free'])})")
    sql = results.get("DO SQLite storage")
    if sql:
        q = QUOTA["DO rows read"]
        print(f"    rows read:  {sql['rows_read']:,} / {q['free']:,} 行/天  ({pct(sql['rows_read'], q['free'])})")
        q = QUOTA["DO rows written"]
        print(f"    rows write: {sql['rows_written']:,} / {q['free']:,} 行/天  ({pct(sql['rows_written'], q['free'])})")
        print(f"    storage deletes: {sql['deletes']:,}")

    # D1
    print("\n[3] D1")
    d1r = results.get("D1")
    if d1r:
        q = QUOTA["D1 rows read"]
        print(f"    rows read:  {d1r['rows_read']:,} / {q['free']:,} 行/天  ({pct(d1r['rows_read'], q['free'])})")
        q = QUOTA["D1 rows written"]
        print(f"    rows write: {d1r['rows_written']:,} / {q['free']:,} 行/天  ({pct(d1r['rows_written'], q['free'])})")
        print(f"    queries: read={d1r['read_queries']:,} write={d1r['write_queries']:,}")

    # R2
    print("\n[4] R2")
    r2r = results.get("R2")
    if r2r:
        qa = QUOTA["R2 Class A ops"]
        print(f"    operations: {r2r['requests']:,}  (Free 配额 Class A {qa['free']:,}/月, Class B 10,000,000/月)")
        print(f"    response bytes: {r2r['response_bytes']/1e6:.2f} MB")

    # KV
    print("\n[5] KV")
    kvr = results.get("KV")
    if kvr:
        print(f"    operations: {kvr['requests']:,}  (Free 配额 读 100,000/天, 写/删 1,000/天)")

    if errors:
        print("\n[⚠] 部分查询失败:")
        for e in errors:
            print(f"    {e}")

    print("\n" + "=" * 70)
    print("  备注: 限额 00:00 UTC 重置; DO duration 按 128MB 内存核算 GB-s;")
    print("        wallTime 单位为微秒(us)。")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
