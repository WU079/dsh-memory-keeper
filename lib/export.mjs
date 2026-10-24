/**
 * lib/export.mjs —— 把 DSH 会话（zstd 帧）导出成「只有对话」的 Markdown
 * ============================================================================
 * 原始逻辑来自作者自己的 export-sessions.mjs（2026-10 在 QQ 桥接上跑了一个月），
 * 这里抽成纯函数 + 可配路径：
 *   · 只读 `$DSH_HOME/sessions/**`，**绝不写回**（除非显式开启 archive，且只用 rename 移动）
 *   · 跳过最近 10 分钟还在写的会话（正在跑的会话不要在别人脚下抽地板）
 *   · 只留 user/assistant 的 text 正文，剥掉 system-reminder / 注入 / 思考过程 / 工具调用
 *   · 每条消息带 `〔会话#seq〕` 出处，方便回原文
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import {
  atomicWrite, clip, ensureDir, fileStat, listDir, localDay, localTime,
  nowIso, readJson, readText, relPosix, safeName, toPosix, writeJson,
} from './util.mjs'
import {
  indexJsonPath, indexMdPath, sessionsDirOf,
} from './store.mjs'
import { workspaceName } from './config.mjs'

/** zstd frame magic：0x28 0xB5 0x2F 0xFD */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 最近 10 分钟还在写的会话先不动 */
export const WAIT_MS = 10 * 60 * 1000

/* --------------------------------------------------------- 读会话文件 */

/** 把 .zstd 文件按 frame 切开、逐帧解压、按行 JSON.parse；坏帧/半行跳过 */
export function readSession(file) {
  const buf = fs.readFileSync(file)
  const cuts = []
  let p = 0
  while ((p = buf.indexOf(ZSTD_MAGIC, p)) !== -1) { cuts.push(p); p += 4 }
  const parts = []
  for (let i = 0; i < cuts.length; i++) {
    const s = cuts[i]
    const e = i + 1 < cuts.length ? cuts[i + 1] : buf.length
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(s, e))) } catch { /* 坏帧 */ }
  }
  const text = Buffer.concat(parts).toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* 半行 */ }
  }
  return events
}

/* ----------------------------------------------------------- 文本清洗 */

export function cleanText(t) {
  let s = String(t ?? '')
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '\n')
  s = s.replace(/[ \t]+$/gm, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/** 系统注入的"假用户消息"（编译器/宿主塞进去的 context） */
export function isInjected(t) {
  const s = String(t ?? '')
  return /^Current runtime context/i.test(s)
    || /^You are an AI agent/i.test(s)
    || /^Additional instructions from:/i.test(s)
    || /^<system-reminder>/i.test(s)
    || /^Instructions from:/i.test(s)
    || /^Time sampled while preparing/i.test(s)
    || /^Browser time zone/i.test(s)
    || (/^\[Compressed conversation section\]/i.test(s) && s.length > 2000)
}

export function textOf(parts) {
  if (!Array.isArray(parts)) return ''
  return parts.map((p) => {
    if (!p || typeof p !== 'object') return ''
    if (p.type === 'text') return String(p.text ?? '')
    if (p.type === 'image' || p.type === 'image_url') return '［图片］'
    return ''
  }).filter(Boolean).join('\n').trim()
}

/* -------------------------------------------------------------- 命名 */

/** slug 解码：`--F-~0077~006F~0072~006B--` → `work`（宿主把非 ASCII 转成了 ~hex）。 */
export function decodeSlug(slug) {
  return String(slug ?? '')
    .replace(/~([0-9A-Fa-f]{2,6})(?=[^0-9A-Fa-f]|$)/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/^-+|-+$/g, '')
    .replace(/^[A-Za-z]-/, '')
    .replace(/--+/g, '_')
    .replace(/[\\/:*?"<>|]/g, '_')
}

/** 会话目录名 → 会话 id（去掉可选的 `session-` 前缀） */
export function sessionIdOf(dirName) {
  return String(dirName ?? '').replace(/^session-/, '')
}

/** 8 位短 id（文件名用） */
export function shortId(dirName) {
  return safeName(sessionIdOf(dirName).slice(0, 8), 'session')
}

/* ------------------------------------------------------------ 渲染 */

/**
 * events → Markdown
 * @returns {{ md: string, turns: number, msgs: number, title: string, cwd: string, createdAt: number|null }}
 */
export function render(events, meta, labels = {}) {
  const userLabel = labels.userLabel || '用户'
  const assistantLabel = labels.assistantLabel || '助手'
  const id = meta.id || '?'
  const id8 = shortId(id)
  let title = meta.title || ''
  let cwd = meta.cwd || ''
  let createdAt = meta.createdAt || null
  const lines = []
  let turns = 0
  let msgs = 0
  const body = []

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {}
    if (ev.type === 'session') {
      // 会话头事件的字段在顶层（有的版本也可能包一层 data），两边都认
      if (!cwd && (ev.cwd || data.cwd)) cwd = ev.cwd || data.cwd
      if (!createdAt && (ev.createdAt || data.createdAt)) createdAt = ev.createdAt || data.createdAt
    } else if (ev.type === 'session/title') {
      if (data.title) title = String(data.title)
    } else if (ev.type === 'turn/start') {
      turns++
    } else if (ev.type === 'user/message') {
      const src = data.source && data.source.kind
      if (src === 'system' || src === 'subagent' || src === 'delegate') continue
      const t = cleanText(textOf(data.content))
      if (!t) continue
      if (isInjected(t)) continue
      if (t.startsWith('[自动继续]')) continue    // 桥接的自动续跑模板话，不算对话
      const seq = ev.seq ?? '?'
      body.push(`**${userLabel}：**〔${id8}#${seq}〕`, '', t, '')
      msgs++
    } else if (ev.type === 'assistant/message') {
      const m = data.message && typeof data.message === 'object' ? data.message : {}
      const t = textOf(m.content)
      if (!t) continue
      const seq = ev.seq ?? '?'
      body.push(`**${assistantLabel}：**〔${id8}#${seq}〕`, '', t, '')
      msgs++
    }
  }

  const when = createdAt ? localTime(new Date(createdAt)) : '?'
  lines.push(`# 会话 ${id}`, '')
  lines.push(`- 时间：${when} 起`)
  lines.push(`- 工作目录：${cwd || '（未知）'}`)
  if (title) lines.push(`- 标题：${title}`)
  lines.push(`- 消息数：${msgs}　轮次：${turns}`)
  lines.push('')
  lines.push('> 只保留对话正文；思考过程、工具调用与系统注入已剔除。')
  lines.push('> 每条消息末尾的〔会话#seq〕是原始会话文件里的出处。')
  lines.push('')
  const md = `${lines.join('\n')}\n${body.join('\n')}`.replace(/\n{3,}/g, '\n\n')
  return { md, turns, msgs, title, cwd, createdAt }
}

/* ------------------------------------------------------------ 索引 */

export function loadIndex(dataDir) {
  const raw = readJson(indexJsonPath(dataDir), null)
  if (!raw || typeof raw !== 'object') return { version: 1, sessions: {} }
  if (!raw.sessions || typeof raw.sessions !== 'object') raw.sessions = {}
  raw.version = raw.version || 1
  return raw
}

export function renderIndexMd(dataDir, idx) {
  const rows = Object.entries(idx.sessions)
    .filter(([, v]) => v && v.file)
    .sort((a, b) => String(b[1].exportedAt).localeCompare(String(a[1].exportedAt)))
    .map(([id, v]) => {
      const when = v.exportedAt ? localTime(new Date(v.exportedAt)) : '?'
      const title = clip(String(v.title || '').replace(/\|/g, '\\|'), 60)
      const ws = String(v.workspace || '').replace(/\|/g, '\\|')
      return `| ${when} | ${ws} | ${id.replace(/^session-/, '').slice(0, 8)} | ${v.msgs ?? 0} | ${title} | ${v.file} |`
    })
  const head = '# 会话备份目录\n\n'
    + `> 由 dsh-memory-keeper 自动生成；共 ${rows.length} 个会话。最近导出的在上面。\n`
    + '> 正文里每条消息带〔会话#seq〕出处，可以回到会话原始文件。\n\n'
    + '| 导出时间 | 工作区 | 会话 | 消息数 | 标题 | 文件 |\n'
    + '| --- | --- | --- | --- | --- | --- |\n'
  return head + (rows.length ? `${rows.join('\n')}\n` : '')
}

export function writeIndex(dataDir, idx) {
  writeJson(indexJsonPath(dataDir), idx)
  atomicWrite(indexMdPath(dataDir), renderIndexMd(dataDir, idx))
}

/* ------------------------------------------------------------ 扫描 */

/**
 * 扫出所有会话目录
 * @returns {Array<{ slug:string, dirName:string, dir:string, file:string|null, mtime:number, newest:boolean }>}
 */
export function scanSessions(sessionRoot) {
  const out = []
  for (const slugEnt of listDir(sessionRoot, (d) => d.isDirectory())) {
    const slugDir = path.join(sessionRoot, slugEnt.name)
    const entries = listDir(slugDir, (d) => d.isDirectory())
    const items = entries.map((ent) => {
      const dir = path.join(slugDir, ent.name)
      const file = path.join(dir, 'session.v4.jsonl.zstd')
      const st = fileStat(file)
      return { slug: slugEnt.name, dirName: ent.name, dir, file: st ? file : null, mtime: st?.mtimeMs ?? 0 }
    }).sort((a, b) => b.mtime - a.mtime)
    items.forEach((it, i) => { it.newest = i === 0 })
    out.push(...items)
  }
  return out
}

/**
 * 导出（增量）
 * @param {object} opts
 * @param {string} opts.sessionRoot  $DSH_HOME/sessions（只读）
 * @param {string} opts.dataDir      数据目录
 * @param {object} opts.cfg          配置（userLabel/assistantLabel）
 * @param {boolean} [opts.force]     重新生成全部
 * @param {number} [opts.limit]      本次最多处理几个
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.log]
 */
export function exportAll({ sessionRoot, dataDir, cfg = {}, force = false, limit = 0, signal, log }) {
  const started = Date.now()
  ensureDir(sessionsDirOf(dataDir))
  const idx = loadIndex(dataDir)
  const now = Date.now()
  const result = { ok: true, scanned: 0, exported: 0, skipped: 0, empty: 0, failed: 0, files: [], errors: [], tookMs: 0 }

  const all = scanSessions(sessionRoot)
  result.scanned = all.length
  const todo = []
  for (const s of all) {
    if (!s.file) { result.skipped++; continue }              // 没有 log 文件
    if (now - s.mtime < WAIT_MS) { result.skipped++; continue } // 还在写
    if (!force && idx.sessions[s.dirName]) { result.skipped++; continue } // 已导出
    todo.push(s)
  }
  todo.sort((a, b) => a.mtime - b.mtime)                      // 先导老的
  const batch = limit > 0 ? todo.slice(0, limit) : todo

  for (const s of batch) {
    if (signal?.aborted) break
    try {
      const events = readSession(s.file)
      const head = events.find((e) => e.type === 'session') || {}
      const hd = head.data && typeof head.data === 'object' ? head.data : {}
      const meta = {
        id: sessionIdOf(head.id || hd.id || sessionIdOf(s.dirName)),
        cwd: head.cwd || hd.cwd || '',
        createdAt: head.createdAt || hd.createdAt || s.mtime,
      }
      const { md, turns, msgs, title, cwd, createdAt } = render(events, meta, cfg)
      const ws = cwd && /^[A-Za-z]:[\\/]/.test(cwd) ? workspaceName(cwd) : (decodeSlug(s.slug) || 'default')
      // 子代理会话（origin=subagent / 有 parentSession）是主会话派出去的干活记录，
      // 默认不当「对话」导出，只记一笔，免得搜索结果被机器人的中间步骤塞满。
      const isSub = head.origin === 'subagent' || Boolean(head.parentSession)
      if (isSub) {
        idx.sessions[s.dirName] = {
          file: null, empty: true, subagent: true, msgs: 0, turns: 0, workspace: ws,
          exportedAt: nowIso(), slug: s.slug, title: '',
        }
        result.skipped++
        log?.(`跳过子代理会话 ${s.dirName}`)
        continue
      }
      if (msgs < 2) {
        idx.sessions[s.dirName] = {
          file: null, empty: true, msgs, turns, workspace: ws,
          exportedAt: nowIso(), slug: s.slug, title: title || '',
        }
        result.empty++
        log?.(`空会话 ${s.dirName}（${msgs} 条）`)
        continue
      }
      const wsDir = path.join(sessionsDirOf(dataDir), safeName(ws, 'default'))
      ensureDir(wsDir)
      const day = localDay(new Date(createdAt || s.mtime))
      const outFile = path.join(wsDir, `${day}_${shortId(s.dirName)}.md`)
      atomicWrite(outFile, md)
      idx.sessions[s.dirName] = {
        file: relPosix(dataDir, outFile),
        exportedAt: nowIso(),
        msgs,
        turns,
        workspace: ws,
        slug: s.slug,
        cwd: cwd || '',
        title: title || '',
        bytes: Buffer.byteLength(md, 'utf8'),
      }
      result.exported++
      result.files.push(idx.sessions[s.dirName].file)
      log?.(`导出 ${s.dirName} → ${idx.sessions[s.dirName].file}（${msgs} 条）`)
    } catch (e) {
      result.failed++
      result.errors.push({ session: s.dirName, error: String(e?.message || e) })
      log?.(`导出失败 ${s.dirName}：${e?.message || e}`)
    }
  }

  writeIndex(dataDir, idx)
  result.tookMs = Date.now() - started
  result.ok = result.failed === 0
  return { result, index: idx }
}

/* ------------------------------------------------------------ 归档 */

/**
 * 把够老、已导出、且不是该工作区最新的会话移进 `$DSH_HOME/sessions-archive/`
 * 只对 `$DSH_HOME/sessions` 里的目录用 rename，不动文件内容。
 */
export function archiveOld({ sessionRoot, archiveRoot: archRoot, dataDir, keepDays = 14, signal, log, dryRun = false }) {
  const started = Date.now()
  const result = { ok: true, moved: [], skipped: 0, errors: [], tookMs: 0, dryRun }
  const idx = loadIndex(dataDir)
  const now = Date.now()
  const all = scanSessions(sessionRoot)
  for (const s of all) {
    if (signal?.aborted) break
    if (!s.file) { result.skipped++; continue }
    const ageDays = (now - s.mtime) / 86400000
    if (ageDays <= keepDays) { result.skipped++; continue }
    if (s.newest) { result.skipped++; continue }             // 每个工作区的最新会话永远留着
    const entry = idx.sessions[s.dirName]
    if (!entry || entry.empty === true) { result.skipped++; continue }  // 没导出成功的不动
    try {
      if (!dryRun) {
        const dest = path.join(archRoot, s.slug, s.dirName)
        ensureDir(path.dirname(dest))
        if (fs.existsSync(dest)) { result.skipped++; continue }
        fs.renameSync(s.dir, dest)
        entry.archivedTo = relPosix(archRoot, dest)
        entry.archivedAt = nowIso()
      }
      result.moved.push(s.dirName)
      log?.(`归档 ${s.dirName}（${ageDays.toFixed(0)} 天未动）`)
    } catch (e) {
      result.errors.push({ session: s.dirName, error: String(e?.message || e) })
      log?.(`归档失败 ${s.dirName}：${e?.message || e}`)
    }
  }
  if (!dryRun) writeIndex(dataDir, idx)
  result.ok = result.errors.length === 0
  result.tookMs = Date.now() - started
  return result
}

/* ------------------------------------------------------------ 备份 */

/**
 * 可选 GitHub 备份：在数据目录里 git init/add/commit/push。
 * 只有配了 `githubRemote` 才会被调用；失败只记录，不抛（备份不该拖垮导出）。
 * @returns {{ ok: boolean, committed: boolean, pushed: boolean, error: string|null }}
 */
export function gitBackup({ dataDir, remote, push = false, branch = 'main', log }) {
  const run = (args, opts = {}) => spawnSync('git', args, {
    cwd: dataDir, encoding: 'utf8', windowsHide: true, timeout: 120_000, ...opts,
  })
  try {
    ensureDir(dataDir)
    // 备份仓库里不塞 .bak（每次写主档都会多一份，纯噪音）
    const ignoreFile = path.join(dataDir, '.gitignore')
    if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*.bak\n', 'utf8')
    const gitDir = path.join(dataDir, '.git')
    if (!fs.existsSync(gitDir)) {
      const r = run(['init', '-b', branch])
      if (r.error) throw r.error
      if (r.status !== 0) throw new Error((r.stderr || 'git init 失败').trim())
    }
    if (remote) {
      const cur = run(['remote', 'get-url', 'origin'])
      const url = (cur.stdout || '').trim()
      if (url !== remote) {
        run(['remote', 'remove', 'origin'])
        const r = run(['remote', 'add', 'origin', remote])
        if (r.status !== 0) throw new Error((r.stderr || 'git remote add 失败').trim())
      }
    }
    const add = run(['add', '-A'])
    if (add.status !== 0) throw new Error((add.stderr || 'git add 失败').trim())
    const st = run(['status', '--porcelain'])
    if (st.status !== 0) throw new Error((st.stderr || 'git status 失败').trim())
    let committed = false
    if ((st.stdout || '').trim()) {
      const c = run([
        '-c', 'user.name=dsh-memory-keeper',
        '-c', 'user.email=dsh-memory-keeper@localhost',
        'commit', '-m', `memory backup ${nowIso()}`,
      ])
      if (c.status !== 0) throw new Error((c.stderr || 'git commit 失败').trim())
      committed = true
      log?.(`备份：已 commit（${(st.stdout || '').trim().split('\n').length} 个文件改动）`)
    }
    let pushed = false
    if (push && remote) {
      const p = run(['push', '-u', 'origin', branch])
      if (p.status !== 0) throw new Error((p.stderr || 'git push 失败').trim())
      pushed = true
      log?.('备份：已 push 到远端')
    }
    return { ok: true, committed, pushed, error: null }
  } catch (e) {
    const msg = String(e?.message || e)
    log?.(`备份失败：${msg}`)
    return { ok: false, committed: false, pushed: false, error: msg }
  }
}

export { toPosix, nowIso, readText }
