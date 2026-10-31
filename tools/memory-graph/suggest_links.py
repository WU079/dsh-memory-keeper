#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""记忆双链推荐 —— 写完一段话，看看该挂哪几个 [[键]]。

为什么要有它：MEMORY.md 的键靠手挂的 [[键]] 互相连起来，图才准；但写日记时
想不起有哪些键、也想不到该连谁。这个脚本同时做三件事：
  1) 直接点名：正文里出现键名（如 记忆.统一）或键的末段（如 统一）→ 强命中；
  2) 关键词重合：中文按三字片段（共享 2 字太容易误报，比如「尾巴」「慢慢」）、
     英文按单词，跟每条记忆的正文比重合度；
  3) 一跳扩散：从命中的条目顺着 graph.json 的边找间接相关的（边权 × 0.7），
     只推荐 memory 条目 —— 只有它们能写成 [[键]]（日记 node 没有键名）。

用法（Windows 上可以直接用同目录的 suggest.cmd，它会自己找 python）：
  python suggest_links.py "今天写的一段话"
  python suggest_links.py --file 草稿.md
  python suggest_links.py -            # 从 stdin 读（管道/重定向）
  python suggest_links.py --keys       # 列所有能挂的键（写东西前扫一眼）
  选项：--top 8  --min 0.8  --json  --line-only
"""
import argparse
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
GRAPH = os.path.join(HERE, "graph.json")

DECAY = 0.7          # 每跳衰减
MAX_W = 3.0          # 边权上限（link 边是 3.0）
SEED_MAX = 5         # 最多几个种子去扩散
CJK_RE = re.compile(r"[\u3400-\u9fff]+")
TOK_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.\-]{2,}")
LINK_RE = re.compile(r"\[\[([^\]]{1,40})\]\]")

def decode_bytes(raw):
    """按 utf-8 → gbk 顺序解码；Windows 控制台管道常是 gbk。"""
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def read_text_any(path):
    with open(path, "rb") as f:
        return decode_bytes(f.read())


def cjk_ngrams(s, n=3):
    out = set()
    for run in CJK_RE.findall(s):
        for i in range(len(run) - n + 1):
            out.add(run[i:i + n])
    return out


def ascii_tokens(s):
    return {t.lower() for t in TOK_RE.findall(s) if len(t) >= 3}


def lcs_len(a, b):
    """a、b 的最长公共子串长度（a 短的放前面，省内存）。"""
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


def score_node(text_low, in_tri, in_tok, node):
    """返回 (score, why)；score=0 表示不相关。memory 条目可用键名直接命中。"""
    title = node.get("title", "") or ""
    blob = (title + " " + (node.get("text", "") or "")).lower()
    tl = title.lower()
    if tl and tl in text_low:
        return 3.0, "直接写了键名「%s」" % title
    seg = tl.split(".")[-1]
    score, why = 0.0, ""
    if len(seg) >= 2 and seg in text_low:
        score, why = 2.4, "提到「%s」" % title.split(".")[-1]
    # 中文三字组重合（共享 2 字太容易误报，至少共享一个 3 字片段才算关键词）
    shared = in_tri & cjk_ngrams(blob, 3)
    if shared:
        kw = min(2.2, 0.8 + 0.25 * len(shared))
        if kw > score:
            score = kw
            why = "共同片段 %d 处（%s）" % (
                len(shared), "、".join(sorted(shared)[:3]))
    # 英文/路径/工具名重合
    itok = in_tok & ascii_tokens(blob)
    if itok:
        kw = 0.6 + 0.45 * len(itok)
        if kw > score:
            score = min(kw, 2.2)
            why = "共同词：%s" % "、".join(sorted(itok)[:4])
    return score, why


def load_graph():
    if not os.path.exists(GRAPH):
        sys.exit("图还没建：先跑 build.cmd（或 build.py）生成 graph.json")
    with open(GRAPH, encoding="utf-8") as f:
        return json.load(f)


def candidates(g, text, top=8, min_score=0.6):
    text_low = text.lower()
    in_tri = cjk_ngrams(text_low, 3)
    in_tok = ascii_tokens(text_low)
    if not in_tri and not in_tok:
        return []

    # 1) 相似度打分（所有节点都参与，日记段落也能当桥）
    #    正文里已经手挂过的键不再当种子——它已经连上了，别占名额
    already = {m.group(1).strip() for m in LINK_RE.finditer(text)}
    nodes = g.get("nodes", {})
    adj = g.get("adj", {})
    scored = []
    for nid, nd in nodes.items():
        if (nd.get("title") or "").strip() in already:
            continue
        s, why = score_node(text_low, in_tri, in_tok, nd)
        if s > 0:
            scored.append((s, nid, why))
    # 同分：memory 优先，然后出度大的（更有牵引力）
    scored.sort(key=lambda x: (-x[0],
                               0 if nodes[x[1]].get("kind") == "memory" else 1,
                               -len(adj.get(x[1], []))))
    if not scored:
        return []

    # 2) 取种子，一跳扩散到别的节点
    out = {}            # nid -> [score, why, via]
    seeds = scored[:SEED_MAX]
    for s, nid, why in seeds:
        out[nid] = [s, why, ""]
    for s, nid, _why in seeds:
        for e in adj.get(nid, []):
            dst = e.get("dst")
            if not dst or dst in out or dst not in nodes:
                continue
            w = min(float(e.get("w", 0)), MAX_W)
            if w < 1.0:        # same-section / same-diary 这种结构边不往外推
                continue
            ds = min(s, MAX_W) / MAX_W * w * DECAY
            if ds > out.get(dst, [0])[0]:
                out[dst] = [ds, "", nodes[nid].get("title", nid)]

    # 3) 只留能挂牌的 memory 条目
    items = []
    for nid, (s, why, via) in out.items():
        nd = nodes.get(nid) or {}
        if nd.get("kind") != "memory":
            continue
        title = nd.get("title", "") or ""
        if not title or title in already or s < min_score:
            continue
        items.append({
            "key": title, "score": round(s, 2), "why": why, "via": via,
            "id": nid, "section": nd.get("section", ""), "source": nd.get("source", ""),
        })
    items.sort(key=lambda x: -x["score"])
    return items[:top]


def main():
    global GRAPH
    ap = argparse.ArgumentParser(description="记忆双链推荐")
    ap.add_argument("text", nargs="*", help="要分析的文字；给 - 从 stdin 读")
    ap.add_argument("--file", help="从文件读")
    ap.add_argument("--graph", help="graph.json 路径，默认取本脚本旁边那个")
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--min", type=float, default=0.8)
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--line-only", action="store_true", help="只输出可复制的 [[键]] 行")
    ap.add_argument("--keys", action="store_true", help="只列出所有能挂的键")
    a = ap.parse_args()
    if a.graph:
        GRAPH = os.path.abspath(a.graph)

    g = load_graph()

    if a.keys:
        rows = [(nd.get("section", ""), k) for k, nd in g["nodes"].items()
                if nd.get("kind") == "memory"]
        rows.sort()
        print("能挂的键（%d 个）：" % len(rows))
        sec = None
        for s, k in rows:
            if s != sec:
                sec = s
                print("\n[%s]" % (sec or "未分节"))
            print("  " + k)
        return

    if a.file:
        text = read_text_any(a.file)
    elif a.text and a.text != ["-"]:
        text = " ".join(a.text)
    else:
        if sys.stdin is not None and sys.stdin.isatty() and not a.text:
            ap.error("给点文字（参数 / --file / stdin）")
        text = decode_bytes(sys.stdin.buffer.read())
    text = (text or "").strip()
    if not text:
        ap.error("给点文字（参数 / --file / stdin）")

    items = candidates(g, text, a.top, a.min)
    line = " ".join("[[%s]]" % i["key"] for i in items)

    if a.line_only:
        print(line)
        return
    if a.json:
        print(json.dumps({"chars": len(text), "candidates": items, "line": line},
                         ensure_ascii=False, indent=1))
        return

    print("输入 %d 字，候选 %d 个：" % (len(text), len(items)))
    for i in items:
        why = i["why"] or ("← %s" % i["via"])
        print("  %.2f  %-22s %s" % (i["score"], "[[%s]]" % i["key"], why))
    if items:
        print("\n可挂：" + line)
        print("（挑合适的挂上；都不合适就一个都别挂）")
    else:
        print("\n没找到像样的候选 —— 可能就是一段新故事，不用硬连。")


if __name__ == "__main__":
    main()
