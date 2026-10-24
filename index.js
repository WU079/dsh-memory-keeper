/**
 * dsh-memory-keeper —— 跨会话记忆：会话导出成 Markdown + 长期主档 + 醒来摘要
 * ============================================================================
 * 和 DSH 自带的 memory_* 工具分工：
 *   · 自带那套 = 键值/条目式的 project·user 两 scope 记忆（memories/*.md + 索引）
 *   · 这个插件 = 「会话原文的海马体」：定时把 DSH 会话导出成纯对话 Markdown，
 *     再加一份可以由人和 agent 一起维护的 MEMORY.md 主档，醒来时给你一页摘要。
 * 两者可以同时装，互不打扰（工具名前缀 mem_ 就是为了避让 memory_*）。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

import { loadHostDeps } from './lib/hostdeps.mjs'
import {
  DEFAULTS, PLUGIN_DIR_NAME, ConfigStore, archiveRoot, configFileOf, dshHome,
  normalizeConfig, pickPatch, pluginDir, resolveDataDir, sessionsRoot, writeState,
  readState,
} from './lib/config.mjs'
import {
  appendDiary, appendMemory, buildStatus, ensureLayout, listDiary, readMemory, replaceSection,
  searchAll,
} from './lib/store.mjs'
import { archiveOld, exportAll, gitBackup } from './lib/export.mjs'
import { clip, ensureDir, localTime, nowIso, readText } from './lib/util.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

export const name = PLUGIN_DIR_NAME
export const inject = ['tools', 'commands']
export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(true),
  autoExport: z.boolean().default(true),
  dataDir: z.string().default(''),
  exportIntervalHours: z.natural().default(6),
  archive: z.boolean().default(false),
  keepDays: z.natural().default(14),
  wakeMaxChars: z.natural().default(2000),
  wakeEntries: z.natural().default(6),
  writable: z.boolean().default(true),
  userLabel: z.string().default('用户'),
  assistantLabel: z.string().default('助手'),
  githubRemote: z.string().default(''),
  githubPush: z.boolean().default(false),
  searchLimit: z.natural().default(20),
})

const ROUTE = '/api/memory-keeper'
const VERSION = readVersion()

export function apply(ctx, rawConfig) {
  const store = new ConfigStore(ctx)
  const logFile = path.join(pluginDir(ctx), 'memory-keeper.log')

  const log = (msg) => {
    try {
      ensureDir(path.dirname(logFile))
      fs.appendFileSync(logFile, `[${nowIso()}] ${msg}\n`, 'utf8')
    } catch { /* 日志失败不影响主流程 */ }
  }

  // 首次 apply 时把 cordis 配置里的值并进 config.json（config.json 始终是真值来源）
  try {
    const fromCordis = normalizeConfig({ ...rawConfig })
    const current = readRawConfig()
    const merged = { ...fromCordis, ...current }
    if (JSON.stringify(normalizeConfig(merged)) !== JSON.stringify(store.read())) store.write(merged)
  } catch { /* 首次没有 config.json 很正常 */ }

  function readRawConfig() {
    try {
      const t = readText(configFileOf(ctx))
      return t ? JSON.parse(t) : {}
    } catch { return {} }
  }

  /* ------------------------------------------------------------ 工具函数 */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_a, v) => [{
      type: 'text',
      text: typeof v === 'string' ? v : JSON.stringify(v, null, 2),
    }],
  }
  const safe = (v) => {
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) {
      try {
        return safe(await spec.execute(args || {}, exec))
      } catch (e) {
        return safe({ ok: false, error: String(e?.message || e) })
      }
    },
  }))

  /* ------------------------------------------------------------ 唤醒摘要 */

  function buildWake(cfg, opts = {}) {
    const maxChars = Math.max(200, Number(opts.maxChars) || cfg.wakeMaxChars)
    const wantEntries = Math.max(1, Number(opts.entries) || cfg.wakeEntries)
    const { dir } = resolveDataDir(ctx, cfg)
    const state = readState(dir)
    const mem = readMemory(dir)
    const memLines = mem.exists
      ? mem.text.split(/\r?\n/).map((l) => l.trim())
        .filter((l) => /^[-*+]\s+\S/.test(l) && !/<!--/.test(l))
        .slice(-wantEntries)
      : []
    const diary = listDiary(dir, 3)
    const idx = readIndexJson(dir)
    const recent = Object.entries(idx.sessions)
      .filter(([, v]) => v && v.file)
      .sort((a, b) => String(b[1].exportedAt).localeCompare(String(a[1].exportedAt)))
      .slice(0, 5)

    const out = []
    out.push('# 醒来摘要')
    out.push('')
    out.push(`- 数据目录：${dir}${state.lastExportAt ? `；上次导出：${localTime(new Date(state.lastExportAt))}` : '；还没导出过'}`)
    out.push(`- 主档：${mem.exists ? `${Buffer.byteLength(mem.text, 'utf8')} 字节` : '还没建（第一次 mem_write 会创建）'}；日记 ${diary.length ? `最近 ${diary[0].day}` : '无'}`)
    out.push('')
    out.push('## 主档里最近的几条')
    if (memLines.length) memLines.forEach((l) => out.push(l))
    else out.push('- （主档里还没有条目）')
    out.push('')
    out.push('## 最近日记')
    if (diary.length) diary.forEach((d) => out.push(`- ${d.day}　${d.title}${d.snippet ? `　—　${d.snippet}` : ''}`))
    else out.push('- （还没有日记）')
    out.push('')
    out.push('## 最近导出的会话')
    if (recent.length) {
      recent.forEach(([id, v]) => {
        const sid = String(id).replace(/^session-/, '').slice(0, 8)
        out.push(`- ${v.workspace || '未知工作区'}　${sid}　${v.msgs ?? 0} 条　${clip(v.title || '（无标题）', 60)}`)
      })
    } else out.push('- （还没有导出的会话；跑一次 mem_status 看状态）')
    let text = out.join('\n')
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars - 40)}\n\n…（已截断；找细节用 mem_search）`
    }
    return { ok: true, text, dataDir: dir, lastExportAt: state.lastExportAt ?? null }
  }

  function readIndexJson(dataDir) {
    try {
      const t = readText(path.join(dataDir, 'sessions', 'index.json'))
      const j = t ? JSON.parse(t) : null
      if (j && typeof j === 'object' && j.sessions) return j
    } catch { /* 坏索引当空 */ }
    return { version: 1, sessions: {} }
  }

  /* -------------------------------------------------------------- 导出 */

  function runExport(cfg, { force = false, limit = 0 } = {}) {
    const { dir } = resolveDataDir(ctx, cfg)
    ensureLayout(dir)
    const out = exportAll({
      sessionRoot: sessionsRoot(ctx),
      dataDir: dir,
      cfg,
      force,
      limit,
      log,
    })
    writeState(dir, {
      lastExportAt: nowIso(),
      lastExportResult: out.result,
    })
    let archive = null
    if (cfg.archive) {
      archive = archiveOld({
        sessionRoot: sessionsRoot(ctx),
        archiveRoot: archiveRoot(ctx),
        dataDir: dir,
        keepDays: cfg.keepDays,
        log,
      })
      writeState(dir, { lastArchiveAt: nowIso(), lastArchiveResult: archive })
    }
    let backup = null
    if (cfg.githubRemote) {
      backup = gitBackup({ dataDir: dir, remote: cfg.githubRemote, push: cfg.githubPush, log })
      writeState(dir, backup.ok
        ? { lastBackupAt: nowIso(), lastBackupError: null }
        : { lastBackupError: backup.error })
    }
    return { dataDir: dir, result: out.result, archive, backup }
  }

  /* -------------------------------------------------------------- 工具 */

  tool({
    name: 'mem_wake',
    description: '醒来摘要：主档里最近的几条 + 最近三天日记标题 + 最近导出的会话，一页看完。跨会话记忆入口，先看这个再决定要不要 mem_search。',
    parameters: {
      maxChars: { type: 'number', description: '输出上限字数，默认读配置 wakeMaxChars（2000）' },
      entries: { type: 'number', description: '主档里取最近几条，默认读配置 wakeEntries（6）' },
    },
    async execute(args) {
      return buildWake(store.read(), args)
    },
  })

  tool({
    name: 'mem_search',
    description: '在 MEMORY.md 主档、diary 日记、导出的会话 Markdown 里搜关键词，返回文件+行号+那一行原文（带出处，可回原文）。',
    parameters: {
      query: { type: 'string', required: true, description: '要搜的关键词（不区分大小写）' },
      limit: { type: 'number', description: '最多返回几条，默认读配置 searchLimit（20）' },
      scope: {
        type: 'string',
        enum: ['all', 'memory', 'diary', 'sessions'],
        description: '搜索范围，默认 all',
      },
    },
    async execute(args) {
      const cfg = store.read()
      const { dir } = resolveDataDir(ctx, cfg)
      const limit = Math.min(200, Math.max(1, Number(args.limit) || cfg.searchLimit))
      const r = searchAll(dir, { query: args.query, limit, scope: args.scope || 'all' })
      return {
        ok: true,
        query: args.query,
        dataDir: dir,
        count: r.hits.length,
        hits: r.hits,
        hint: r.hits.length ? '出处格式：文件:行号（相对数据目录）' : '没找到；换个词，或先 mem_wake 看看现在有什么',
      }
    },
  })

  tool({
    name: 'mem_write',
    description: '写长期记忆：往 MEMORY.md 追加一条/整节替换某节正文，或往今天的日记追加一段。写前自动留 .bak、返回 sha256 前后对照；只做定点追加/替换，绝不整篇重写。',
    parameters: {
      content: { type: 'string', required: true, description: '要记的内容；单行会自动加 `- ` 和日期' },
      target: {
        type: 'string',
        enum: ['memory', 'diary'],
        description: 'memory（默认）= 写 MEMORY.md 主档；diary = 追加到今天的 diary/YYYY-MM-DD.md',
      },
      mode: {
        type: 'string',
        enum: ['append', 'replace-section'],
        description: 'append（默认）= 追加一条；replace-section = 整节替换正文，必须给 section',
      },
      section: { type: 'string', description: '目标节的标题文字（不带 # 号），例如「关于我」' },
      note: { type: 'string', description: '可选：这次为什么写（只进日志，不写进主档）' },
      withDate: { type: 'boolean', description: '单行条目是否补日期，默认 true' },
      day: { type: 'string', description: 'diary 用：写哪一天，YYYY-MM-DD，默认今天' },
    },
    async execute(args) {
      const cfg = store.read()
      if (!cfg.writable) {
        return { ok: false, error: '当前是只读模式（设置页里关掉了「可写」），这次没有写盘。' }
      }
      const { dir } = resolveDataDir(ctx, cfg)
      const target = args.target === 'diary' ? 'diary' : 'memory'
      if (target === 'diary') {
        const r = appendDiary(dir, { content: args.content, day: args.day || undefined })
        if (args.note) log(`mem_write/diary（${args.note}）：${r.file} ${r.bytesBefore}→${r.bytesAfter} 字节`)
        return {
          ok: true,
          target,
          mode: r.mode,
          file: r.file,
          backup: r.backup,
          day: r.day,
          bytesBefore: r.bytesBefore,
          bytesAfter: r.bytesAfter,
          sha256Before: r.sha256Before,
          sha256After: r.sha256After,
        }
      }
      const mode = args.mode === 'replace-section' ? 'replace-section' : 'append'
      const r = mode === 'replace-section'
        ? replaceSection(dir, { section: args.section, content: args.content })
        : appendMemory(dir, { content: args.content, section: args.section, withDate: args.withDate !== false })
      if (args.note) log(`mem_write（${args.note}）：${r.file} ${r.bytesBefore}→${r.bytesAfter} 字节`)
      return {
        ok: true,
        target,
        mode,
        file: r.file,
        backup: r.backup,
        section: r.section,
        bytesBefore: r.bytesBefore,
        bytesAfter: r.bytesAfter,
        sha256Before: r.sha256Before,
        sha256After: r.sha256After,
      }
    },
  })

  tool({
    name: 'mem_status',
    description: '看这个插件的状态：数据目录（以及是不是默认值）、主档/日记/会话文件数、上次导出与归档时间、GitHub 备份是否配好。',
    parameters: {},
    async execute() {
      return buildStatus(ctx, store.read())
    },
  })

  /* ------------------------------------------------------------ /mem 命令 */

  function statusText(cfg) {
    const s = buildStatus(ctx, cfg)
    return [
      `数据目录：${s.dataDir}${s.dataDirSource === 'default' ? '（默认位置）' : '（配置）'}`,
      `模式：${s.mode === 'rw' ? '可写' : '只读'}`,
      `主档：${s.files.memory.exists ? `${s.files.memory.bytes} 字节，改于 ${s.files.memory.mtime ?? '?'}` : '还没建'}`,
      `日记：${s.files.diary.count} 篇${s.files.diary.latest ? `，最近 ${s.files.diary.latest}` : ''}`,
      `会话：${s.files.sessions.files} 个文件 / ${s.files.sessions.workspaces} 个工作区`,
      `上次导出：${s.lastExportAt ? localTime(new Date(s.lastExportAt)) : '还没导出'}`,
      `上次归档：${s.lastArchiveAt ? localTime(new Date(s.lastArchiveAt)) : '没开归档或还没跑'}`,
      `备份：${s.backup.configured ? `已配 ${s.backup.remote}${s.backup.push ? '（会 push）' : '（只本地 commit）'}` : '没配（留空即关闭）'}`,
      s.lastBackupError ? `上次备份出错：${s.lastBackupError}` : '',
    ].filter(Boolean).join('\n')
  }

  function exportText(r) {
    const R = r.result
    const lines = [
      `导出完成：新增 ${R.exported}，跳过 ${R.skipped}，空会话 ${R.empty}，失败 ${R.failed}，用时 ${R.tookMs}ms`,
      `数据目录：${r.dataDir}`,
    ]
    if (R.files?.length) lines.push(`本次文件：\n${R.files.map((f) => `- ${f}`).join('\n')}`)
    if (r.archive) lines.push(`归档：移动 ${r.archive.moved.length}，跳过 ${r.archive.skipped}`)
    if (r.backup) lines.push(r.backup.ok ? `备份：${r.backup.committed ? '已 commit' : '无改动'}${r.backup.pushed ? '，已 push' : ''}` : `备份失败：${r.backup.error}`)
    if (R.errors?.length) lines.push(`失败明细：\n${R.errors.map((e) => `- ${e.session}：${e.error}`).join('\n')}`)
    return lines.join('\n')
  }

  function searchText(cfg, q) {
    const { dir } = resolveDataDir(ctx, cfg)
    const r = searchAll(dir, { query: q, limit: cfg.searchLimit, scope: 'all' })
    if (!r.hits.length) return `没搜到「${q}」。`
    return [`搜到 ${r.hits.length} 行（${dir}）：`, ...r.hits.map((h) => `- ${h.file}:${h.line}　${h.text}`)].join('\n')
  }

  function handleMem(input) {
    const raw = String(input || '').trim()
    const [sub = 'wake', ...rest] = raw.split(/\s+/)
    const cfg = store.read()
    const arg = rest.join(' ')
    try {
      switch (sub.toLowerCase()) {
        case 'wake':
        case '':
          return { kind: 'success', text: buildWake(cfg).text }
        case 'status':
          return { kind: 'success', text: statusText(cfg) }
        case 'export':
          return { kind: 'success', text: exportText(runExport(cfg, { force: /--force|-f\b/.test(arg) })) }
        case 'tidy':
          return {
            kind: 'success',
            text: `整理：先增量导出，再按配置${cfg.archive ? `归档超过 ${cfg.keepDays} 天且非最新的会话` : '不归档（archive 关着）'}。\n${exportText(runExport(cfg))}`,
          }
        case 'search':
          if (!arg) return { kind: 'error', text: '用法：/mem search 关键词' }
          return { kind: 'success', text: searchText(cfg, arg) }
        case 'help':
          return {
            kind: 'success',
            text: '/mem wake｜/mem status｜/mem export [--force]｜/mem search 关键词｜/mem tidy',
          }
        default:
          return { kind: 'error', text: `不认识的子命令「${sub}」；可用：wake/status/export/search/tidy/help` }
      }
    } catch (e) {
      log(`/mem ${raw} 出错：${e?.message || e}`)
      return { kind: 'error', text: `出错了：${e?.message || e}` }
    }
  }

  try {
    ctx.effect(
      () => ctx.commands.register({
        name: 'mem',
        description: '跨会话记忆：醒来摘要 / 搜索 / 导出会话 / 状态',
        input: { hint: 'wake | status | export [--force] | search 关键词 | tidy' },
        handler: (invocation) => handleMem(invocation?.rawInput ?? ''),
      }),
      'memory-keeper: /mem 命令',
    )
  } catch (e) {
    log(`注册 /mem 命令失败：${e?.message || e}`)
  }

  /* -------------------------------------------------------------- HTTP */

  const sendJson = (res, code, obj) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(obj))
    } catch { /* 客户端已经断了 */ }
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 256 * 1024) { reject(new Error('请求体太大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const t = Buffer.concat(chunks).toString('utf8').trim()
      if (!t) return resolve({})
      try { resolve(JSON.parse(t)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })

  async function httpHandler(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    let sub = url.pathname.slice(ROUTE.length) || '/'
    if (sub.length > 1 && sub.endsWith('/')) sub = sub.slice(0, -1)
    const method = String(req.method || 'GET').toUpperCase()
    try {
      if (sub === '/status' || sub === '/' || sub === '') {
        return sendJson(res, 200, buildStatus(ctx, store.read()))
      }
      if (sub === '/config') {
        const cfgNow = store.read()
        const resolved = resolveDataDir(ctx, cfgNow)
        if (method === 'GET') {
          return sendJson(res, 200, {
            ok: true, config: cfgNow, defaults: DEFAULTS,
            dataDir: resolved.dir, dataDirSource: resolved.source,
          })
        }
        const body = await readBody(req)
        const next = store.patch(body)
        const after = resolveDataDir(ctx, next)
        log(`面板改了配置：${Object.keys(pickPatch(body)).join(',') || '(空)'}`)
        return sendJson(res, 200, {
          ok: true, config: next,
          dataDir: after.dir, dataDirSource: after.source,
        })
      }
      if (sub === '/export') {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '用 POST' })
        const body = await readBody(req)
        const cfg = store.read()
        const r = runExport(cfg, {
          force: body.force === true,
          limit: Number(body.limit) > 0 ? Number(body.limit) : 0,
        })
        // 面板按顶层字段读（exported/skipped/...），这里摊平一层，别让前端改动
        return sendJson(res, 200, { ok: r.result.ok, ...r.result, result: r.result, dataDir: r.dataDir, archive: r.archive, backup: r.backup })
      }
      if (sub === '/archive') {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '用 POST' })
        const body = await readBody(req)
        const cfg = store.read()
        const { dir } = resolveDataDir(ctx, cfg)
        const r = archiveOld({
          sessionRoot: sessionsRoot(ctx),
          archiveRoot: archiveRoot(ctx),
          dataDir: dir,
          keepDays: cfg.keepDays,
          dryRun: body.dryRun === true,
          log,
        })
        if (!r.dryRun) writeState(dir, { lastArchiveAt: nowIso(), lastArchiveResult: r })
        return sendJson(res, 200, { ok: r.ok, ...r })
      }
      if (sub === '/search') {
        const q = url.searchParams.get('q') || ''
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || store.read().searchLimit))
        const cfg = store.read()
        const { dir } = resolveDataDir(ctx, cfg)
        const r = searchAll(dir, { query: q, limit, scope: url.searchParams.get('scope') || 'all' })
        return sendJson(res, 200, { ok: true, query: q, count: r.hits.length, hits: r.hits, dataDir: dir })
      }
      if (sub === '/wake') {
        return sendJson(res, 200, buildWake(store.read()))
      }
      return sendJson(res, 404, { ok: false, error: `不认识的接口 ${sub}` })
    } catch (e) {
      log(`HTTP ${method} ${sub} 出错：${e?.message || e}`)
      return sendJson(res, 500, { ok: false, error: String(e?.message || e) })
    }
  }

  let webRegistered = false
  const tryRegisterWeb = () => {
    if (webRegistered) return true
    let ws = null
    try { ws = ctx.get('webServer') } catch { /* 没这个服务 */ }
    if (!ws || typeof ws.register !== 'function') return false
    try {
      ctx.effect(() => ws.register({ kind: 'prefix', path: ROUTE, handler: httpHandler }), 'memory-keeper: HTTP 接口')
      webRegistered = true
      log(`HTTP 接口挂上了：${ROUTE}`)
      return true
    } catch (e) {
      log(`HTTP 注册失败：${e?.message || e}`)
      return false
    }
  }
  if (!tryRegisterWeb()) {
    // web bundle 可能比我们晚一步加载；再等两秒试一次，headless 下没有 webServer 就算了
    const t = setTimeout(() => { if (!tryRegisterWeb()) log('没等到 webServer（headless/CLI 下正常）') }, 2000)
    t.unref?.()
  }

  /* ------------------------------------------------------- 后台定时导出 */

  let ticking = false
  const due = (cfg) => {
    const { dir } = resolveDataDir(ctx, cfg)
    const st = readState(dir)
    if (!st.lastExportAt) return true
    const last = Date.parse(st.lastExportAt)
    if (!Number.isFinite(last)) return true
    return Date.now() - last >= cfg.exportIntervalHours * 3600 * 1000
  }

  const tick = () => {
    if (ticking) return
    ticking = true
    try {
      const cfg = store.read()
      if (!cfg.enabled || !cfg.autoExport) return
      if (!due(cfg)) return
      log('定时导出开始')
      const r = runExport(cfg, {})
      log(`定时导出结束：新增 ${r.result.exported}，跳过 ${r.result.skipped}，失败 ${r.result.failed}`)
    } catch (e) {
      log(`定时导出出错：${e?.message || e}`)
    } finally {
      ticking = false
    }
  }

  const timer = setInterval(tick, 60_000)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer), 'memory-keeper: 定时器')
  const first = setTimeout(tick, 60_000)   // 启动后 60s 先跑一次
  first.unref?.()

  log(`插件已加载 v${VERSION}；数据目录 ${resolveDataDir(ctx, store.read()).dir}；宿主依赖：${JSON.stringify(hostDeps.notes || {})}`)
}

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return pkg?.version ? String(pkg.version) : '0.1.0'
  } catch {
    return '0.1.0'
  }
}

/** 宿主根目录（调试用；面板和命令都不依赖它） */
export { dshHome, pluginDir }
