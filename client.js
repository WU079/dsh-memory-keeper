/**
 * dsh-memory-keeper —— 浏览器半端：设置里的一页「跨会话记忆」
 * ============================================================================
 * 约定（抄 dsh-douyin-subagent / dsh-bili-subagent）：
 *   · client bundle 不是 ESM，是自注册脚本：window.__ModuleLoader__.load({ id, factory })
 *   · id 必须等于 package.json 的 name
 *   · 进设置：slots.inject('settings.section', () => slots.register({...}, () => h(Panel)))
 *   · 数据走插件自己挂的 `/api/memory-keeper/*`（同源 fetch，credentials: same-origin）
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-keeper',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback } = React

    const API = '/api/memory-keeper'

    const msg = (e) => String((e && e.message) || e)

    // 错误尽量带上服务端给的 error 文本；拿不到就退回 HTTP 状态。
    const asJson = async (res) => {
      let data = null
      try { data = await res.json() } catch (e) { data = null }
      if (res.ok) {
        if (data && data.ok === false) {
          throw new Error('服务端说不行：' + (data.error || data.message || '没给原因'))
        }
        return data
      }
      const why = (data && (data.error || data.message)) ||
        (res.status === 401 ? '没登录 / 没权限' : res.status === 404 ? '路由没挂上' : '')
      throw new Error('HTTP ' + res.status + (why ? '：' + why : ''))
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const fmtTime = (s) => {
      if (!s) return '还没'
      const d = new Date(s)
      return isNaN(d.getTime()) ? String(s) : d.toLocaleString()
    }
    const fmtBytes = (b) => {
      const n = Number(b)
      if (!isFinite(n) || n <= 0) return '0 B'
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }
    const num = (v, d) => {
      const n = Number(v)
      return isFinite(n) ? n : d
    }

    const CSS = `
[data-mk-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 10px;max-width:680px;}
[data-mk-sec]{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));border-radius:12px;}
[data-mk-h]{font-size:12px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-secondary,#8b9096);}
[data-mk-row]{display:flex;align-items:center;gap:10px;}
[data-mk-row][data-mk-wrap]{flex-wrap:wrap;}
[data-mk-grow]{flex:1;min-width:0;}
[data-mk-label]{font-size:13px;color:var(--dsw-alias-label-primary,#e6e7e9);}
[data-mk-desc]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-mk-path]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#8b9096);word-break:break-all;font-family:ui-monospace,Consolas,monospace;}
[data-mk-input]{width:96px;padding:5px 8px;font-size:13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;color:inherit;}
[data-mk-input][data-mk-wide]{width:100%;}
[data-mk-sw]{width:36px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:rgba(127,127,127,.22);position:relative;cursor:pointer;padding:0;flex:none;}
[data-mk-sw][data-on]{background:#3b82f6;border-color:#3b82f6;}
[data-mk-knob]{position:absolute;top:1px;left:1px;width:16px;height:16px;border-radius:999px;background:#fff;transition:left .15s;}
[data-mk-sw][data-on] [data-mk-knob]{left:17px;}
[data-mk-btn]{padding:7px 16px;font-size:13px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:#3b82f6;color:#fff;border:0;cursor:pointer;}
[data-mk-btn][data-mk-ghost]{background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));}
[data-mk-btn][disabled]{opacity:.5;cursor:default;}
[data-mk-note]{font-size:12px;line-height:18px;}
[data-mk-note][data-mk-ok]{color:#3fb950;}
[data-mk-note][data-mk-bad]{color:#e5534b;}
[data-mk-chips]{display:flex;gap:6px;flex-wrap:wrap;}
[data-mk-chip]{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(127,127,127,.16);}
`

    const Row = ({ label, desc, children }) => h('div', { 'data-mk-row': '', 'data-mk-wrap': '' },
      h('div', { 'data-mk-grow': '' },
        h('div', { 'data-mk-label': '' }, label),
        desc ? h('div', { 'data-mk-desc': '' }, desc) : null),
      children)

    const Switch = ({ on, onChange }) => h('button', {
      'data-mk-sw': '', 'data-on': on ? '' : undefined, type: 'button',
      onClick: () => onChange(!on), 'aria-pressed': Boolean(on),
    }, h('span', { 'data-mk-knob': '' }))

    const Num = ({ value, onChange, min = 0, max = 99999 }) => h('input', {
      'data-mk-input': '', type: 'number', value: String(value ?? ''), min, max,
      onChange: (e) => {
        const n = Number(e.target.value)
        onChange(isFinite(n) ? n : 0)
      },
    })

    const Text = ({ value, onChange, placeholder, wide }) => h('input', {
      'data-mk-input': '', 'data-mk-wide': wide ? '' : undefined, type: 'text',
      value: value ?? '', placeholder,
      style: wide ? { width: '100%' } : undefined,
      onChange: (e) => onChange(e.target.value),
    })

    function Panel() {
      const [cfg, setCfg] = useState(null)
      const [meta, setMeta] = useState({ dataDir: '', dataDirSource: '' })
      const [status, setStatus] = useState(null)
      const [statusErr, setStatusErr] = useState('')
      const [err, setErr] = useState('')
      const [loading, setLoading] = useState(true)
      const [saving, setSaving] = useState(false)
      const [note, setNote] = useState(null)
      const [exporting, setExporting] = useState(false)
      const [exportNote, setExportNote] = useState(null)

      const readStatus = useCallback(async () => {
        try {
          const s = await jget('/status')
          setStatus(s)
          setStatusErr('')
        } catch (e) { setStatusErr(msg(e)) }
      }, [])

      const load = useCallback(async () => {
        setLoading(true); setErr('')
        try {
          const c = await jget('/config')
          if (!c || !c.config) throw new Error('返回里没有 config')
          setCfg(c.config)
          setMeta({ dataDir: c.dataDir || '', dataDirSource: c.dataDirSource || '' })
        } catch (e) {
          setErr(msg(e)); setLoading(false); return
        }
        setLoading(false)
        readStatus()
      }, [readStatus])

      useEffect(() => { load() }, [load])

      const patch = (p) => setCfg((cur) => ({ ...cur, ...p }))

      const save = async () => {
        if (!cfg) return
        setSaving(true); setNote(null)
        try {
          // 只 POST 契约里的键；数字范围交给服务端 clamp。
          const body = {
            enabled: Boolean(cfg.enabled),
            autoExport: Boolean(cfg.autoExport),
            dataDir: cfg.dataDir ?? '',
            writable: Boolean(cfg.writable),
            exportIntervalHours: num(cfg.exportIntervalHours, 6),
            archive: Boolean(cfg.archive),
            keepDays: num(cfg.keepDays, 14),
            wakeMaxChars: num(cfg.wakeMaxChars, 2000),
            wakeEntries: num(cfg.wakeEntries, 6),
            userLabel: cfg.userLabel ?? '',
            assistantLabel: cfg.assistantLabel ?? '',
            githubRemote: cfg.githubRemote ?? '',
            githubPush: Boolean(cfg.githubPush),
          }
          const r = await jpost('/config', body)
          if (r && r.config) setCfg(r.config)
          if (r) setMeta({ dataDir: r.dataDir || meta.dataDir, dataDirSource: r.dataDirSource || meta.dataDirSource })
          setNote({ ok: true, text: '存好了。' })
          readStatus()
        } catch (e) {
          setNote({ ok: false, text: '没存上：' + msg(e) })
        } finally { setSaving(false) }
      }

      const runExport = async () => {
        setExporting(true); setExportNote(null)
        try {
          const r = await jpost('/export', {})
          const x = (r && r.result) || {}
          const parts = ['导出 ' + num(x.exported, 0) + ' 个']
          if (num(x.skipped, 0)) parts.push('跳过 ' + x.skipped + ' 个')
          if (Array.isArray(x.files)) parts.push('文件 ' + x.files.length + ' 个')
          else if (typeof x.files === 'number') parts.push('文件 ' + x.files + ' 个')
          if (num(x.failed, 0)) parts.push('失败 ' + x.failed + ' 个')
          if (num(x.empty, 0)) parts.push('空会话 ' + x.empty + ' 个')
          if (x.tookMs != null) parts.push('用时 ' + Math.max(1, Math.round(num(x.tookMs, 0) / 1000)) + ' 秒')
          setExportNote({ ok: !num(x.failed, 0), text: parts.join('，') + '。' })
          readStatus()
        } catch (e) {
          setExportNote({ ok: false, text: '没导成：' + msg(e) })
        } finally { setExporting(false) }
      }

      if (!cfg) {
        return h('div', { 'data-mk-page': '' },
          h('div', { 'data-mk-note': '', 'data-mk-bad': err ? '' : undefined },
            err ? '读不到配置：' + err : '读取中…'))
      }

      const enabled = Boolean(cfg.enabled)
      const writable = Boolean(cfg.writable)
      const f = (status && status.files) || {}
      const ses = f.sessions || {}
      const mem = f.memory || {}
      const bk = (status && status.backup) || {}
      const mode = (status && status.mode) || (writable ? 'rw' : 'ro')
      const modeText = mode === 'rw' ? '可写' : '只读'
      const source = (status && status.dataDirSource) || meta.dataDirSource || ''
      const sourceText = source === 'default' ? '默认位置' : '自定义位置'
      const dataDir = (status && status.dataDir) || meta.dataDir || '（还没算出来）'
      const chip = (t) => h('span', { key: t, 'data-mk-chip': '' }, t)

      return h('div', { 'data-mk-page': '' },
        h('div', { 'data-mk-sec': '' },
          h('div', { 'data-mk-h': '' }, '① 总开关'),
          h(Row, { label: '后台自己记', desc: '关掉之后定时导出、归档、备份都不跑；mem_* 工具和手动导出还能用。' },
            h(Switch, { on: enabled, onChange: (v) => patch({ enabled: v }) })),
          h(Row, { label: '定时自动导出', desc: '关掉就只在你点「立即导出」时导一次。' },
            h(Switch, { on: Boolean(cfg.autoExport), onChange: (v) => patch({ autoExport: v }) }))),

        h('div', { 'data-mk-sec': '' },
          h('div', { 'data-mk-h': '' }, '② 数据目录'),
          h(Row, { label: '放在哪', desc: '留空 = 自动用 ~/.dsh/memory/<工作区名>。现在这点：' + sourceText },
            h(Text, {
              value: cfg.dataDir, wide: true, placeholder: '留空 = ~/.dsh/memory/<工作区名>',
              onChange: (v) => patch({ dataDir: v }),
            })),
          h(Row, { label: '写入权限（现在：' + (writable ? '可写' : '只读') + '）', desc: '关掉 = 只读模式，mem_write 会被拒绝；查看和搜索不受影响。' },
            h(Switch, { on: writable, onChange: (v) => patch({ writable: v }) }))),

        h('div', { 'data-mk-sec': '' },
          h('div', { 'data-mk-h': '' }, '③ 导出节奏'),
          h(Row, { label: '隔多久导一次（小时）', desc: '1–168，超出范围服务端会自己夹回来。' },
            h(Num, { value: cfg.exportIntervalHours, min: 1, max: 168, onChange: (v) => patch({ exportIntervalHours: v }) })),
          h(Row, { label: '把旧会话归档', desc: '超过下面天数、又没在动的会话挪去 ~/.dsh/sessions-archive；只移动，不删除。' },
            h(Switch, { on: Boolean(cfg.archive), onChange: (v) => patch({ archive: v }) })),
          h(Row, { label: '归档门槛（天）', desc: '1–3650。' },
            h(Num, { value: cfg.keepDays, min: 1, max: 3650, onChange: (v) => patch({ keepDays: v }) })),
          h('div', { 'data-mk-row': '', 'data-mk-wrap': '' },
            h('button', {
              'data-mk-btn': '', type: 'button', disabled: exporting || saving, onClick: runExport,
            }, exporting ? '导出中…' : '立即导出'),
            exportNote ? h('span', {
              'data-mk-note': '', 'data-mk-ok': exportNote.ok ? '' : undefined, 'data-mk-bad': exportNote.ok ? undefined : '',
            }, exportNote.text) : null)),

        h('div', { 'data-mk-sec': '' },
          h('div', { 'data-mk-h': '' }, '④ 醒来摘要'),
          h(Row, { label: '摘要字数上限', desc: '200–20000；mem_wake 返回的全文不超过这个数。' },
            h(Num, { value: cfg.wakeMaxChars, min: 200, max: 20000, onChange: (v) => patch({ wakeMaxChars: v }) })),
          h(Row, { label: '主档带几条', desc: '1–50；醒来摘要里从 MEMORY.md 摘几条。' },
            h(Num, { value: cfg.wakeEntries, min: 1, max: 50, onChange: (v) => patch({ wakeEntries: v }) })),
          h(Row, { label: '「用户」叫什么', desc: '导出对话里你那边的署名。' },
            h(Text, { value: cfg.userLabel, placeholder: '用户', onChange: (v) => patch({ userLabel: v }) })),
          h(Row, { label: '「助手」叫什么', desc: '导出对话里助手那边的署名。' },
            h(Text, { value: cfg.assistantLabel, placeholder: '助手', onChange: (v) => patch({ assistantLabel: v }) }))),

        h('div', { 'data-mk-sec': '' },
          h('div', { 'data-mk-h': '' }, '⑤ 备份'),
          h(Row, { label: 'GitHub 仓库地址', desc: '留空 = 不备份。填了才会把数据目录做 git 提交。' },
            h(Text, {
              value: cfg.githubRemote, wide: true, placeholder: 'git@github.com:you/your-memory.git',
              onChange: (v) => patch({ githubRemote: v }),
            })),
          h(Row, { label: '备份后顺手 push', desc: '需要本机已经配好 SSH key 或 token；关掉就只在本地提交。' },
            h(Switch, { on: Boolean(cfg.githubPush), onChange: (v) => patch({ githubPush: v }) }))),

        h('div', { 'data-mk-sec': '' },
          h('div', { 'data-mk-h': '' }, '⑥ 现在的状态'),
          h('div', { 'data-mk-chips': '' },
            chip('模式：' + modeText),
            chip('目录：' + sourceText),
            chip('会话文件：' + num(ses.files, 0) + ' 个' + (ses.workspaces != null ? ' / ' + ses.workspaces + ' 个工作区' : '')),
            chip('INDEX：' + (ses.index ? '有' : '还没生成')),
            chip('上次导出：' + fmtTime(status && status.lastExportAt)),
            chip('主档：' + (mem.exists ? fmtBytes(mem.bytes) : '还没建')),
            chip('备份：' + (bk.configured ? '已配' + (bk.push ? ' · 会 push' : ' · 只本地') : '没配')),
            chip('上次备份：' + fmtTime(status && status.lastBackupAt)),
            chip('上次归档：' + fmtTime(status && status.lastArchiveAt))),
          h('div', { 'data-mk-desc': '' }, '当前数据目录：'),
          h('div', { 'data-mk-path': '' }, dataDir),
          bk.remote ? h('div', { 'data-mk-path': '' }, '备份仓库：' + bk.remote) : null,
          status && status.lastBackupError
            ? h('div', { 'data-mk-note': '', 'data-mk-bad': '' }, '上次备份出错：' + status.lastBackupError)
            : null,
          statusErr ? h('div', { 'data-mk-note': '', 'data-mk-bad': '' }, '状态没读到：' + statusErr) : null,
          h('div', { 'data-mk-desc': '' }, '改完先点「保存」；「重新读」会重新拉一遍配置和状态。')),

        h('div', { 'data-mk-row': '', 'data-mk-wrap': '' },
          h('button', { 'data-mk-btn': '', type: 'button', disabled: saving, onClick: save }, saving ? '保存中…' : '保存'),
          h('button', { 'data-mk-btn': '', 'data-mk-ghost': '', type: 'button', disabled: loading, onClick: load }, '重新读'),
          note ? h('span', {
            'data-mk-note': '', 'data-mk-ok': note.ok ? '' : undefined, 'data-mk-bad': note.ok ? undefined : '',
          }, note.text) : null,
          err ? h('span', { 'data-mk-note': '', 'data-mk-bad': '' }, '读取出错：' + err) : null),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-memory-keeper')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-memory-keeper: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'memory-keeper', order: 32, label: '跨会话记忆' },
          () => h(Panel),
        ))
      },
    }
  },
})
