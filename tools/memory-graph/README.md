# 记忆图谱（memory graph）

给「一个文件夹里的 markdown 记忆」加一层图结构：**双链不是装饰，是可以被查询、被扩散激活的边**。

这套工具跟插件本体是同一套逻辑：`lib/assoc.mjs` 里的种子匹配 / 关键词重合 / 一跳扩散，
`mem_write` 写完后推荐的 `[[键]]`、`mem_search` 里返回的 `related`，都从这里来；
这里的 Python 版本只是把同一个算法搬到一个能离线跑的 CLI 上，方便你在写日记时顺手查一遍。

## 它假设你的记忆长这样

```
<memory-root>/
├── MEMORY.md          # 主档：一条记忆 = 一个 [主题.子项] 键 + 一段正文，正文里用 [[键]] 互连
├── diary/
│   ├── 2026-01-01.md  # 日记：`## 标题` 分块，每块一条
│   └── ...
└── memory-graph/      # 本目录（也可以放到别处，用 --root 指回去）
```

`MEMORY.md` 的写法见 [`examples/MEMORY.example.md`](../../examples/MEMORY.example.md)。
要点只有两条：

1. 每个条目有个**键**，形如 `[记忆.插件]`、`[抖音.发布]`——点号前是主题，后是子项；
2. 正文里用 `[[另一个键]]` 手动连过去。图就是这些边搭起来的。

## 三个命令

```bash
# 1) 建图：读 MEMORY.md + diary/，产出 graph.db（SQLite）和 graph.json（给插件用）
python build.py
python build.py --root D:/my-memory        # 记忆不在默认位置时
# Windows 上也可以：build.cmd

# 2) 查：给一个词，做扩散激活召回（先精确、后模糊，再从种子顺边扩散一跳）
python query.py "记忆图谱" --hops 2 --top 8
python query.py --stats                    # 看节点/边/悬空链统计
# Windows：q.cmd "记忆图谱"

# 3) 推荐双链：写完一段话，看该挂哪几个键
python suggest_links.py --file draft.md
python suggest_links.py "今天写的一段话" --line-only
python suggest_links.py --keys             # 列出所有能挂的键
# Windows：suggest.cmd --file draft.md
```

如果图谱不在脚本旁边，`build.py --db <路径>` 决定写到哪，`query.py --db <路径>`、
`suggest_links.py --graph <路径>` 决定读哪一份。

Windows 的 `.cmd` 会优先用 DSH 运行时自带的 Python，找不到就退回 PATH 上的 `python`。

## 遗忘曲线（decay）

记忆不该只有「有 / 没有」两态，所以每条记忆带一个权重：`1.0` 是全亮，`0.05` 是几乎忘掉。
**权重只影响「还会不会主动推荐 / 排序靠不靠前」，永远不删记忆**——想找还是搜得到。

每次 `build.cmd` 会先跑一次 `decay.py tick`（幂等，同一天跑几次结果一样）：

| 情况 | 每天乘 |
| --- | --- |
| 普通键 | `0.985` |
| `旧.*`（过时的旧账） | `0.975` |
| 钉子：`身份.` `QQ.` `语音.` `日记.` `记忆.` `抖音.` `游戏.` `工具.` 前缀，或名字里带「守则/规则/偏好/禁止/必须/安全/底线/锚定」 | 不衰减 |

权重回升：**内容被改写** `+0.35`（你重新记了一遍），**被查询/搜索命中** `+0.08`（想起来一次）。
下限 `0.05`，上限 `1.0`。

```bash
python decay.py tick          # 结算到今天（build.cmd 自动做）
python decay.py status        # 看谁在变淡、谁最牢
python decay.py touch 抖音.发布  # 手动补一笔（相当于「刚想起它」）
# Windows：decay.cmd status
```

状态存在 `memory-graph/decay.json`，键是记忆的键名，值是权重 + 上次结算日 + 内容哈希。
`build.py` 把权重写进 `graph.db` 的 `nodes.weight` 和 `graph.json`；`query.py` 排序乘权重，
`suggest_links.py` 与插件侧的 `suggestLinks` 对 `< 0.4` 的键不再推荐。

## 设计上的几个选择（踩过坑才有）

- **图谱是派生物**：`graph.db` / `graph.json` 随时可以删、可以重建，真相永远在 markdown 里。
  所以这两个文件不该进版本库（见根目录 `.gitignore`）。
- **先准后糊**：精确命中标题 / 正文才给高分；模糊匹配用最长公共子串，且要求占查询词的
  比例够高（`FUZZY_MIN`），否则「记忆图谱」这种词会被一堆无关条目蹭到。
- **中文按三字片段**：两字组太容易误报（「尾巴」「慢慢」这种共享词会互相串门），
  所以中文重合度只用 ≥3 字的片段算。
- **一跳扩散带衰减**：`边权 × 0.7`，且只推荐 `kind == "memory"` 的节点——
  只有记忆条目有键名，日记节点没法写成 `[[键]]`。
- **已经手挂过的不再推荐**：正文里出现过的 `[[键]]` 会被跳过，免得推荐一堆你已经想到的。

## 文件

| 文件 | 作用 |
| --- | --- |
| `build.py` | 抽节点（MEMORY.md 的条目 + diary 的段落）、算结构边、写 `graph.db` / `graph.json` |
| `query.py` | 扩散激活召回：种子匹配 → 顺边扩散 → 按分数排序输出（分数乘遗忘权重） |
| `suggest_links.py` | 给一段文字推荐该挂的 `[[键]]`（可 `--line-only` 直接粘贴） |
| `decay.py` | 遗忘曲线：按天给每条记忆降权，改写 +0.35、命中 +0.08，下限 0.05 |
| `test-assoc.mjs` | 拿 `graph.json` 直接调插件里的 `lib/assoc.mjs`，验证两边算法一致 |
| `*.cmd` | Windows 下免配环境的包装脚本 |

`test-assoc.mjs` 的用法：先在当前目录 `build.py` 出 `graph.json`，然后

```bash
node test-assoc.mjs 记忆图谱 备份 视频
```

它会打印每个查询词的种子节点和扩散结果。

## 长度参考

一份 200 行左右的主档 + 一年多日记（几百个段落），建图大约 1～2 秒，
`query.py` 一次查询是几十毫秒级——因为它读的是 `graph.db`，不是每次重扫 markdown。
