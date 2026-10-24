/**
 * lib/util.mjs —— 纯工具函数：路径展开、原子写、备份、哈希、文本截断、日期。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/** `~` / `~/x` / `~\x` → 绝对路径；其它原样 resolve */
export function expandHome(p) {
  if (p === undefined || p === null || p === '') return ''
  let s = String(p).trim()
  if (!s) return ''
  if (s === '~') s = os.homedir()
  else if (/^~[\\/]/.test(s)) s = path.join(os.homedir(), s.slice(2))
  return path.resolve(s)
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 先写临时文件再 rename：断电/崩溃时不会留下半截文件 */
export function atomicWrite(file, data) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

export function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** 把 file 当前内容复制成 `<file>.bak`（覆盖上一份 .bak）。文件不存在返回 null */
export function backupFile(file) {
  if (!fs.existsSync(file)) return null
  const bak = `${file}.bak`
  fs.copyFileSync(file, bak)
  return bak
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function fileStat(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return null
    return { size: st.size, mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs }
  } catch { return null }
}

export function nowIso() {
  return new Date().toISOString()
}

/** 本地日期 YYYY-MM-DD（不转 UTC，避免凌晨归档/日记跑到前一天） */
export function localDay(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d)
  const p = (n) => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`
}

export function localTime(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d)
  const p = (n) => String(n).padStart(2, '0')
  return `${localDay(x)} ${p(x.getHours())}:${p(x.getMinutes())}:${p(x.getSeconds())}`
}

/** 截断到 n 个字符（中文按字符算），超出加省略号 */
export function clip(s, n = 200) {
  const t = String(s ?? '')
  if (t.length <= n) return t
  return `${t.slice(0, Math.max(0, n - 1))}…`
}

/** 目录名/文件名里不能出现的字符 → '-'；空 → fallback */
export function safeName(s, fallback = 'default') {
  const t = String(s ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .slice(0, 64)
  return t || fallback
}

/** 按稳定顺序列出目录下的文件（不存在返回 []） */
export function listDir(dir, filter) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => (filter ? filter(d) : true))
  } catch { return [] }
}

export function toPosix(p) {
  return String(p).replace(/\\/g, '/')
}

/** 相对路径（统一用 /），失败就原样 */
export function relPosix(from, to) {
  try { return toPosix(path.relative(from, to)) } catch { return toPosix(to) }
}
