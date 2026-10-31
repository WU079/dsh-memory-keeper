// 验证插件里的 assoc 逻辑 —— 直接 import 插件那段纯函数，测的就是线上跑的那份。
// 前提：先在当前目录跑过 build.py，生成了 graph.json。
// 用法：node test-assoc.mjs
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const GRAPH = new URL('./graph.json', import.meta.url)
const LIB = new URL('../../lib/assoc.mjs', import.meta.url)
const { assocFromGraph, pickSeeds } = await import(pathToFileURL(LIB).href)
const g = JSON.parse(fs.readFileSync(GRAPH, 'utf8'))

// 换成你自己记忆里的几个主题词
const QUERIES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['记忆图谱', '备份', '视频']

for (const q of QUERIES) {
  const seeds = pickSeeds(g, q).map((s) => `${s.id}(${s.score})`)
  const related = assocFromGraph(g, q, { clip: (s, n) => (s.length > n ? s.slice(0, n) + '…' : s) })
  console.log('\n查询:', q)
  console.log('  种子:', seeds.join(' | ') || '（无）')
  for (const r of related) console.log(`  (${r.score}) [${r.kind}] ${r.title}`)
  if (!related.length) console.log('  （没有顺边能到的）')
}
