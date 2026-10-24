# dsh-memory-keeper

> 给 [DSH](https://github.com/deepseek-ai/deepseek-harness) 的跨会话记忆插件。每个会话都导出一份只含对话的
> Markdown 记录，长期主档 `MEMORY.md` 留着当主文件，新窗口打开时先给一段「醒来摘要」，而不是从一片空白开始。

[English](README.md) | 中文

## 这是什么

`dsh-memory-keeper` 给 agent 一份能跨窗口活下去的记忆。它只读地读 DSH 自己的会话文件，把每段对话变成纯
Markdown、每条都带出处，维护一份长期主档 `MEMORY.md`（agent 可以往里写），并在新会话开头拼出一段精简的
「醒来摘要」。

## 为什么需要

DSH 的会话是彼此隔离的：开个新窗口，上一段对话在 agent 眼里就没了，磁盘上只剩一个压缩过的会话文件，那是给
DSH 自己用的格式，人不好读。长会话还会被压缩，细节悄悄掉出上下文。于是「上周明明交代过」的事，今天就得
从头再说一遍。

这个插件补的就是这一段：

- **会话记录**：每个会话变成 `<dataDir>/sessions/<工作区>/<日期>_<id8>.md`，只留对话（用户 / 助手文本），
  每条消息带 `sessionId#seq` 出处；同时维护一份表格索引 `sessions/INDEX.md` 和机读索引 `sessions/index.json`。
  子代理会话（`origin: subagent` 或带 `parentSession`）是主会话派出去的干活记录，默认不导出，免得搜索结果
  被中间的委派步骤塞满。
- **一份长期主档**：`MEMORY.md`，真正沉淀下来的那个文件，你写、agent 也写。
- **醒来摘要**：`mem_wake` 返回一段有字数上限（`wakeMaxChars`）的摘要。
- **可选的收拾动作**：把超期旧会话归档挪走，也可以把数据目录备份到 git 远端。

没有任何家目录或人设是写死的，`dataDir` 可配。

## 跟 DSH 自带的 memory 工具的区别

DSH 自带 `memory_*` 那套：在 `project` / `user` 两个 scope 下存键值笔记，由 agent 自己决定什么值得记、再靠
搜索取回。它管的是「记一笔事实」——偏好、决定、约定。

本插件管的是另一件事：

| | 自带 `memory_*` 工具 | `dsh-memory-keeper` |
|---|---|---|
| 记忆单位 | 键值库里的一条短笔记 | 整个会话的记录 + `MEMORY.md` |
| 范围 | `project` / `user` | 你自己选的某个数据目录 |
| 取回内容 | 命中关键词的笔记 | 原始对话，带文件和行号出处 |
| 生命周期 | agent 决定要记才写 | 定时导出，旧的归档 |

两者解决的不是同一个问题，可以共存——工具名是 `mem_*` 而不是 `memory_*`，装上本插件不会遮蔽或撞掉自带那套。

## 安装

```bash
# 发到 npm 之后
dsh plugin --profile <你的 profile> add dsh-memory-keeper

# 本地开发
dsh plugin --profile <你的 profile> add link:F:\path\to\dsh-memory-keeper
```

插件声明了 `dsh.bundle`，profile 里只要在 `dsh.profile.bundles` 列出这个包名就生效。装完重启 profile（或
重新加载），`mem_*` 工具就出来了。

然后进 **设置 → 插件 → 跨会话记忆**，配一下数据目录；留空就用默认值。

## 四个工具

### `mem_wake`

无参数。返回「你不在的时候发生了什么」的摘要：数据目录、上次导出时间、读写模式、`MEMORY.md` 前
`wakeEntries` 条、最近三天的日记标题、最近的会话索引，总长度不超过 `wakeMaxChars`。

```
mem_wake
```

### `mem_search`

在数据目录里搜，返回命中的文件、行号和那一行文字。`scope` 可选 `all` | `memory` | `diary` | `sessions`。

```
mem_search { "query": "语音克隆", "limit": 10, "scope": "all" }
```

### `mem_write`

写主档或当天的日记。`target` 是 `memory`（默认）| `diary`；`mode` 是 `append`（默认）或
`replace-section`（必须同时给 `section`）；`section` 指定要替换的小节标题。写之前留 `.bak`，只动目标小节
（或追加到日记末尾），绝不整篇重写；返回写前/写后的字节数与 sha256 供核对。`writable` 为 `false` 时拒绝写入。
可选 `note` 说明这次为什么写（只进插件日志，不写进主档）、`withDate`（单行条目是否补日期，默认 `true`）、
`day`（diary 写哪一天，默认今天）。

```
mem_write { "content": "- 2026-10-24: 插件脚手架开工", "target": "memory", "mode": "append" }
mem_write { "content": "...", "target": "memory", "mode": "replace-section", "section": "事实台" }
mem_write { "content": "今天把面板写完了。", "target": "diary" }
```

### `mem_status`

无参数。返回当前状态：数据目录及来源、模式（只读 / 可读写）、主档大小与修改时间、日记和会话数量、上次
导出 / 归档 / 备份时间、以及当前生效的配置。

```
mem_status
```

## `/mem` 命令

| 命令 | 做什么 |
|---|---|
| `/mem wake` | 同 `mem_wake` 的摘要 |
| `/mem tidy` | 先增量导出，再按配置归档超过 `keepDays` 天且不是最新会话的旧会话（`archive` 关着就只导出） |
| `/mem export` | 立刻导出会话（加 `--force` 重新生成全部） |
| `/mem search <词>` | 同 `mem_search` 的搜索 |
| `/mem status` | 同 `mem_status` 的状态 |

## 设置页

面板在 **设置 → 插件 → 跨会话记忆**。它读写 `$DSH_HOME/memory-keeper/config.json`，和
`/api/memory-keeper/*` 路由用的是同一份文件。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 后台任务总开关 |
| `autoExport` | `true` | 定时器是否真的跑 |
| `dataDir` | `""` | 数据目录；留空 = `$DSH_HOME/memory/<工作区名>` |
| `exportIntervalHours` | `6` | 自动导出间隔（小时），限制在 1–168 |
| `archive` | `false` | 是否把超期旧会话移进 `$DSH_HOME/sessions-archive` |
| `keepDays` | `14` | 归档阈值天数，限制在 1–3650 |
| `wakeMaxChars` | `2000` | `mem_wake` 摘要上限，限制在 200–20000 |
| `wakeEntries` | `6` | 摘要里主档条目数，限制在 1–50 |
| `writable` | `true` | 是否允许 `mem_write`；`false` = 只读模式 |
| `userLabel` | `用户` | 导出记录里「用户」的发言人名字 |
| `assistantLabel` | `助手` | 导出记录里「助手」的发言人名字 |
| `githubRemote` | `""` | 备份用的 git 远端；留空 = 不备份 |
| `githubPush` | `false` | 备份后是否 push |
| `searchLimit` | `20` | `mem_search` 默认条数，限制在 1–200 |

`userLabel` / `assistantLabel` 的默认值就是中文的 `用户` / `助手`，想让导出记录里换别的称呼改这两项即可。

### HTTP 接口

面板走这几条（和 DSH 其它面板一样，走本地已登录的同源请求）：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/memory-keeper/status` | 状态视图（`mem_status` 的内容） |
| `GET` | `/api/memory-keeper/config` | 当前配置 + 默认值 + 解析后的数据目录 |
| `POST` | `/api/memory-keeper/config` | 合并保存配置补丁，返回新配置 |
| `POST` | `/api/memory-keeper/export` | 立刻导出，body 可带 `{ "force": true, "limit": 10 }` |
| `POST` | `/api/memory-keeper/archive` | 归档，body 可带 `{ "dryRun": true }` 只看不动 |
| `GET` | `/api/memory-keeper/search?q=词&limit=20` | 同 `mem_search` |
| `GET` | `/api/memory-keeper/wake` | 同 `mem_wake` |

## 数据目录

`dataDir` 默认是 `$DSH_HOME/memory/<工作区名>`（默认安装下就是 `~/.dsh/memory/<工作区名>`）。想放到同步盘里
就显式配一下。

```
<dataDir>/
  MEMORY.md                 主档：真正沉淀下来的长期记忆
  diary/YYYY-MM-DD.md       一天一份日记
  sessions/INDEX.md         给人看的表格索引
  sessions/index.json       给程序看的索引
  sessions/<wsName>/<YYYY-MM-DD>_<id8>.md
  state.json                 { lastExportAt, lastArchiveAt, lastBackupAt, lastBackupError, lastExportResult }
```

## 安全与只读保证

- **DSH 的会话是只读的**：插件只读 `~/.dsh/sessions/**`，从来不写回、不删除。
- **归档默认关闭且是显式动作**：`archive` 为 `true` 时，超过 `keepDays`、不是本工作区最新、而且已经成功
  导出过一次的会话，才会被 `rename` 移进 `$DSH_HOME/sessions-archive`；没导出过的会话一个都不动，`archive`
  为 `false` 时更不会动。
- **写主档有保护**：动 `MEMORY.md`（或日记文件）之前先留一份 `.bak`，并且只替换目标小节，文件其余部分一个
  字节都不碰。
- **默认不联网**：`githubRemote` 留空就完全不出网。备份只在你填了远端之后才会发生。

## 隐私

会话记录里是完整的对话内容。默认情况下所有东西都只落在本地 `dataDir` 里。别把 `dataDir` 放进公开仓库；如果
开了 GitHub 备份，记得那是在把对话往那个远端推——不放心就别填远端。

## 环境要求

| 件 | 说明 |
|---|---|
| DSH | 0.2.x，且是能装插件的 profile |
| Node.js | >= 22 |

## 许可

MIT，见 [LICENSE](LICENSE)。
