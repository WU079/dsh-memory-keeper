/**
 * 记忆图谱上的「扩散激活」：查询词 → 种子节点 → 沿边跳两跳 → 相关条目。
 *
 * 纯函数，不碰文件系统，方便离线测（F:\大肥鱼\qqbot\agent-ws\memory-graph\test-assoc.mjs
 * 就是直接 import 这里跑，保证测的和插件里跑的是同一段代码）。
 *
 * 种子匹配和 memory-graph/query.py 保持一致：
 *   1) 命中标题 1.5 分，只命中正文 1.0 分；
 *   2) 沾边：最长公共子串够长也算（中文两字起，比如「记忆图谱」→「记忆.插件」）；
 *   3) 同分：memory 优先 → 边上权重大的 → 正文短的。
 */

// 最长公共子串长度（查询词 ≤ 几十字，节点正文建库时截到 300 字，够用了）
export function lcsLen(a, b) {
  if (!a || !b) return 0
  if (a.length > b.length) [a, b] = [b, a]
  let prev = new Array(b.length + 1).fill(0)
  let best = 0
  for (let i = 0; i < a.length; i++) {
    const cur = new Array(b.length + 1).fill(0)
    const ca = a[i]
    for (let j = 1; j <= b.length; j++) {
      if (ca === b[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) best = cur[j]
      }
    }
    prev = cur
  }
  return best
}

export function pickSeeds(g, query, { seeds: seedMax = 5 } = {}) {
  const terms = String(query || '').replace(/\u3000/g, ' ').split(/\s+/)
    .filter(Boolean).map((t) => t.toLowerCase())
  if (!terms.length) return []
  const degree = {}
  for (const [id, edges] of Object.entries(g.adj || {})) {
    let d = 0
    for (const e of edges) d += Number(e.w) || 0
    degree[id] = d
  }
  const out = []
  for (const [id, n] of Object.entries(g.nodes || {})) {
    const title = String(n.title || '')
    const blob = `${title}${n.text || ''}`.toLowerCase()
    const tlow = title.toLowerCase()
    let score = 0
    for (const t of terms) {
      if (tlow.includes(t)) { score += 1.5; continue }
      if (blob.includes(t)) { score += 1.0; continue }
      // 沾边：最长公共子串，够长才算（中文两字起）
      const n2 = lcsLen(t, blob)
      if (n2 >= 2) {
        const ratio = n2 / t.length
        const bonus = lcsLen(t, tlow) >= 2 ? 0.3 : 0
        if (ratio + bonus >= 0.45) score += Math.min(1.0, ratio + bonus)
      }
    }
    if (score > 0) {
      out.push({ id, score, kind: n.kind, deg: degree[id] || 0, len: (n.text || '').length })
    }
  }
  // 同分：memory 优先 → 边权重大的（真联得上别的记忆）→ 正文短的
  out.sort((a, b) => b.score - a.score
    || (a.kind === 'memory' ? 0 : 1) - (b.kind === 'memory' ? 0 : 1)
    || b.deg - a.deg || a.len - b.len)
  return out.slice(0, seedMax)
}

export function assocFromGraph(g, query, {
  min = 0.8, top = 6, hops = 2, clip = (s, n) => s.slice(0, n),
} = {}) {
  if (!g?.nodes || !g?.adj) return []
  const picked = pickSeeds(g, query)
  if (!picked.length) return []
  const score = new Map()
  const visited = new Set()
  for (const s of picked) { score.set(s.id, 1); visited.add(s.id) }
  let frontier = picked.map((s) => s.id)
  for (let hop = 1; hop <= hops; hop++) {
    const cand = new Map()
    for (const src of frontier) {
      for (const e of (g.adj[src] || []).slice(0, 12)) {
        if (visited.has(e.dst)) continue
        const want = e.w * Math.pow(0.7, hop - 1)
        if (!(cand.get(e.dst) >= want)) cand.set(e.dst, want)
      }
    }
    if (!cand.size) break
    for (const [k, v] of cand) { score.set(k, Math.max(score.get(k) || 0, v)); visited.add(k) }
    frontier = [...cand.keys()]
  }
  const seedIds = new Set(picked.map((s) => s.id))
  const weightOf = (id) => {
    const w = Number(g.nodes?.[id]?.weight ?? 1)
    return Number.isFinite(w) && w > 0 ? Math.min(1, w) : 1
  }
  return [...score.entries()]
    .filter(([id, s]) => !seedIds.has(id) && s >= min && weightOf(id) >= 0.4)
    .sort((a, b) => b[1] * weightOf(b[0]) - a[1] * weightOf(a[0]))
    .slice(0, top)
    .map(([id, s]) => {
      const n = g.nodes[id] || {}
      return {
        score: Math.round(s * weightOf(id) * 100) / 100,
        id,
        kind: n.kind,
        title: n.title,
        source: n.source,
        section: n.section,
        excerpt: clip(String(n.text || '').replace(/\s+/g, ' '), 80),
      }
    })
}

/* ---------------------------------------------------------------- 双链推荐 */
// 和 memory-graph/suggest_links.py 同一套规则：写完一段话，看看该挂哪几个 [[键]]。
// 中文按三字片段（共享 2 字太容易误报），英文按单词；种子 ≤5，一跳扩散只走
// link/cooccur 这种实边（w ≥ 1，同小节/同日记的结构边不推）。

const CJK_RUN = /[\u3400-\u9fff]+/g
const TOK = /[A-Za-z0-9][A-Za-z0-9_.\-]{2,}/g
const LINK = /\[\[([^\]]{1,40})\]\]/g

function cjkTrigrams(s) {
  const out = new Set()
  for (const run of String(s).match(CJK_RUN) || []) {
    for (let i = 0; i + 3 <= run.length; i++) out.add(run.slice(i, i + 3))
  }
  return out
}

function asciiTokens(s) {
  const out = new Set()
  for (const t of String(s).match(TOK) || []) out.add(t.toLowerCase())
  return out
}

function linkedKeys(s) {
  const out = new Set()
  for (const m of String(s).matchAll(LINK)) out.add(m[1].trim())
  return out
}

export function suggestLinks(g, text, { top = 5, min = 0.8 } = {}) {
  const nodes = g?.nodes || {}
  const adj = g?.adj || {}
  const src = String(text || '')
  const low = src.toLowerCase()
  const tri = cjkTrigrams(low)
  const tok = asciiTokens(low)
  const hits = []
  const already = linkedKeys(src)   // 正文里已经手挂的键不再当种子，别占名额
  for (const [id, n] of Object.entries(nodes)) {
    const title = String(n.title || '')
    if (already.has(title.trim())) continue
    // 遗忘权重：钉子 1.0，久未提及会衰减；低于 0.4 就别再推了（但记忆本身不删）
    const wgtRaw = Number(n.weight ?? 1)
    const wgt = Number.isFinite(wgtRaw) && wgtRaw > 0 ? Math.min(1, wgtRaw) : 1
    if (wgt < 0.4) continue
    const tl = title.toLowerCase()
    const blob = `${tl}${String(n.text || '').toLowerCase()}`
    let score = 0
    let why = ''
    if (tl && low.includes(tl)) {
      hits.push({ id, score: 3 * wgt, why: `直接写了键名「${title}」` })
      continue
    }
    const seg = tl.split('.').pop()
    if (seg.length >= 2 && low.includes(seg)) {
      score = 2.4
      why = `提到「${title.split('.').pop()}」`
    }
    const shared = []
    const nodeTri = cjkTrigrams(blob)
    for (const t of tri) if (nodeTri.has(t)) shared.push(t)
    if (shared.length) {
      const kw = Math.min(2.2, 0.8 + 0.25 * shared.length)
      if (kw > score) { score = kw; why = `共同片段 ${shared.length} 处` }
    }
    const common = []
    for (const t of tok) if (new Set(String(blob).match(TOK) || []).has(t)) common.push(t)
    if (common.length) {
      const kw = Math.min(2.2, 0.6 + 0.45 * common.length)
      if (kw > score) { score = kw; why = `共同词：${common.slice(0, 4).join('、')}` }
    }
    if (score > 0) hits.push({ id, score: score * wgt, why })
  }
  // 同分：memory 优先，然后出度大的（和 suggest_links.py 一致）
  hits.sort((a, b) => b.score - a.score
    || (nodes[a.id]?.kind === 'memory' ? 0 : 1) - (nodes[b.id]?.kind === 'memory' ? 0 : 1)
    || (adj[b.id]?.length || 0) - (adj[a.id]?.length || 0))
  if (!hits.length) return []

  const best = new Map()   // id -> {score, why, via}
  for (const h of hits.slice(0, 5)) best.set(h.id, { score: h.score, why: h.why, via: '' })
  for (const h of hits.slice(0, 5)) {
    for (const e of (adj[h.id] || [])) {
      const w = Math.min(Number(e.w) || 0, 3)
      if (w < 1) continue
      const ds = Math.min(h.score, 3) / 3 * w * 0.7
      const cur = best.get(e.dst)
      if (!cur || ds > cur.score) {
        best.set(e.dst, { score: ds, why: '', via: nodes[h.id]?.title || h.id })
      }
    }
  }
  const out = []
  for (const [id, v] of best) {
    const n = nodes[id] || {}
    if (n.kind !== 'memory' || !n.title) continue
    const wRaw = Number(n.weight ?? 1)
    const w = Number.isFinite(wRaw) && wRaw > 0 ? Math.min(1, wRaw) : 1
    if (w < 0.4) continue
    if (already.has(n.title.trim()) || v.score < min) continue
    out.push({ key: n.title, score: Math.round(v.score * w * 100) / 100, why: v.why, via: v.via, section: n.section })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, top)
}
