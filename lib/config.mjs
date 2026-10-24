/**
 * lib/config.mjs —— 插件目录 / 配置 / 数据目录解析 / state.json
 * ============================================================================
 * 两个目录要分清（README 里也写了）：
 *   · 插件目录：`$DSH_HOME/memory-keeper/`  —— 只放 config.json（全局一份）
 *   · 数据目录：默认 `$DSH_HOME/memory/<工作区名>/`，可配置 —— MEMORY.md / diary / sessions
 * 配置以 config.json 为真值来源；设置面板和 /mem 命令都读写它。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  atomicWrite, expandHome, readJson, safeName, writeJson,
} from './util.mjs'

export const PLUGIN_DIR_NAME = 'memory-keeper'

/** 全部配置项与默认值（顺序就是设置页里的顺序） */
export const DEFAULTS = Object.freeze({
  enabled: true,               // 后台自动导出总开关
  autoExport: true,            // 定时器是否真的跑
  dataDir: '',                 // 空 = 自动
  exportIntervalHours: 6,      // 自动导出间隔
  archive: false,              // 是否把超期旧会话移进 sessions-archive
  keepDays: 14,                // 归档阈值
  wakeMaxChars: 2000,          // mem_wake 输出上限
  wakeEntries: 6,              // mem_wake 里主档条目数
  writable: true,              // false = 只读模式（mem_write 拒绝）
  userLabel: '用户',            // 会话导出里的用户称呼
  assistantLabel: '助手',       // 会话导出里的助手称呼
  githubRemote: '',            // 填了才启用 git 备份
  githubPush: false,           // 备份后是否 push
  searchLimit: 20,             // mem_search 默认条数
})

/** 数字项的 clamp 区间 */
export const LIMITS = Object.freeze({
  exportIntervalHours: [1, 168],
  keepDays: [1, 3650],
  wakeMaxChars: [200, 20000],
  wakeEntries: [1, 50],
  searchLimit: [1, 200],
})

const BOOL_KEYS = ['enabled', 'autoExport', 'archive', 'writable', 'githubPush']
const STRING_KEYS = ['dataDir', 'userLabel', 'assistantLabel', 'githubRemote']
const NUMBER_KEYS = Object.keys(LIMITS)

export function normalizeConfig(input) {
  const out = { ...DEFAULTS }
  const src = input && typeof input === 'object' ? input : {}
  for (const k of BOOL_KEYS) {
    if (k in src) out[k] = src[k] === true || src[k] === 'true' || src[k] === 1 || src[k] === '1'
  }
  for (const k of STRING_KEYS) {
    if (k in src && src[k] !== undefined && src[k] !== null) out[k] = String(src[k]).trim()
  }
  for (const k of NUMBER_KEYS) {
    if (k in src && src[k] !== undefined && src[k] !== null && src[k] !== '') {
      const n = Number(src[k])
      if (Number.isFinite(n)) {
        const [lo, hi] = LIMITS[k]
        out[k] = Math.min(hi, Math.max(lo, Math.round(n)))
      }
    }
  }
  // 空字符串的 dataDir 表示"自动"；其它字符串展开 ~ 后原样保留
  if (out.dataDir) out.dataDir = expandHome(out.dataDir) || ''
  if (!out.userLabel) out.userLabel = DEFAULTS.userLabel
  if (!out.assistantLabel) out.assistantLabel = DEFAULTS.assistantLabel
  return out
}

/** 只挑出合法的 patch（用于 POST /config） */
export function pickPatch(body) {
  const patch = {}
  if (!body || typeof body !== 'object') return patch
  for (const k of Object.keys(DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k]
  }
  return patch
}

/** `$DSH_HOME` 根目录（优先宿主给的 dshHomePath，其次环境变量，最后 ~/.dsh） */
export function dshHome(ctx) {
  try {
    const f = ctx?.get?.('dshHomePath')
    if (typeof f === 'function') {
      const p = f()
      if (typeof p === 'string' && p) return p
    }
  } catch { /* 拿不到就走下面的 */ }
  const env = process.env.DSH_HOME
  if (env && env.trim()) return path.resolve(env.trim())
  return path.join(os.homedir(), '.dsh')
}

/** 用宿主 dshHomePath 拼子路径（宿主没这个服务就自己拼） */
export function homePath(ctx, ...segments) {
  try {
    const f = ctx?.get?.('dshHomePath')
    if (typeof f === 'function') {
      const p = f(...segments)
      if (typeof p === 'string' && p) return p
    }
  } catch { /* 走下面 */ }
  return path.join(dshHome(ctx), ...segments)
}

export function pluginDir(ctx) {
  return homePath(ctx, PLUGIN_DIR_NAME)
}

export function configFileOf(ctx) {
  return path.join(pluginDir(ctx), 'config.json')
}

/** 会话原始目录（只读） */
export function sessionsRoot(ctx) {
  return homePath(ctx, 'sessions')
}

/** 归档目录（开启 archive 才会写） */
export function archiveRoot(ctx) {
  return homePath(ctx, 'sessions-archive')
}

/** 默认工作区名：profile 的默认工作目录，取其路径主体 */
export function defaultWorkspaceName(ctx) {
  let dir = ''
  try {
    const wd = ctx?.get?.('workingDirectory')
    if (wd && typeof wd.defaultDirectory === 'string') dir = wd.defaultDirectory
  } catch { /* 下面兜底 */ }
  if (!dir) dir = process.cwd()
  return workspaceName(dir)
}

/** 把一个绝对工作目录变成短名字：`F:\work\my-project` → `work-my-project` */
export function workspaceName(dir) {
  let s = String(dir || '').trim()
  if (!s) return 'default'
  // profile 目录（`<DSH_HOME>/profiles/desktop`）不是真工作区，名字直接用 profile 名，
  // 免得默认数据目录变成 `Users-USER-.dsh-profiles-desktop` 这种一长串。
  const pm = s.match(/[\\/]profiles[\\/]([^\\/]+)[\\/]*$/)
  if (pm) return safeName(pm[1], 'default')
  s = s.replace(/^[A-Za-z]:[\\/]?/, '')            // 去掉盘符
  s = s.replace(/^[\\/]+|[\\/]+$/g, '')
  s = s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
  s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  // 太长就只留最后两段
  if (s.length > 48) {
    const parts = s.split('-').filter(Boolean)
    s = parts.slice(-2).join('-')
  }
  return safeName(s, 'default')
}

/**
 * 解析数据目录
 * @returns {{ dir: string, source: 'config'|'default' }}
 */
export function resolveDataDir(ctx, cfg) {
  if (cfg && cfg.dataDir) return { dir: path.resolve(cfg.dataDir), source: 'config' }
  const ws = defaultWorkspaceName(ctx)
  return { dir: path.join(dshHome(ctx), 'memory', ws), source: 'default' }
}

/** 配置读写器：每次读盘，避免面板/命令/工具三处缓存不一致 */
export class ConfigStore {
  constructor(ctx) {
    this.ctx = ctx
    this.file = configFileOf(ctx)
  }

  read() {
    const raw = readJson(this.file, null)
    return normalizeConfig(raw && typeof raw === 'object' ? raw : {})
  }

  /** 合并写回；返回写后的完整配置 */
  patch(patch) {
    const cur = this.read()
    const next = normalizeConfig({ ...cur, ...pickPatch(patch) })
    writeJson(this.file, next)
    return next
  }

  /** 原子写整份（面板保存用不到，留作 reset） */
  write(cfg) {
    const next = normalizeConfig(cfg)
    atomicWrite(this.file, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }
}

/** 数据目录里的 state.json：上次导出/归档/备份时间与结果 */
export function stateFileOf(dataDir) {
  return path.join(dataDir, 'state.json')
}

export function readState(dataDir) {
  const s = readJson(stateFileOf(dataDir), null)
  return s && typeof s === 'object' ? s : {}
}

export function writeState(dataDir, patch) {
  const next = { ...readState(dataDir), ...patch }
  writeJson(stateFileOf(dataDir), next)
  return next
}

/** 数据目录是否存在/可写（不存在不自动建，避免误以为已配置） */
export function dataDirInfo(dir) {
  try {
    const st = fs.statSync(dir)
    return { exists: st.isDirectory(), dir }
  } catch {
    return { exists: false, dir }
  }
}
