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
    python scripts/cf-usage.py --sleep 3       # 每个查询间隔 3s（默认）
    python scripts/cf-usage.py --worker-sleep 8 # Worker 查询前额外等待 8s（默认）
    python scripts/cf-usage.py --debug         # 打印调试信息

特性:
  - 流式输出: 查一项、立即打印一项（不等全部查完）
  - 自动限速: 每个查询间隔 --sleep 秒；Worker 查询（最易 429）放最后且
    单独等 --worker-sleep 秒
  - 自动退避: 遇 429/5xx 按 Retry-After 或指数退避重试
  - 自动刷新: 启动时检测 access_token 过期时间，过期则自动调
    `wrangler whoami` 触发 refresh_token 换新；运行中遇 401 也会自动刷新重试
  - 查询顺序: DO → D1 → R2 → KV → Workers(最后)

依赖: 仅 Python 3 标准库（urllib）。无需 pip install。需要 PATH 里有
      wrangler 或 npx（仅 token 过期刷新时用到）。

安全: 只读取 wrangler 配置里的 OAuth token，不写盘、不打印完整 token。
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
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


def _parse_toml_value(raw: str) -> str:
    return raw.split("=", 1)[1].strip().strip('"').strip("'")


def read_oauth_token() -> str:
    """从 wrangler 配置读取 OAuth token（oauth_token = "cfoat_..."）。"""
    cfg = find_wrangler_config()
    for line in cfg.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("oauth_token"):
            val = _parse_toml_value(line)
            if val:
                return val
    raise RuntimeError(f"配置文件中未找到 oauth_token: {cfg}")


def read_expiration() -> datetime | None:
    """读取 wrangler 配置里的 access_token 过期时间（UTC datetime），没有则 None。"""
    try:
        cfg = find_wrangler_config()
    except FileNotFoundError:
        return None
    for line in cfg.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.startswith("expiration_time"):
            val = _parse_toml_value(s)
            try:
                return datetime.fromisoformat(val.replace("Z", "+00:00"))
            except ValueError:
                return None
    return None


def refresh_via_wrangler(timeout: int = 60) -> bool:
    """调用 `wrangler whoami` 触发 OAuth refresh_token 刷新 access_token。

    wrangler 检测到 access_token 过期会自动用 refresh_token 换新 access_token
    并写回 default.toml。返回 True 表示成功重新读到未过期 token。
    """
    print("[i] access_token 已过期，正在调用 `wrangler whoami` 自动刷新...",
          file=sys.stderr, flush=True)
    # Windows 上 subprocess 默认找不到 .CMD/.BAT 包装器，需 shell=True。
    # 优先直接调 wrangler（更快），回退到 npx wrangler。
    cmds = [["wrangler", "whoami"], ["npx", "--yes", "wrangler", "whoami"]]
    ok = False
    last_err = None
    for cmd in cmds:
        try:
            subprocess.run(cmd, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL,
                           timeout=timeout, check=False, shell=(os.name == "nt"))
            ok = True
            break
        except FileNotFoundError:
            last_err = f"找不到 {cmd[0]}"
            continue
        except subprocess.TimeoutExpired:
            last_err = f"{cmd[0]} 超时"
            continue
        except Exception as e:
            last_err = str(e)
            continue
    if not ok:
        print(f"[!] 刷新失败: {last_err}", file=sys.stderr)
        return False

    # 校验是否真的刷新成功
    exp = read_expiration()
    if exp and exp > datetime.now(timezone.utc):
        return True
    print("[!] 刷新后 token 仍显示过期，可能需要手动 `npx wrangler login`", file=sys.stderr)
    return False


def get_token_with_refresh(skew_seconds: int = 60) -> str:
    """读取 token；如已过期（或将在 skew_seconds 内过期）则自动刷新后重读。"""
    exp = read_expiration()
    now = datetime.now(timezone.utc)
    needs_refresh = (exp is None) or (exp <= now + timedelta(seconds=skew_seconds))
    if needs_refresh:
        refresh_via_wrangler()
    return read_oauth_token()


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

def gql(token: str, query: str, max_retries: int = 4) -> dict:
    """带 429/5xx 退避重试的 GraphQL 请求。

    401 会在运行时（access_token 突然过期）触发一次自动刷新并重试。
    """
    body = json.dumps({"query": query}).encode("utf-8")
    last_err = None
    refreshed = False
    for attempt in range(max_retries):
        req = urllib.request.Request(
            API_ENDPOINT,
            data=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if data.get("errors"):
                msgs = "; ".join(e.get("message", "?") for e in data["errors"])
                raise RuntimeError(f"GraphQL 错误: {msgs}")
            return data
        except urllib.error.HTTPError as e:
            last_err = e
            # 401: access_token 可能在脚本运行期间过期 → 刷新一次重试
            if e.code == 401 and not refreshed:
                refreshed = True
                try:
                    token = get_token_with_refresh()
                    continue
                except Exception:
                    raise
            # 429 / 5xx 可重试
            if e.code == 429 or 500 <= e.code < 600:
                wait = None
                retry_after = e.headers.get("Retry-After") if e.headers else None
                if retry_after:
                    try:
                        wait = float(retry_after)
                    except ValueError:
                        wait = None
                if wait is None:
                    wait = (2 ** (attempt + 1)) + (attempt * 0.5)
                if attempt < max_retries - 1:
                    time.sleep(wait)
                    continue
            raise
        except urllib.error.URLError as e:
            last_err = e
            if attempt < max_retries - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            raise
    raise last_err if last_err else RuntimeError("GraphQL 请求失败")


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

import re


def main() -> int:
    ap = argparse.ArgumentParser(description="查询 Cloudflare 账号当天用量（Free 配额对照）")
    ap.add_argument("--days", type=int, default=1, help="查询最近 N 天（默认 1=今天）")
    ap.add_argument("--account", help="账号 ID（默认读 .dev.vars 的 CLOUDFLARE_ACCOUNT_ID）")
    ap.add_argument("--json", action="store_true", help="输出原始 JSON（不打印配额表）")
    ap.add_argument("--debug", action="store_true", help="打印调试信息")
    ap.add_argument("--sleep", type=float, default=3.0,
                    help="每个查询之间的间隔秒数（默认 3.0，用于避免 429）")
    ap.add_argument("--worker-sleep", type=float, default=8.0,
                    help="Worker 入口请求查询前后的额外等待秒数（默认 8.0）")
    args = ap.parse_args()

    try:
        token = get_token_with_refresh()
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

    if args.debug:
        print(f"[debug] account={account} token尾4位=...{token[-4:]} "
              f"sleep={args.sleep}s worker_sleep={args.worker_sleep}s")

    # --- 非交互（--json）模式: 不需要流式打印，全部查完后一次性输出 ---
    if args.json:
        def safe_silent(name, fn, pre_sleep=0.0):
            if pre_sleep:
                time.sleep(pre_sleep)
            try:
                results[name] = fn()
            except Exception as e:
                errors.append(f"{name}: {e}")
                results[name] = None
            time.sleep(args.sleep)

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
        def do_compute():
            rows = account_query(token, account, "durableObjectsInvocationsAdaptiveGroups",
                                 "requests wallTime", "{" + f_dt + "}")
            req = sum(r["sum"]["requests"] for r in rows)
            wall_us = sum(r["sum"]["wallTime"] for r in rows)
            wall_s = wall_us / 1e6
            gbs = wall_s * 0.128
            return {"requests": req, "wall_seconds": wall_s, "gb_seconds": gbs}
        def do_sql():
            rows = account_query(token, account, "durableObjectsPeriodicGroups",
                                 "rowsRead rowsWritten storageDeletes duration",
                                 f_periodic)
            return {"rows_read": sum(r["sum"].get("rowsRead", 0) for r in rows),
                    "rows_written": sum(r["sum"].get("rowsWritten", 0) for r in rows),
                    "deletes": sum(r["sum"].get("storageDeletes", 0) for r in rows)}
        def d1():
            rows = account_query(token, account, "d1AnalyticsAdaptiveGroups",
                                 "rowsRead rowsWritten readQueries writeQueries",
                                 "{" + f_dt + "}")
            return {"rows_read": sum(r["sum"].get("rowsRead", 0) for r in rows),
                    "rows_written": sum(r["sum"].get("rowsWritten", 0) for r in rows),
                    "read_queries": sum(r["sum"].get("readQueries", 0) for r in rows),
                    "write_queries": sum(r["sum"].get("writeQueries", 0) for r in rows)}
        def r2():
            rows = account_query(token, account, "r2OperationsAdaptiveGroups",
                                 "requests responseBytes responseObjectSize",
                                 "{" + f_dt + "}")
            return {"requests": sum(r["sum"].get("requests", 0) for r in rows),
                    "response_bytes": sum(r["sum"].get("responseBytes", 0) for r in rows)}
        def kv():
            rows = account_query(token, account, "kvOperationsAdaptiveGroups",
                                 "requests objectBytes", "{" + f_dt + "}")
            return {"requests": sum(r["sum"].get("requests", 0) for r in rows)}

        safe_silent("DO requests+duration", do_compute)
        safe_silent("DO SQLite storage", do_sql)
        safe_silent("D1", d1)
        safe_silent("R2", r2)
        safe_silent("KV", kv)
        safe_silent("Workers requests (HTTP visits)", workers_http, pre_sleep=args.worker_sleep)

        print(json.dumps({"window": {"start": start.isoformat(), "end": now.isoformat(),
                                      "days": args.days},
                          "account": account, "results": results, "errors": errors},
                         indent=2, ensure_ascii=False))
        return 0

    # --- 交互模式: 流式打印（查一项、打一项），间隔 sleep 避免 429 ---
    # 输出顺序: DO → D1 → R2 → KV → Workers(最后、单独慢)
    w = now.strftime("%Y-%m-%d %H:%M") + " UTC"
    print("=" * 70)
    print(f"  Cloudflare 账号用量  (查询时间 {w}, 最近 {args.days} 天)")
    print(f"  账号 ID: {account}")
    print("=" * 70)
    sys.stdout.flush()

    # 小工具: 查一个、打一个
    def fetch_and_print(title, query_fn, printer, pre_sleep=0.0):
        """查一个产品并立即打印该块。返回 (result, error)。"""
        if pre_sleep:
            print(f"\n[.] {title} (等待 {pre_sleep:.0f}s 避免限速...)", flush=True)
            time.sleep(pre_sleep)
        print(f"\n[.] {title} 查询中...", flush=True)
        try:
            res = query_fn()
            printer(res)
            sys.stdout.flush()
            return res, None
        except Exception as e:
            print(f"    ✗ 查询失败: {e}", flush=True)
            sys.stdout.flush()
            return None, f"{title}: {e}"

    # ===== [2] Durable Objects (两个子查询) =====
    print("\n[2] Durable Objects", flush=True)
    def do_compute():
        rows = account_query(token, account, "durableObjectsInvocationsAdaptiveGroups",
                             "requests wallTime", "{" + f_dt + "}")
        req = sum(r["sum"]["requests"] for r in rows)
        wall_us = sum(r["sum"]["wallTime"] for r in rows)
        wall_s = wall_us / 1e6
        gbs = wall_s * 0.128
        return {"requests": req, "wall_seconds": wall_s, "gb_seconds": gbs}
    do, err1 = fetch_and_print(
        "DO requests+duration", do_compute,
        lambda d: (
            print(f"    requests: {d['requests']:,} / {QUOTA['DO requests']['free']:,} 次/天  "
                  f"({pct(d['requests'], QUOTA['DO requests']['free'])})"),
            print(f"    duration: {d['wall_seconds']:.0f}s = {d['gb_seconds']:.1f} GB-s / "
                  f"{QUOTA['DO duration']['free']:,} GB-s/天  "
                  f"({pct(d['gb_seconds'], QUOTA['DO duration']['free'])})"),
        ),
    )
    if err1: errors.append(err1)
    results["DO requests+duration"] = do
    time.sleep(args.sleep)

    def do_sql():
        rows = account_query(token, account, "durableObjectsPeriodicGroups",
                             "rowsRead rowsWritten storageDeletes duration",
                             f_periodic)
        return {"rows_read": sum(r["sum"].get("rowsRead", 0) for r in rows),
                "rows_written": sum(r["sum"].get("rowsWritten", 0) for r in rows),
                "deletes": sum(r["sum"].get("storageDeletes", 0) for r in rows)}
    sql, err2 = fetch_and_print(
        "DO SQLite storage", do_sql,
        lambda s: (
            print(f"    rows read:  {s['rows_read']:,} / {QUOTA['DO rows read']['free']:,} 行/天  "
                  f"({pct(s['rows_read'], QUOTA['DO rows read']['free'])})"),
            print(f"    rows write: {s['rows_written']:,} / {QUOTA['DO rows written']['free']:,} 行/天  "
                  f"({pct(s['rows_written'], QUOTA['DO rows written']['free'])})"),
            print(f"    storage deletes: {s['deletes']:,}"),
        ),
    )
    if err2: errors.append(err2)
    results["DO SQLite storage"] = sql
    time.sleep(args.sleep)

    # ===== [3] D1 =====
    def d1():
        rows = account_query(token, account, "d1AnalyticsAdaptiveGroups",
                             "rowsRead rowsWritten readQueries writeQueries",
                             "{" + f_dt + "}")
        return {"rows_read": sum(r["sum"].get("rowsRead", 0) for r in rows),
                "rows_written": sum(r["sum"].get("rowsWritten", 0) for r in rows),
                "read_queries": sum(r["sum"].get("readQueries", 0) for r in rows),
                "write_queries": sum(r["sum"].get("writeQueries", 0) for r in rows)}
    d1r, err3 = fetch_and_print(
        "D1", d1,
        lambda d: (
            print("\n[3] D1"),
            print(f"    rows read:  {d['rows_read']:,} / {QUOTA['D1 rows read']['free']:,} 行/天  "
                  f"({pct(d['rows_read'], QUOTA['D1 rows read']['free'])})"),
            print(f"    rows write: {d['rows_written']:,} / {QUOTA['D1 rows written']['free']:,} 行/天  "
                  f"({pct(d['rows_written'], QUOTA['D1 rows written']['free'])})"),
            print(f"    queries: read={d['read_queries']:,} write={d['write_queries']:,}"),
        ),
    )
    if err3: errors.append(err3)
    results["D1"] = d1r
    time.sleep(args.sleep)

    # ===== [4] R2 =====
    def r2():
        rows = account_query(token, account, "r2OperationsAdaptiveGroups",
                             "requests responseBytes responseObjectSize",
                             "{" + f_dt + "}")
        return {"requests": sum(r["sum"].get("requests", 0) for r in rows),
                "response_bytes": sum(r["sum"].get("responseBytes", 0) for r in rows)}
    r2r, err4 = fetch_and_print(
        "R2", r2,
        lambda d: (
            print("\n[4] R2"),
            print(f"    operations: {d['requests']:,}  (Free 配额 Class A "
                  f"{QUOTA['R2 Class A ops']['free']:,}/月, Class B 10,000,000/月)"),
            print(f"    response bytes: {d['response_bytes']/1e6:.2f} MB"),
        ),
    )
    if err4: errors.append(err4)
    results["R2"] = r2r
    time.sleep(args.sleep)

    # ===== [5] KV =====
    def kv():
        rows = account_query(token, account, "kvOperationsAdaptiveGroups",
                             "requests objectBytes", "{" + f_dt + "}")
        return {"requests": sum(r["sum"].get("requests", 0) for r in rows)}
    kvr, err5 = fetch_and_print(
        "KV", kv,
        lambda d: print("\n[5] KV\n"
                        f"    operations: {d['requests']:,}  "
                        f"(Free 配额 读 100,000/天, 写/删 1,000/天)"),
    )
    if err5: errors.append(err5)
    results["KV"] = kvr
    time.sleep(args.sleep)

    # ===== [1] Workers 入口请求（最后查、单独更慢） =====
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

    def print_workers(d):
        print("\n[1] Workers 入口请求")
        print(f"    visits 合计: {d['total_visits']:,}  (Free 配额 100,000/天)")
        if d["by_host"]:
            print("    按域名 Top10:")
            for h in d["by_host"]:
                for host, v in h.items():
                    print(f"      {host:<45} {v['visits']:>6,} visits  {v['resp_bytes']/1e6:>8.2f} MB")
    w_h, err6 = fetch_and_print(
        "Workers requests (HTTP visits)", workers_http, print_workers,
        pre_sleep=args.worker_sleep,
    )
    if err6: errors.append(err6)
    results["Workers requests (HTTP visits)"] = w_h

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
