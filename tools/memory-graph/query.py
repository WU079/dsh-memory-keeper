#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""在记忆图谱上做扩散激活召回。

种子匹配是「先准后糊」：
  1) 精确：查询词原样出现在标题/正文里；
  2) 模糊：拿查询词跟每个节点算最长公共子串，够长就算沾边（比如查「记忆图谱」
     能落到「记忆.插件」，因为日记里写的是 memory-graph 这种英文名）；
  3) 英文/工具名不分大小写，`-`/`_` 忽略。

用法（系统 Python 3.11 坏了，用 dsh 运行时那个 3.12，见 build.cmd）：
  python query.py "抖音 标签"
  python query.py "记忆图谱" --hops 2 --top 8
  python query.py --stats
"""
import os
import sys
import sqlite3
import argparse
from collections import defaultdict

DB = os.environ.get("MEMORY_DB") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "graph.db")
DECAY = 0.7          # 每跳衰减
SEEDS = 5            # 种子数
MAX_EDGES_PER_NODE = 12
FUZZY_MIN = 0.45     # 最长公共子串占查询词的比例，低于这个不算沾边


def conn():
    if not os.path.exists(DB):
        sys.exit("图还没建：先跑 build.py")
    return sqlite3.connect(DB)


def lcs_len(a, b):
    """a、b 的最长公共子串长度（a 短的放前面）。"""
    if not a or not b:
        return 0
    if len(a) > len(b):
        a, b = b, a
    prev = [0] * (len(b) + 1)
    best = 0
    for ca in a:
        cur = [0] * (len(b) + 1)
        for j, cb in enumerate(b, 1):
            if ca == cb:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best:
                    best = cur[j]
        prev = cur
    return best


def find_seeds(con, q):
    """返回 [(id, kind, title, text, score, why)]，score 1.0 = 精确命中。"""
    terms = [t for t in q.replace("　", " ").split() if t]
    if not terms:
        return []
    rows = con.execute("SELECT id, kind, title, text, COALESCE(weight,1.0) FROM nodes").fetchall()
    deg = dict(con.execute(
        "SELECT src, SUM(weight) FROM edges GROUP BY src").fetchall())
    out = []
    for nid, kind, title, text, w in rows:
        blob = (title + "\n" + (text or "")).lower()
        tlow = (title or "").lower()
        score, fuzzy = 0.0, []
        for t in terms:
            tl = t.lower()
            if tl in tlow:            # 命中标题的比只命中正文的重
                score += 1.5
                continue
            if tl in blob:
                score += 1.0
                continue
            # 模糊：最长公共子串（至少要 2 个字，别让单字乱沾）
            n = lcs_len(tl, blob)
            if n >= 2:
                ratio = n / len(tl)
                bonus = 0.3 if lcs_len(tl, tlow) >= 2 else 0.0
                if ratio + bonus >= FUZZY_MIN:
                    score += min(1.0, ratio + bonus)
                    fuzzy.append(tl[:n])
        if score > 0:
            why = "模糊：" + "、".join(sorted(set(fuzzy))) if fuzzy else ""
            # 遗忘系统：命中的分乘记忆权重（快忘掉的排后面，但不至于搜不到）
            out.append((score * float(w or 1.0), kind, -deg.get(nid, 0.0), len(text or ""),
                        (nid, kind, title, text, why)))
    # 同分：memory 优先 → 边上权重大的（真联得上别的记忆）→ 正文短的
    out.sort(key=lambda x: (-x[0], 0 if x[1] == "memory" else 1, x[2], x[3]))
    return [r[4] for r in out[:SEEDS]]


def spread(con, seeds, hops=2):
    """从种子出发沿边扩散，返回 {node_id: score}"""
    score = defaultdict(float)
    seed_ids = set()
    for sid, *_rest in seeds:
        score[sid] = 1.0
        seed_ids.add(sid)
    visited = set(seed_ids)
    frontier = list(seed_ids)

    for hop in range(1, hops + 1):
        cand = defaultdict(float)
        for nid in frontier:
            rows = con.execute(
                "SELECT dst, weight FROM edges WHERE src=? ORDER BY weight DESC LIMIT ?",
                (nid, MAX_EDGES_PER_NODE),
            ).fetchall()
            for dst, w in rows:
                if dst in visited:
                    continue                      # 走过的路不再回流，避免分数炸掉
                cand[dst] = max(cand[dst], w * (DECAY ** (hop - 1)))
        if not cand:
            break
        for k, v in cand.items():
            score[k] = max(score.get(k, 0.0), v)
            visited.add(k)
        frontier = list(cand.keys())
    return score


def describe(con, nid):
    r = con.execute("SELECT kind, title, source FROM nodes WHERE id=?", (nid,)).fetchone()
    if not r:
        return None, None, None
    return r[0], r[1], r[2]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="*", help="关键词")
    ap.add_argument("--hops", type=int, default=2)
    ap.add_argument("--top", type=int, default=6)
    ap.add_argument("--min", type=float, default=0.8, help="低于这个分数当噪声丢掉")
    ap.add_argument("--stats", action="store_true")
    ap.add_argument("--show", type=int, default=0, help="显示前 N 条的正文预览")
    a = ap.parse_args()

    con = conn()

    if a.stats:
        n = con.execute("SELECT count(*) FROM nodes").fetchone()[0]
        e = con.execute("SELECT count(*) FROM edges").fetchone()[0]
        print(f"节点 {n} / 边 {e}（双向）")
        for kind, c in con.execute("SELECT kind, count(*) FROM nodes GROUP BY kind"):
            print(f"  {kind}: {c}")
        for rel, c in con.execute("SELECT rel, count(*) FROM edges GROUP BY rel"):
            print(f"  {rel}: {c}")
        deg = con.execute(
            "SELECT avg(c) FROM (SELECT src, count(*) c FROM edges GROUP BY src)"
        ).fetchone()[0]
        print(f"  平均出度: {deg:.1f}")
        return

    q = " ".join(a.query).strip()
    if not q:
        ap.error("给个关键词")

    seeds = find_seeds(con, q)
    if not seeds:
        print(f"没找到和「{q}」相关的记忆。")
        return

    score = spread(con, seeds, a.hops)
    seed_ids = {s[0] for s in seeds}

    # 遗忘系统：扩散出来的也按权重打折；命中的记忆顺手加强一点（用进废退）
    wmap = dict(con.execute("SELECT id, COALESCE(weight,1.0) FROM nodes").fetchall())
    score = {k: v * float(wmap.get(k, 1.0)) for k, v in score.items()}
    try:
        import decay as _decay
        root = os.environ.get("MEMORY_ROOT") or os.path.dirname(
            os.path.dirname(os.path.abspath(DB)))
        for sid in seed_ids:
            if str(sid).startswith("mem:"):
                _decay.touch(root, str(sid)[4:])
    except Exception:
        pass

    print(f"查询：{q}")
    print("\n== 直接命中 ==")
    for sid, kind, title, text, why in seeds:
        tag = f"  ({why})" if why else ""
        print(f"[{kind}] {title}{tag}")
        print(f"    {text[:90].replace(chr(10), ' ')}…")
        print(f"    -> {con.execute('SELECT source FROM nodes WHERE id=?', (sid,)).fetchone()[0]}")

    others = sorted(
        ((nid, s) for nid, s in score.items() if nid not in seed_ids and s >= a.min),
        key=lambda kv: -kv[1],
    )[: a.top]
    if others:
        print("\n== 顺着边能找到 ==")
        for nid, s in others:
            kind, title, source = describe(con, nid)
            if not title:
                continue
            print(f"({s:.2f}) [{kind}] {title}")
            print(f"        -> {source}")

    if a.show:
        print("\n== 正文预览 ==")
        for nid, s in others[: a.show]:
            t = con.execute("SELECT text FROM nodes WHERE id=?", (nid,)).fetchone()[0]
            print(f"--- {nid} ({s:.2f})\n{t[:300]}\n")


if __name__ == "__main__":
    main()
