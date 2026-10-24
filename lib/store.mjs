/**
 * lib/store.mjs —— 数据目录里的东西：MEMORY.md 主档、日记、搜索、状态视图
 * ============================================================================
 * 写主档的规矩（照 agent-ws/work/memory-merge.md，作者踩过坑）：
 *   ① 写前留 .bak；② 只做定点追加/整节替换，**绝不整篇重写**，原有内容一律保留；
 *   ③ 返回写前/写后的字节数与 sha256，让调用者能核对。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  backupFile, clip, ensureDir, fileStat, listDir, localDay, localTime, nowIso,
  relPosix, sha256, toPosix, readText, writeJson,
} from './util.mjs'
import { readState, resolveDataDir } from './config.mjs'

/* ------------------------------------------------------------------ 路径 */

export function memoryPath(dataDir) {
  return path.join(dataDir, 'MEMORY.md')
}
export function diaryDirOf(dataDir) {
  return path.join(dataDir, 'diary')
}
export function sessionsDirOf(dataDir) {
  return path.join(dataDir, 'sessions')
}
export function indexJsonPath(dataDir) {
  return path.join(sessionsDirOf(dataDir), 'index.json')
}
export function indexMdPath(dataDir) {
  return path.join(sessionsDirOf(dataDir), 'INDEX.md')
}

/** 建出数据目录骨架（幂等） */
export function ensureLayout(dataDir) {
  ensureDir(dataDir)
  ensureDir(diaryDirOf(dataDir))
  ensureDir(sessionsDirOf(dataDir))
  if (!fs.existsSync(indexJsonPath(dataDir))) {
    writeJson(indexJsonPath(dataDir), { version: 1, sessions: {} })
  }
  return dataDir
}

/* ------------------------------------------------------------ MEMORY.md */

export function readMemory(dataDir) {
  const file = memoryPath(dataDir)
  const text = readText(file)
  return { file, exists: text !== null, text: text ?? '' }
}

const MEMORY_TEMPLATE = `# 长期记忆

<!-- dsh-memory-keeper：mem_write 会往这里追加一条；原有内容不会被整篇重写。 -->

`

function headingRe(name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^(#{1,6})\\s+${esc}\\s*$`, 'i')
}

/** 找某个标题在行数组里的位置；返回 null 或 { start, level, bodyEnd } */
function findSection(lines, name) {
  const re = headingRe(name)
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i].trim())
    if (!m) continue
    const level = m[1].length
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      const hm = /^(#{1,6})\s+/.exec(lines[j])
      if (hm && hm[1].length <= level) { end = j; break }
    }
    return { start: i, level, bodyEnd: end }
  }
  return null
}

/** 单行内容 → 一条记忆（自动补 `- ` 与日期，已带列表符号/标题/引用就不动） */
function formatEntry(content, withDate, dataDir) {
  const text = String(content).replace(/\r\n/g, '\n').trim()
  if (!text) throw new Error('content 是空的，没什么可写')
  const day = localDay()
  const lines = text.split('\n')
  if (lines.length === 1) {
    const isMarkup = /^([-*+]|\d+[.)]|#{1,6}\s|>|\|)/.test(lines[0].trim())
    const base = isMarkup ? lines[0].trim() : `- ${lines[0].trim()}`
    return withDate && !base.includes(`（${day}`) ? `${base}（${day}）` : base
  }
  return text
}

/**
 * 追加一条记忆到主档（可指定节）。
 * @returns {{ file, backup, mode, bytesBefore, bytesAfter, sha256Before, sha256After, section }}
 */
export function appendMemory(dataDir, { content, section, withDate = true }) {
  ensureLayout(dataDir)
  const file = memoryPath(dataDir)
  if (!fs.existsSync(file)) fs.writeFileSync(file, MEMORY_TEMPLATE, 'utf8')
  const before = fs.readFileSync(file)
  const backup = backupFile(file)
  const entry = formatEntry(content, withDate, dataDir)
  let text = before.toString('utf8')
  const lines = text.split('\n')

  if (section) {
    const found = findSection(lines, section)
    if (!found) {
      throw new Error(`主档里没有「${section}」这一节；先自己建好标题，或去掉 section 参数追加到文末`)
    }
    // 插到本节正文末尾（去掉尾部空行再补一个空行）
    let insertAt = found.bodyEnd
    while (insertAt > found.start + 1 && lines[insertAt - 1].trim() === '') insertAt--
    lines.splice(insertAt, 0, entry, '')
    text = lines.join('\n')
  } else {
    if (text && !text.endsWith('\n')) text += '\n'
    text += `${text.trim() ? '\n' : ''}${entry}\n`
  }
  fs.writeFileSync(file, text, 'utf8')
  return {
    file,
    backup,
    mode: 'append',
    section: section || null,
    bytesBefore: before.length,
    bytesAfter: Buffer.byteLength(text, 'utf8'),
    sha256Before: sha256(before),
    sha256After: sha256(Buffer.from(text, 'utf8')),
  }
}

/** 整节替换（只换正文，标题保留） */
export function replaceSection(dataDir, { section, content }) {
  if (!section) throw new Error('replace-section 模式必须给 section（要替换的标题文字）')
  ensureLayout(dataDir)
  const file = memoryPath(dataDir)
  if (!fs.existsSync(file)) throw new Error(`主档还不存在：${file}`)
  const before = fs.readFileSync(file)
  const backup = backupFile(file)
  const lines = before.toString('utf8').split('\n')
  const found = findSection(lines, section)
  if (!found) throw new Error(`主档里没有「${section}」这一节`)
  const body = String(content).replace(/\r\n/g, '\n').trim()
  if (!body) {
    // 允许清空某节正文（标题保留），但要求显式传空字符串并说明——这里只接受空串加提示
    throw new Error('replace-section 的 content 不能为空；要删整节请手动编辑主档')
  }
  const head = lines[found.start]
  const next = [
    ...lines.slice(0, found.start),
    head,
    '',
    ...body.split('\n'),
    '',
    ...lines.slice(found.bodyEnd),
  ]
  const text = next.join('\n').replace(/\n{3,}/g, '\n\n')
  fs.writeFileSync(file, text, 'utf8')
  return {
    file,
    backup,
    mode: 'replace-section',
    section,
    bytesBefore: before.length,
    bytesAfter: Buffer.byteLength(text, 'utf8'),
    sha256Before: sha256(before),
    sha256After: sha256(Buffer.from(text, 'utf8')),
  }
}

/* --------------------------------------------------------------- 日记 */

export function diaryPath(dataDir, day = localDay()) {
  return path.join(diaryDirOf(dataDir), `${day}.md`)
}

export function appendDiary(dataDir, { content, day = localDay() }) {
  ensureLayout(dataDir)
  const file = diaryPath(dataDir, day)
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null
  const backup = backupFile(file)
  const body = String(content).replace(/\r\n/g, '\n').trim()
  if (!body) throw new Error('content 是空的，没什么可写')
  let text = before ? before.toString('utf8') : `# ${day}\n`
  if (!text.endsWith('\n')) text += '\n'
  text += `\n${body}\n`
  fs.writeFileSync(file, text, 'utf8')
  return {
    file,
    backup,
    mode: 'append-diary',
    day,
    bytesBefore: before ? before.length : 0,
    bytesAfter: Buffer.byteLength(text, 'utf8'),
    sha256Before: before ? sha256(before) : null,
    sha256After: sha256(Buffer.from(text, 'utf8')),
  }
}

/** 最近 n 天日记文件（按日期倒序） */
export function listDiary(dataDir, n = 3) {
  const dir = diaryDirOf(dataDir)
  const files = listDir(dir, (d) => d.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse()
    .slice(0, n)
  return files.map((name) => {
    const text = readText(path.join(dir, name)) ?? ''
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const heading = lines.find((l) => /^#\s+/.test(l))
    const first = lines.find((l) => !/^#{1,6}\s+/.test(l) && !l.startsWith('<!--'))
    return {
      day: name.replace(/\.md$/, ''),
      file: relPosix(dataDir, path.join(dir, name)),
      title: heading ? heading.replace(/^#\s+/, '') : name.replace(/\.md$/, ''),
      snippet: first ? clip(first, 120) : '',
    }
  })
}

/* --------------------------------------------------------------- 搜索 */

function walkMarkdown(dir, { skip }) {
  const out = []
  const stack = [{ dir, depth: 0 }]
  while (stack.length) {
    const { dir: d, depth } = stack.pop()
    if (depth > 6) continue
    for (const ent of listDir(d, () => true)) {
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) {
        if (skip.includes(ent.name)) continue
        stack.push({ dir: full, depth: depth + 1 })
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        out.push(full)
      }
    }
  }
  return out
}

/**
 * 在 MEMORY.md / diary / sessions 里找关键词
 * @returns {{ hits: Array<{file:string, line:number, text:string}>, scanned: number }}
 */
export function searchAll(dataDir, { query, limit = 20, scope = 'all' }) {
  const q = String(query || '').trim()
  if (!q) throw new Error('query 不能为空')
  const needle = q.toLowerCase()
  const hits = []
  let scanned = 0
  const pushHits = (file, text) => {
    scanned++
    if (hits.length >= limit) return
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue
      hits.push({
        file: relPosix(dataDir, file),
        line: i + 1,
        text: clip(lines[i].trim(), 240),
      })
    }
  }

  const wantMemory = scope === 'all' || scope === 'memory'
  const wantDiary = scope === 'all' || scope === 'diary'
  const wantSessions = scope === 'all' || scope === 'sessions'

  if (wantMemory && hits.length < limit) {
    const { exists, text = '' } = readMemory(dataDir)
    if (exists) pushHits(memoryPath(dataDir), text)
  }
  if (wantDiary && hits.length < limit) {
    const dir = diaryDirOf(dataDir)
    const files = listDir(dir, (d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => path.join(dir, d.name))
      .sort()
      .reverse()
    for (const f of files) {
      if (hits.length >= limit) break
      const t = readText(f)
      if (t !== null) pushHits(f, t)
    }
  }
  if (wantSessions && hits.length < limit) {
    // INDEX.md 只是索引表，搜正文时跳过（不然结果里全是表格行）
    const files = walkMarkdown(sessionsDirOf(dataDir), { skip: [] })
      .filter((f) => path.basename(f).toLowerCase() !== 'index.md')
      .map((f) => ({ f, m: fileStat(f)?.mtimeMs ?? 0 }))
      .sort((a, b) => b.m - a.m)
    for (const { f } of files) {
      if (hits.length >= limit) break
      const t = readText(f)
      if (t !== null) pushHits(f, t)
    }
  }
  return { hits, scanned }
}

/* --------------------------------------------------------------- 状态 */

export function buildStatus(ctx, cfg) {
  const { dir, source } = resolveDataDir(ctx, cfg)
  const state = readState(dir)
  const memStat = fileStat(memoryPath(dir))
  const diary = listDiary(dir, 1)
  const diaryCount = listDir(diaryDirOf(dir), (d) => d.isFile() && d.name.endsWith('.md')).length
  const sessDir = sessionsDirOf(dir)
  const wsDirs = listDir(sessDir, (d) => d.isDirectory())
  let sessionFiles = 0
  for (const d of wsDirs) {
    sessionFiles += listDir(path.join(sessDir, d.name), (x) => x.isFile() && x.name.endsWith('.md')).length
  }
  return {
    ok: true,
    version: readPluginVersion(),
    dataDir: dir,
    dataDirSource: source,
    mode: cfg.writable ? 'rw' : 'readonly',
    files: {
      memory: memStat
        ? { exists: true, bytes: memStat.size, mtime: memStat.mtime }
        : { exists: false, bytes: 0, mtime: null },
      diary: { count: diaryCount, latest: diary[0]?.day ?? null },
      sessions: {
        index: fs.existsSync(indexJsonPath(dir)),
        workspaces: wsDirs.length,
        files: sessionFiles,
        lastExportAt: state.lastExportAt ?? null,
      },
    },
    lastExportAt: state.lastExportAt ?? null,
    lastArchiveAt: state.lastArchiveAt ?? null,
    lastBackupAt: state.lastBackupAt ?? null,
    lastBackupError: state.lastBackupError ?? null,
    backup: {
      remote: cfg.githubRemote || '',
      push: !!cfg.githubPush,
      configured: !!cfg.githubRemote,
    },
    config: cfg,
  }
}

/* -------------------------------------------------------------- 版本号 */

let VERSION = '0.1.0'
try {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (pkg?.version) VERSION = String(pkg.version)
} catch { /* 打包时 package.json 一定在；读不到就用常量 */ }
export function readPluginVersion() {
  return VERSION
}

export { toPosix, nowIso, localTime, clip }
