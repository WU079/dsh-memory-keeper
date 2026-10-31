#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""记忆图谱构建 —— 从 MEMORY.md + diary/ 抽节点和结构边，建一张 SQLite 图。

图谱是派生物：随时可删可重建，真相永远在源文件里。

默认把「本文件的上一级目录」当作记忆根目录（即 MEMORY.md 和 diary/ 所在处），
也就是把这个文件夹放进你的记忆目录就能直接跑：

    <memory-root>/MEMORY.md      ← 记忆主档，键写成 [主题.子项]
    <memory-root>/diary/*.md     ← 日记，一段一条
    <memory-root>/memory-graph/  ← 本脚本所在目录，graph.db / graph.json 落在这里

也可以显式指定：
    python build.py --root D:/my-memory
    python build.py --root D:/my-memory --db D:/tmp/graph.db
    set MEMORY_ROOT=D:/my-memory && python build.py
"""
import os
import re
import sqlite3
import glob
import math
import json
import argparse
from datetime import datetime
from collections import defaultdict


def default_root():
    return os.environ.get("MEMORY_ROOT") or os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))
    )


ROOT = default_root()
HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "graph.db")
MEM = os.path.join(ROOT, "MEMORY.md")
DIARY = os.path.join(ROOT, "diary")

MAX_ENTS = 40          # 每个节点最多保留的实体数
MAX_EDGES = 8          # 每个节点最多向外连的边数
MIN_WEIGHT = 0.45      # 低于这个权重不连边

# ---------- 实体抽取 ----------
PATTERNS = [
    (re.compile(r"[A-Za-z]:\\[^\s，。；、）)」』】|]+"), "path"),
    (re.compile(r"`([^`\n]{2,60})`"), "code"),
    (re.compile(r"\bBV[0-9A-Za-z]{10}\b"), "bvid"),
    (re.compile(r"\b\d{6,12}\b"), "id"),
    (re.compile(r"\b(?:mem_[a-z_]+|dsh-[a-z0-9-]+)\b"), "tool"),
    (re.compile(r"#[^\s#，。；]{1,20}"), "tag"),
]

# 常用词不算实体
STOP = set("""的 了 是 在 我 你 他 她 它 这 那 有 和 也 就 都 要 会 能 不 没 一个 什么 怎么
今天 现在 还有 然后 因为 所以 但是 如果 已经 可以 这个 那个 自己 时候 东西 一直 还是""".split())


def entities(text):
    out = {}
    for pat, kind in PATTERNS:
        for m in pat.finditer(text):
            v = m.group(1) if m.groups() else m.group(0)
            v = v.strip()
            if len(v) < 2 or v in STOP:
                continue
            out[(kind, v)] = out.get((kind, v), 0) + 1
    return out


# ---------- 解析 MEMORY.md ----------
def parse_memory(path):
    nodes = []
    section = ""
    cur = None

    def flush():
        nonlocal cur
        if not cur:
            return
        text = "\n".join(cur["lines"]).strip()
        if text:
            nodes.append({
                "id": "mem:" + cur["key"].replace(" ", ""),
                "kind": "memory",
                "title": cur["key"],
                "text": text,
                "ts": "",
                "source": f"{path}#L{cur['line']}",
                "section": section,
            })
        cur = None

    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            s = line.rstrip("\n")
            if s.startswith("## "):
                flush()
                section = s[3:].strip()
                continue
            m = re.match(r"^- \[([^\]]+)\]\s*(.*)$", s)
            if m:
                flush()
                cur = {"key": m.group(1), "lines": [m.group(2)], "line": i}
            elif cur is not None:
                if s.strip():
                    cur["lines"].append(s.strip())
                else:
                    flush()
    flush()
    return nodes


# ---------- 解析 diary ----------
def parse_diary(dirpath):
    nodes = []
    for fp in sorted(glob.glob(os.path.join(dirpath, "*.md"))):
        if fp.endswith(".bak"):
            continue
        day = os.path.basename(fp)[:10]
        with open(fp, encoding="utf-8") as f:
            raw = f.read()
        paras = re.split(r"\n\s*\n", raw)
        n = 0
        for p in paras:
            t = p.strip()
            if not t or t.startswith("#"):
                continue
            if len(t) < 12:
                continue
            n += 1
            head = re.sub(r"\s+", " ", t)[:24]
            nodes.append({
                "id": f"diary:{day}:{n}",
                "kind": "diary",
                "title": f"{day} {head}",
                "text": t,
                "ts": day,
                "source": os.path.basename(fp),
                "section": "",
            })
    return nodes


# ---------- 建图 ----------
def build():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    nodes = parse_memory(MEM) + parse_diary(DIARY)

    # 实体 → 节点
    node_ents = {}
    df = defaultdict(int)
    for nd in nodes:
        ents = entities(nd["title"] + " " + nd["text"])
        # 按出现次数排序，保留 MAX_ENTS
        top = sorted(ents.items(), key=lambda kv: -kv[1])[:MAX_ENTS]
        node_ents[nd["id"]] = set(kv[0] for kv in top)
        for k in node_ents[nd["id"]]:
            df[k] += 1

    # 两两共享实体（只对共享数 >=1 的组合，用倒排加速）
    # 不同类型的实体，信息量不一样：路径到处都有（弱），工具名/标签很具体（强）
    KIND_W = {"path": 0.25, "code": 1.1, "tool": 1.6, "tag": 1.3, "bvid": 1.2, "id": 1.0}
    inv = defaultdict(list)
    ent_kind = {}
    for nid, ents in node_ents.items():
        for kind, v in ents:
            inv[v].append(nid)
            ent_kind[v] = kind

    pair_w = defaultdict(float)
    for e, nids in inv.items():
        if len(nids) < 2:
            continue
        w = KIND_W.get(ent_kind.get(e, "code"), 1.0) / math.log(2 + df[e])
        for i in range(len(nids)):
            for j in range(i + 1, len(nids)):
                a, b = nids[i], nids[j]
                if a == b:
                    continue
                pair_w[(a, b)] += w

    # ---- 边 ----
    edges = []          # (a, b, rel, weight, origin)

    # 1) 同一个小节（MEMORY.md 里同一主题的条目）
    by_sec = defaultdict(list)
    for n in nodes:
        if n["kind"] == "memory" and n["section"]:
            by_sec[n["section"]].append(n["id"])
    for sec, ids in by_sec.items():
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                edges.append((ids[i], ids[j], "same-section", 0.6, "struct"))

    # 2) 同一篇日记（同一天里的事天然相关）
    by_file = defaultdict(list)
    for n in nodes:
        if n["kind"] == "diary":
            by_file[n["source"]].append(n["id"])
    for f, ids in by_file.items():
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                edges.append((ids[i], ids[j], "same-diary", 0.22, "struct"))

    # 3) 实体共现（每个节点只留最强的 MAX_EDGES 条）
    best = defaultdict(list)
    for (a, b), w in pair_w.items():
        best[a].append((w, b))
        best[b].append((w, a))
    for a, lst in best.items():
        for w, b in sorted(lst, reverse=True)[:MAX_EDGES]:
            if w < MIN_WEIGHT:
                continue
            edges.append((a, b, "cooccur", round(min(2.5, w * 1.5), 3), "entity"))

    # 3.5) 双链边：文本里写 [[键]] 就手连一条，权重最高
    title2id = {}
    for n in nodes:
        title2id.setdefault(n["title"], n["id"])
        if n["kind"] == "memory":
            title2id.setdefault(n["title"].split(".")[-1], n["id"])
    dangling = []
    for n in nodes:
        # 反引号里的 [[xxx]] 是行文举例（比如「不想说就回 [[不说]]」），不当双链
        txt = re.sub(r"`[^`]*`", " ", n["text"] or "")
        for m in re.finditer(r"\[\[([^\]]{1,40})\]\]", txt):
            tgt = m.group(1).strip()
            tid = title2id.get(tgt)
            if tid and tid != n["id"]:
                edges.append((n["id"], tid, "link", 3.0, "manual"))
            elif not tid:
                dangling.append((n["id"], tgt))

    # 4) 按类型配额裁剪（每类各留几条，避免一类挤掉另一类）
    QUOTA = {"link": 12, "cooccur": 6, "same-section": 4, "same-diary": 3}
    by_node_rel = defaultdict(list)
    for idx, e in enumerate(edges):
        by_node_rel[(e[0], e[2])].append((e[3], idx))
        by_node_rel[(e[1], e[2])].append((e[3], idx))
    keep = set()
    for (nid, rel), lst in by_node_rel.items():
        for w, idx in sorted(lst, reverse=True)[: QUOTA.get(rel, 3)]:
            keep.add(idx)
    edges = [e for i, e in enumerate(edges) if i in keep]


    # 写库
    con = sqlite3.connect(DB)
    con.executescript("""
    DROP TABLE IF EXISTS nodes;
    DROP TABLE IF EXISTS edges;
    DROP TABLE IF EXISTS entities;
    CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT, title TEXT, text TEXT, ts TEXT, source TEXT, section TEXT);
    CREATE TABLE edges(src TEXT, dst TEXT, rel TEXT, weight REAL, origin TEXT, PRIMARY KEY(src,dst));
    CREATE TABLE entities(entity TEXT, kind TEXT, node_id TEXT, PRIMARY KEY(entity,node_id));
    CREATE INDEX idx_e_src ON edges(src);
    CREATE INDEX idx_n_kind ON nodes(kind);
    """)
    # 双向边
    rows = []
    for a, b, rel, w, origin in edges:
        rows.append((a, b, rel, w, origin))
        rows.append((b, a, rel, w, origin))
    rows.sort(key=lambda r: r[3])   # 升序：弱的先插，强的后插覆盖
    con.executemany("INSERT OR REPLACE INTO edges VALUES (?,?,?,?,?)", rows)
    con.executemany(
        "INSERT OR REPLACE INTO nodes VALUES (?,?,?,?,?,?,?)",
        [(n["id"], n["kind"], n["title"], n["text"], n["ts"], n["source"], n["section"]) for n in nodes],
    )
    ent_rows = []
    for nid, ents in node_ents.items():
        for kind, v in ents:
            ent_rows.append((v, kind, nid))
    con.executemany("INSERT OR IGNORE INTO entities VALUES (?,?,?)", ent_rows)
    con.commit()

    stat = {
        "rel_counts": {k: sum(1 for e in edges if e[2] == k) for k in ("link", "cooccur", "same-section", "same-diary")},
        "nodes": len(nodes),
        "memory": sum(1 for n in nodes if n["kind"] == "memory"),
        "diary": sum(1 for n in nodes if n["kind"] == "diary"),
        "edges": len(edges),
        "entities": len(df),
        "dangling_links": len(dangling),
        "db": DB,
    }

    # 顺带导出一份 JSON 给 DSH 插件用：node 直接读，不依赖 sqlite 驱动
    graph_json = os.path.join(os.path.dirname(DB), "graph.json")
    adj = defaultdict(list)
    for a, b, rel, w, origin in edges:
        adj[a].append({"dst": b, "rel": rel, "w": w})
        adj[b].append({"dst": a, "rel": rel, "w": w})
    payload = {
        "builtAt": datetime.now().isoformat(timespec="seconds"),
        "nodes": {
            n["id"]: {
                "kind": n["kind"],
                "title": n["title"],
                "source": n["source"],
                "section": n["section"],
                "text": (n["text"] or "")[:300],
            }
            for n in nodes
        },
        "adj": {k: sorted(v, key=lambda x: -x["w"])[:12] for k, v in adj.items()},
    }
    with open(graph_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    stat["json"] = graph_json
    con.close()
    print(json.dumps(stat, ensure_ascii=False, indent=1))
    return stat


def main():
    global ROOT, MEM, DIARY, DB
    ap = argparse.ArgumentParser(description="构建记忆图谱（graph.db + graph.json）")
    ap.add_argument("--root", help="记忆根目录（含 MEMORY.md 与 diary/），默认取 MEMORY_ROOT 或本目录的上一级")
    ap.add_argument("--db", help="graph.db 输出路径，默认落在本脚本旁边")
    a = ap.parse_args()
    if a.root:
        ROOT = os.path.abspath(a.root)
        MEM = os.path.join(ROOT, "MEMORY.md")
        DIARY = os.path.join(ROOT, "diary")
    if a.db:
        DB = os.path.abspath(a.db)
    if not os.path.exists(MEM):
        ap.error(f"没找到 {MEM}（用 --root 指向放了 MEMORY.md 的目录）")
    build()


if __name__ == "__main__":
    main()
