#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""A forgetting curve for your memory —— 给 MEMORY.md 的每条记忆记一个权重，随时间衰减、被用则加强。

规则（都写在 RULES 里，想调就改这里）：
  * 每条记忆权重 1.0 = 刚记住；floor 0.05 = 忘得差不多（还能搜到，但排在后面）
  * 每天乘一次衰减系数：普通 0.985，旧.* 账目 0.975，钉子（身份/守则/偏好等）不衰减
  * 内容被改写 → +0.35（重新想起来）
  * 被 query.py 命中当种子 → +0.08（用进废退）
  * 权重只是排序用的，**不会删任何记忆**

用法：
  python decay.py tick            # 按今天日期结算一次衰减（幂等：一天只掉一次）
  python decay.py status          # 看看谁最牢、谁快忘了
  python decay.py touch 记忆.插件  # 手动加强（一般不用）
"""
import os
import re
import sys
import json
import hashlib
import argparse
from datetime import date, datetime

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("MEMORY_ROOT") or os.getcwd()
STATE_NAME = "decay.json"

# ---------- 规则 ----------
DECAY_DAILY = 0.985      # 普通条目的日衰减
DECAY_OLD = 0.975        # 旧账（旧.*）掉得更快
FLOOR = 0.05             # 再低也不低于这个
REWRITE_BOOST = 0.35     # 内容被改写
HIT_BOOST = 0.08         # 被查询命中
MAX_W = 1.0

# 这些前缀/关键词算「钉子」：不衰减（事实、身份、规则、偏好这类不能忘）
PIN_PREFIXES = ("身份.", "QQ.", "语音.", "日记.", "记忆.", "抖音.", "游戏.", "工具.")
PIN_KEYWORDS = ("守则", "规则", "偏好", "禁止", "必须", "安全", "底线", "锚定")


def state_path(root):
    return os.path.join(root, "memory-graph", STATE_NAME)


def load_state(root):
    fp = state_path(root)
    if not os.path.exists(fp):
        return {"version": 1, "entries": {}}
    try:
        with open(fp, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return {"version": 1, "entries": {}}
    d.setdefault("entries", {})
    return d


def save_state(root, st):
    fp = state_path(root)
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    tmp = fp + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, fp)


def parse_memory(path):
    """从 MEMORY.md 抽出 [(key, text)]，跟 build.py 的 parse_memory 同口径。"""
    out = []
    cur_key, cur_lines = None, []

    def flush():
        nonlocal cur_key, cur_lines
        if cur_key is not None:
            text = "\n".join(cur_lines).strip()
            out.append((cur_key, text))
        cur_key, cur_lines = None, []

    with open(path, encoding="utf-8") as f:
        for line in f:
            s = line.rstrip("\n")
            if s.startswith("## "):
                flush()
                continue
            m = re.match(r"^- \[([^\]]+)\]\s*(.*)$", s)
            if m:
                flush()
                cur_key, cur_lines = m.group(1).strip(), [m.group(2)]
            elif cur_key is not None:
                if s.strip():
                    cur_lines.append(s.strip())
                else:
                    flush()
    flush()
    return out


def text_hash(text):
    return hashlib.sha1((text or "").strip().encode("utf-8")).hexdigest()[:16]


def is_pinned(key):
    if key.startswith(PIN_PREFIXES):
        return True
    return any(k in key for k in PIN_KEYWORDS)


def daily_factor(key):
    if is_pinned(key):
        return 1.0
    if key.startswith("旧."):
        return DECAY_OLD
    return DECAY_DAILY


def days_between(a, b):
    try:
        d1 = datetime.strptime(a, "%Y-%m-%d").date()
        d2 = datetime.strptime(b, "%Y-%m-%d").date()
        return max(0, (d2 - d1).days)
    except Exception:
        return 0


def tick(root=None, today=None, verbose=False):
    """按今天的日期结算衰减。幂等：同一天调多次结果一样。"""
    root = root or ROOT
    today = today or date.today().isoformat()
    mem = os.path.join(root, "MEMORY.md")
    if not os.path.exists(mem):
        return {"ok": False, "error": f"没找到 {mem}"}

    st = load_state(root)
    entries = st["entries"]
    items = parse_memory(mem)
    changed, created, decayed = 0, 0, []

    for key, text in items:
        h = text_hash(text)
        e = entries.get(key)
        if e is None:
            entries[key] = {"w": MAX_W, "last_tick": today, "hash": h, "created": today, "hits": 0}
            created += 1
            continue

        # 1) 内容变了 → 重新想起来，并把衰减日重置到今天（不然刚想起又挨一刀）
        if e.get("hash") != h:
            e["w"] = min(MAX_W, float(e.get("w", MAX_W)) + REWRITE_BOOST)
            e["hash"] = h
            e["last_tick"] = today
            changed += 1
            continue

        # 2) 同一记忆条目内容没变 → 按过了几天衰减
        days = days_between(e.get("last_tick", today), today)
        if days <= 0:
            continue
        f = daily_factor(key)
        if f < 1.0:
            old = float(e.get("w", MAX_W))
            new = max(FLOOR, old * (f ** days))
            if new != old:
                decayed.append((key, round(old, 4), round(new, 4), days))
            e["w"] = new
        e["last_tick"] = today

    # 3) 记忆里已经删掉的键：保留状态但标记，方便以后误删恢复
    live = {k for k, _ in items}
    for k, e in entries.items():
        if k not in live:
            e["gone"] = True
        elif e.pop("gone", None):
            e["w"] = max(FLOOR, float(e.get("w", FLOOR)) * 0.5)

    st["last_tick"] = today
    st["entries"] = entries
    save_state(root, st)

    out = {
        "ok": True,
        "today": today,
        "total": len(items),
        "created": created,
        "changed": changed,
        "decayed": len(decayed),
        "state": state_path(root),
    }
    if verbose and decayed:
        out["decayed_detail"] = sorted(decayed, key=lambda x: x[2])[:10]
    return out


def touch(root, key, amount=HIT_BOOST):
    root = root or ROOT
    st = load_state(root)
    e = st["entries"].get(key)
    if e is None:
        st["entries"][key] = {"w": MAX_W, "last_tick": date.today().isoformat(),
                              "hash": "", "created": date.today().isoformat(), "hits": 1}
    else:
        e["w"] = min(MAX_W, float(e.get("w", MAX_W)) + float(amount))
        e["hits"] = int(e.get("hits", 0)) + 1
    save_state(root, st)
    return {"ok": True, "key": key, "w": round(st["entries"][key]["w"], 4)}


def weights(root=None):
    """给 build.py 用：{key: w}"""
    root = root or ROOT
    st = load_state(root)
    return {k: round(float(v.get("w", MAX_W)), 4) for k, v in st["entries"].items()}


def status(root=None, top=10):
    root = root or ROOT
    st = load_state(root)
    rows = [(k, float(v.get("w", MAX_W)), v.get("last_tick", ""), int(v.get("hits", 0)))
            for k, v in st["entries"].items() if not v.get("gone")]
    rows.sort(key=lambda r: r[1])
    print(f"条目 {len(rows)} 条（状态文件 {state_path(root)}）")
    if not rows:
        return {"ok": True, "entries": 0}
    print("\n== 快忘掉的 ==")
    for k, w, t, h in rows[:top]:
        print(f"  {w:.3f}  {k}  (上次 {t}, 被用 {h} 次)")
    print("\n== 最牢的 ==")
    for k, w, t, h in rows[-top:][::-1]:
        print(f"  {w:.3f}  {k}")
    avg = sum(r[1] for r in rows) / len(rows)
    print(f"\n平均权重 {avg:.3f}；钉子 {sum(1 for k, *_ in rows if is_pinned(k))} 条不衰减")
    return {"ok": True, "entries": len(rows), "avg": round(avg, 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="?", default="tick", choices=["tick", "status", "touch", "weights"])
    ap.add_argument("arg", nargs="?", default="")
    ap.add_argument("--root", default=None)
    ap.add_argument("--today", default=None, help="假装今天是这天（YYYY-MM-DD），测试用")
    ap.add_argument("--top", type=int, default=10)
    a = ap.parse_args()
    root = a.root or ROOT

    if a.cmd == "tick":
        print(json.dumps(tick(root, a.today, verbose=True), ensure_ascii=False, indent=1))
    elif a.cmd == "status":
        print(json.dumps(status(root, a.top), ensure_ascii=False))
    elif a.cmd == "touch":
        if not a.arg:
            ap.error("touch 要给键名")
        print(json.dumps(touch(root, a.arg), ensure_ascii=False))
    else:
        print(json.dumps(weights(root), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
