/**
 * dsh-plugin-hop — 跨机接力
 *
 * 把一个项目连同它的会话（对话、待办、目标、压缩摘要）打包到私有 git 仓库，
 * 在另一台装了 DSH 的电脑上拉下来，换成本机路径后继续对话。
 *
 * 设计要点：
 * - 代码走项目自己的 git（快照提交到 hop/<device> 分支，不动工作区 HEAD）。
 * - 状态走私有 relay 仓库：sessions/*.json[.zst] + attachments/*.bin + manifest.json。
 * - 会话通过 sessionPersistence 的公开 API 读写，不直接解析磁盘格式。
 * - 导入时把源路径整串替换为目标路径（需要时）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const execFileP = promisify(execFile)
const BUNDLE_VERSION = 1
const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function'

export const inject = ['tools', 'commands', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'attachments', 'workingDirectory']
/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

function deviceName() {
  return process.env.DSH_HOP_DEVICE ?? os.hostname().replace(/\.local$/, '')
}

function slugify(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'device'
}

function sha1(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 16)
}

function short(text, max = 400) {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

async function runGit(args, cwd, extraEnv = {}) {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv }
    })
    return stdout.trim()
  } catch (error) {
    const detail = short(error?.stderr || error?.stdout || error?.message)
    throw new Error(`git ${args.slice(0, 3).join(' ')} 失败：${detail}`)
  }
}

async function tryGit(args, cwd, extraEnv = {}) {
  try {
    return await runGit(args, cwd, extraEnv)
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* 项目级配置 .dsh/hop.json                                             */
/* ------------------------------------------------------------------ */

async function readConfig(root) {
  const file = path.join(root, '.dsh', 'hop.json')
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

async function writeConfig(root, config) {
  const dir = path.join(root, '.dsh')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'hop.json'), `${JSON.stringify(config, null, 2)}\n`)
  // 不把接力配置提交进项目仓库（只在真的 git 仓库里改 exclude，避免伪造 .git 目录）
  if (existsSync(path.join(root, '.git'))) {
    await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true }).catch(() => {})
    await fs.appendFile(path.join(root, '.git', 'info', 'exclude'), '\n.dsh/\n').catch(() => {})
  }
}

async function saveRelayIndex(url, entry) {
  const dir = path.join(dshHome(), 'hop')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'relays.json')
  let data = {}
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {}
  data[url] = { ...entry, url, updatedAt: new Date().toISOString() }
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`)
}

async function listRelayIndex() {
  try {
    return JSON.parse(await fs.readFile(path.join(dshHome(), 'hop', 'relays.json'), 'utf8'))
  } catch {
    return {}
  }
}

/* ------------------------------------------------------------------ */
/* 会话导出：事件 + 附件                                                  */
/* ------------------------------------------------------------------ */

function walkStrings(value, visit) {
  if (typeof value === 'string') {
    visit(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) walkStrings(item, visit)
  }
}

/** 收集事件里引用的附件。 */
function collectAttachmentRefs(events) {
  const refs = new Map()
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node.attachmentId === 'string' && node.attachmentId.startsWith('sha256:')) {
      const isImage = typeof node.mediaType === 'string'
      const key = node.attachmentId
      if (!refs.has(key)) refs.set(key, { ref: node, kind: isImage ? 'image' : 'file' })
    }
    for (const item of Object.values(node)) visit(item)
  }
  visit(events)
  return refs
}

function serializeLog(header, events) {
  const lines = [
    JSON.stringify({
      type: 'session',
      version: header.version,
      id: header.id,
      createdAt: header.createdAt,
      ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
      ...(header.parentSession !== undefined ? { parentSession: header.parentSession } : {}),
      isSeeded: header.isSeeded,
      ...(header.origin !== undefined ? { origin: header.origin } : {}),
      delegationDepth: header.delegationDepth ?? 0,
      ...(header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {})
    })
  ]
  for (const event of events) lines.push(JSON.stringify(event))
  return `${lines.join('\n')}\n`
}

function compress(text) {
  const buf = Buffer.from(text, 'utf8')
  if (HAS_ZSTD) return { codec: 'zstd', data: zlib.zstdCompressSync(buf) }
  return { codec: 'gzip', data: zlib.gzipSync(buf, { level: 9 }) }
}

function decompress(codec, data) {
  if (codec === 'zstd') {
    if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('本机 Node 不支持 zstd，无法解压接力包')
    return zlib.zstdDecompressSync(data).toString('utf8')
  }
  return zlib.gunzipSync(data).toString('utf8')
}

/** 导出当前会话及其全部子会话。 */
async function exportSessionTree(ctx, rootSessionId) {
  const persistence = ctx.sessionPersistence
  const snapshots = await persistence.list()
  const byParent = new Map()
  for (const snap of snapshots) {
    const parent = snap.header.parentSession
    if (parent === undefined) continue
    const list = byParent.get(parent) ?? []
    list.push(snap.header.id)
    byParent.set(parent, list)
  }
  const order = []
  const seen = new Set()
  const visit = (id, depth) => {
    if (seen.has(id) || depth > 8) return
    seen.add(id)
    order.push(id)
    for (const child of byParent.get(id) ?? []) visit(child, depth + 1)
  }
  visit(rootSessionId, 0)

  const sessions = []
  const attachments = new Map()
  for (const id of order) {
    let handle
    try {
      handle = await persistence.open(id, 'read')
    } catch {
      continue
    }
    try {
      const { events } = await handle.read(0, undefined)
      for (const [key, value] of collectAttachmentRefs(events)) {
        if (!attachments.has(key)) attachments.set(key, value)
      }
      const text = serializeLog(handle.header, events)
      const packed = compress(text)
      sessions.push({
        id,
        header: handle.header,
        parent: handle.header.parentSession ?? null,
        events: events.length,
        codec: packed.codec,
        data: packed.data,
        chars: text.length
      })
    } finally {
      await handle.close().catch(() => {})
    }
  }
  return { sessions, attachments }
}

function rewriteStrings(value, from, to) {
  if (typeof value === 'string') return value.split(from).join(to)
  if (Array.isArray(value)) return value.map((item) => rewriteStrings(item, from, to))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = rewriteStrings(item, from, to)
    return out
  }
  return value
}

/** 只保留 SessionHeader 认得的字段（导出时多了一个 type: 'session'）。 */
function cleanHeader(row) {
  const header = {
    version: row.version,
    id: row.id,
    createdAt: row.createdAt,
    isSeeded: row.isSeeded === true,
    delegationDepth: typeof row.delegationDepth === 'number' ? row.delegationDepth : 0
  }
  if (row.cwd !== undefined) header.cwd = row.cwd
  if (row.parentSession !== undefined) header.parentSession = row.parentSession
  if (row.origin !== undefined) header.origin = row.origin
  if (row.agentPreset !== undefined) header.agentPreset = row.agentPreset
  return header
}

function parseLog(text) {
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  const headerRow = JSON.parse(lines.shift())
  const events = lines.map((line) => JSON.parse(line))
  return { header: headerRow, events }
}

/* ------------------------------------------------------------------ */
/* 会话导入                                                             */
/* ------------------------------------------------------------------ */

async function ensureAttachments(ctx, bundleDir, manifest) {
  let copied = 0
  for (const entry of manifest.attachments ?? []) {
    const file = path.join(bundleDir, entry.file)
    if (!existsSync(file)) continue
    const ref = entry.ref
    let target
    try {
      target = entry.kind === 'image' ? ctx.attachments.imageHostPath(ref) : ctx.attachments.fileHostPath(ref)
    } catch {
      target = undefined
    }
    if (!target) continue
    if (existsSync(target)) continue
    await fs.mkdir(path.dirname(target), { recursive: true })
    const data = await fs.readFile(file)
    await fs.writeFile(target, data)
    copied += 1
  }
  return copied
}

async function importOneSession(ctx, { header, events }) {
  const persistence = ctx.sessionPersistence
  const live = ctx.sessions.get(header.id)
  if (live !== undefined) {
    throw new Error(`会话 ${header.id} 正在本机运行，先关闭它再导入`)
  }
  let handle
  try {
    handle = await persistence.create(header, {})
  } catch (error) {
    if (!String(error?.message ?? error).includes('already exists')) throw error
    handle = await persistence.open(header.id, 'write').catch(() => {
      throw new Error(`会话 ${header.id} 已存在且被占用，无法写入`)
    })
    try {
      const existing = (await handle.read(0, undefined)).events
      const samePrefix = existing.every((event, index) => JSON.stringify(event) === JSON.stringify(events[index]))
      if (!samePrefix) {
        return { id: header.id, action: 'diverged' }
      }
      if (existing.length < events.length) {
        await handle.append(events.slice(existing.length))
      }
      return { id: header.id, action: existing.length < events.length ? 'appended' : 'same' }
    } finally {
      await handle.close().catch(() => {})
    }
  }
  try {
    await handle.append(events)
  } finally {
    await handle.close().catch(() => {})
  }
  return { id: header.id, action: 'created' }
}

async function attachToWorkspace(ctx, sessionId, destRoot) {
  try {
    let workspace = await ctx.workspaceRegistry.resolveByPath(destRoot)
    if (workspace === undefined) workspace = await ctx.workspaceRegistry.create(destRoot)
    if (!workspace.sessionIds.includes(sessionId)) await workspace.attachSession(sessionId)
    return workspace
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

/* ------------------------------------------------------------------ */
/* relay 仓库                                                           */
/* ------------------------------------------------------------------ */

async function ensureStateRepo(url) {
  const dir = path.join(dshHome(), 'hop', 'repos', sha1(url))
  const gitDir = path.join(dir, '.git')
  if (!existsSync(gitDir)) {
    await fs.mkdir(path.dirname(dir), { recursive: true })
    try {
      await runGit(['clone', '--quiet', url, dir], path.dirname(dir))
    } catch (error) {
      await fs.mkdir(dir, { recursive: true })
      await runGit(['init', '--quiet'], dir)
      await runGit(['remote', 'add', 'origin', url], dir)
      await runGit(['checkout', '-q', '-B', 'main'], dir)
      if (!String(error?.message ?? '').includes('empty')) {
        // 空仓库之外的问题留给下面的 fetch 报错
      }
    }
  }
  await runGit(['fetch', '--quiet', '--prune', 'origin'], dir)
  const branch = (await tryGit(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], dir))
    ? 'main'
    : (await tryGit(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master'], dir))
      ? 'master'
      : 'main'
  const remoteRef = `refs/remotes/origin/${branch}`
  if (await tryGit(['rev-parse', '--verify', '--quiet', remoteRef], dir)) {
    await runGit(['checkout', '-q', '-B', branch, remoteRef], dir)
    await runGit(['reset', '--hard', '--quiet', remoteRef], dir)
  } else {
    await runGit(['checkout', '-q', '-B', branch], dir)
  }
  return { dir, branch }
}

async function pushStateRepo(dir, branch) {
  await runGit(['add', '-A'], dir)
  const dirty = await tryGit(['status', '--porcelain'], dir)
  let commit = await tryGit(['rev-parse', '--verify', '--quiet', 'HEAD'], dir)
  if (dirty && dirty.length > 0) {
    await runGit(['-c', 'user.email=hop@dsh.local', '-c', 'user.name=DSH Hop', 'commit', '-q', '-m', `hop: ${deviceName()} ${new Date().toISOString()}`], dir)
    commit = await runGit(['rev-parse', 'HEAD'], dir)
  }
  if (commit === undefined) throw new Error('接力仓库没有任何提交')
  await runGit(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], dir)
  return commit
}

/* ------------------------------------------------------------------ */
/* 代码同步                                                             */
/* ------------------------------------------------------------------ */

async function snapshotCommit(root, message) {
  const head = await tryGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root)
  const tmpDir = path.join(dshHome(), 'hop', 'tmp')
  await fs.mkdir(tmpDir, { recursive: true })
  const indexFile = path.join(tmpDir, `index-${Date.now()}`)
  const env = { GIT_INDEX_FILE: indexFile }
  try {
    if (head) await runGit(['read-tree', head], root, env)
    else await runGit(['read-tree', '--empty'], root, env)
    await runGit(['add', '-A'], root, env)
    const tree = await runGit(['write-tree'], root, env)
    const args = ['-c', 'user.email=hop@dsh.local', '-c', 'user.name=DSH Hop', 'commit-tree', tree, '-m', message]
    if (head) args.push('-p', head)
    return await runGit(args, root)
  } finally {
    await fs.rm(indexFile, { force: true }).catch(() => {})
  }
}

async function pushCode(root, remote, branchName, message) {
  const commit = await snapshotCommit(root, message)
  await runGit(['update-ref', `refs/heads/${branchName}`, commit], root)
  await runGit(['push', '--quiet', '--force', remote, `refs/heads/${branchName}:refs/heads/${branchName}`], root)
  return commit
}

async function pullCode(root, remote, branchName) {
  const localRef = `refs/hop/incoming/${slugify(branchName)}`
  await runGit(['fetch', '--quiet', '--force', remote, `+refs/heads/${branchName}:${localRef}`], root)
  const target = await runGit(['rev-parse', localRef], root)
  const head = await tryGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root)
  const stat = head ? await tryGit(['diff', '--stat', head, target], root) : undefined
  if (!head) {
    await runGit(['reset', '--hard', '--quiet', target], root)
    return { target, mode: 'initial', stat }
  }
  const ancestor = await execFileP('git', ['merge-base', '--is-ancestor', head, target], { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    .then(() => true, () => false)
  if (ancestor) {
    await runGit(['reset', '--hard', '--quiet', target], root)
    return { target, mode: 'fast-forward', stat }
  }
  try {
    await runGit(['-c', 'user.email=hop@dsh.local', '-c', 'user.name=DSH Hop', 'merge', '--no-edit', target], root)
    return { target, mode: 'merged', stat }
  } catch (error) {
    return { target, mode: 'conflict', stat, error: short(error?.message ?? error) }
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

function rootOf(ctx, agent, projectArg) {
  const base = ctx.workingDirectory.get(agent.session)
  return projectArg ? path.resolve(base, projectArg) : base
}

/* ------------------------------------------------------------------ */
/* 全局配置：一个接力仓库装所有项目                                       */
/* ------------------------------------------------------------------ */

function configPath() {
  return path.join(dshHome(), 'hop', 'config.json')
}

function statePath() {
  return path.join(dshHome(), 'hop', 'state.json')
}

function defaultProjectsDir() {
  return path.join(os.homedir(), 'dsh-projects')
}

async function loadGlobal() {
  try {
    return JSON.parse(await fs.readFile(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

async function saveGlobal(patch) {
  const next = { ...(await loadGlobal()), ...patch }
  await fs.mkdir(path.dirname(configPath()), { recursive: true })
  await fs.writeFile(configPath(), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

async function loadLocalState() {
  try {
    const data = JSON.parse(await fs.readFile(statePath(), 'utf8'))
    return { projects: {}, ...data }
  } catch {
    return { projects: {} }
  }
}

async function saveLocalState(patch) {
  const state = await loadLocalState()
  state.projects = { ...state.projects, ...patch }
  await fs.mkdir(path.dirname(statePath()), { recursive: true })
  await fs.writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`)
}

/** 仓库地址：显式参数 > 全局配置 > 项目配置 > 唯一保存过的仓库。 */
async function resolveRelay(ctx, agent, root, explicit) {
  if (explicit) return explicit
  const global = await loadGlobal()
  if (global.relay) return global.relay
  const cfg = root ? await readConfig(root) : undefined
  if (cfg?.stateRemote) return cfg.stateRemote
  const urls = Object.keys(await listRelayIndex())
  if (urls.length === 1) return urls[0]
  if (urls.length === 0) throw new Error('还没有配置接力仓库。先运行 /hop setup <私有仓库地址>')
  throw new Error(`配置了多个接力仓库，请指定一个：${urls.join('、')}`)
}

/** 读仓库里的项目清单；老仓库没有 relay.json 时退回扫描各项目 manifest。 */
async function readRelayIndex(dir) {
  try {
    const data = JSON.parse(await fs.readFile(path.join(dir, 'relay.json'), 'utf8'))
    if (data && data.projects && typeof data.projects === 'object') {
      return { version: 2, projects: {}, ...data }
    }
  } catch {
    /* 老仓库或首次使用 */
  }
  const projects = {}
  const base = path.join(dir, 'projects')
  const ids = existsSync(base) ? await fs.readdir(base) : []
  for (const id of ids) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(base, id, 'manifest.json'), 'utf8'))
      projects[id] = {
        id,
        name: manifest.projectName ?? id,
        updatedAt: manifest.createdAt,
        device: manifest.device,
        sessions: manifest.sessions?.length ?? 0,
        attachments: manifest.attachments?.length ?? 0,
        sourceRoot: manifest.projectRoot ?? manifest.sourceRoot,
        hasCode: Boolean(manifest.code?.remote)
      }
    } catch {
      /* 不是项目目录 */
    }
  }
  return { version: 2, projects }
}

async function writeRelayIndex(dir, index) {
  index.version = 2
  index.updatedAt = new Date().toISOString()
  await fs.writeFile(path.join(dir, 'relay.json'), `${JSON.stringify(index, null, 2)}\n`)
}

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

/* ------------------------------------------------------------------ */
/* 推送 / 拉取 / 清单                                                   */
/* ------------------------------------------------------------------ */

async function push(ctx, agent, options = {}) {
  const sessionId = options.session ?? agent.session.id
  const live = ctx.sessions.get(sessionId)
  const sessionCwd = live !== undefined
    ? ctx.workingDirectory.get(live)
    : (await ctx.sessionPersistence.stat(sessionId))?.header?.cwd
  if (!sessionCwd) throw new Error(`找不到会话 ${sessionId}，或它没有记录工作目录`)
  const root = options.project ? path.resolve(sessionCwd, options.project) : sessionCwd
  const cfg = await readConfig(root)
  const relay = await resolveRelay(ctx, agent, root, options.relay)
  const projectId = cfg?.projectId ?? slugify(path.basename(root))
  if (live !== undefined) await ctx.sessions.flush(live)

  const tree = await exportSessionTree(ctx, sessionId)
  const { dir, branch } = await ensureStateRepo(relay)

  const stateDir = path.join(dir, 'projects', projectId)
  await fs.rm(stateDir, { recursive: true, force: true })
  await fs.mkdir(path.join(stateDir, 'sessions'), { recursive: true })
  await fs.mkdir(path.join(stateDir, 'attachments'), { recursive: true })

  const attachmentEntries = []
  for (const [id, entry] of tree.attachments) {
    const hex = id.slice('sha256:'.length)
    const hostPath = (() => {
      try {
        return entry.kind === 'image' ? ctx.attachments.imageHostPath(entry.ref) : ctx.attachments.fileHostPath(entry.ref)
      } catch {
        return undefined
      }
    })()
    if (!hostPath || !existsSync(hostPath)) continue
    const file = `attachments/${hex}.bin`
    await fs.copyFile(hostPath, path.join(stateDir, file))
    attachmentEntries.push({ id, kind: entry.kind, file, ref: entry.ref, bytes: entry.ref.bytes })
  }

  const sessionEntries = []
  for (const session of tree.sessions) {
    const ext = session.codec === 'zstd' ? 'zst' : 'gz'
    const file = `sessions/${slugify(session.id)}.json.${ext}`
    await fs.writeFile(path.join(stateDir, file), session.data)
    sessionEntries.push({ id: session.id, parent: session.parent, file, codec: session.codec, events: session.events, header: session.header })
  }

  let code = null
  const codeRemote = cfg?.codeRemote ?? (await tryGit(['remote', 'get-url', 'origin'], root))
  if (codeRemote) {
    const branchName = `hop/${slugify(deviceName())}`
    const commit = await pushCode(root, codeRemote, branchName, options.message ?? `hop: ${deviceName()} ${new Date().toISOString()}`)
    code = { remote: codeRemote, branch: branchName, commit }
  }

  const manifest = {
    version: BUNDLE_VERSION,
    projectId,
    projectName: path.basename(root),
    sourceRoot: sessionCwd,
    projectRoot: root,
    device: deviceName(),
    createdAt: new Date().toISOString(),
    code,
    sessions: sessionEntries.map(({ header, ...rest }) => ({ ...rest, summary: short(header.cwd ?? '', 200) })),
    attachments: attachmentEntries,
    note: options.message ?? ''
  }
  await fs.writeFile(path.join(stateDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const chars = tree.sessions.reduce((sum, item) => sum + (item.chars ?? 0), 0)
  const index = await readRelayIndex(dir)
  index.projects[projectId] = {
    id: projectId,
    name: manifest.projectName,
    updatedAt: manifest.createdAt,
    device: manifest.device,
    sessions: sessionEntries.length,
    attachments: attachmentEntries.length,
    bytes: chars,
    sourceRoot: root,
    hasCode: Boolean(code)
  }
  await writeRelayIndex(dir, index)

  const commit = await pushStateRepo(dir, branch)
  await saveRelayIndex(relay, { projectId, projectName: manifest.projectName, lastRoot: root })
  await writeConfig(root, { stateRemote: relay, projectId, codeRemote: code?.remote ?? null })
  await saveLocalState({ [projectId]: { id: projectId, name: manifest.projectName, localPath: root, lastPush: new Date().toISOString() } })

  return {
    root,
    relay,
    commit,
    sessions: sessionEntries.length,
    attachments: attachmentEntries.length,
    code,
    text: [
      `已把「${manifest.projectName}」放进接力仓库（${sessionEntries.length} 个会话，${attachmentEntries.length} 个附件）`,
      code ? `代码：${code.remote} 分支 ${code.branch} @ ${code.commit.slice(0, 8)}` : '代码：没有远端，这次只带走了会话',
      `仓库：${relay}（${branch} @ ${commit.slice(0, 8)}）`,
      '另一台电脑上：/hop list 看清单，/hop pull ' + manifest.projectName
    ].join('\n')
  }
}

async function pull(ctx, agent, options = {}) {
  const relay = await resolveRelay(ctx, agent, undefined, options.relay)
  const { dir, branch } = await ensureStateRepo(relay)
  const index = await readRelayIndex(dir)
  const entries = Object.values(index.projects)
  if (entries.length === 0) throw new Error('接力仓库里还没有项目。先在项目里 /hop push。')

  const wanted = options.project
  const entry = wanted
    ? index.projects[wanted] ?? entries.find((item) => item.name === wanted || item.name.toLowerCase() === wanted.toLowerCase())
    : entries.length === 1
      ? entries[0]
      : undefined
  if (!entry) {
    throw new Error(`接力仓库里没有「${wanted ?? ''}」。现有：${entries.map((item) => item.name).join('、')}`)
  }

  const stateDir = path.join(dir, 'projects', entry.id)
  const manifest = JSON.parse(await fs.readFile(path.join(stateDir, 'manifest.json'), 'utf8'))
  const global = await loadGlobal()
  const localState = await loadLocalState()
  const previous = localState.projects[entry.id]?.localPath
  const remembered = previous && existsSync(previous) ? previous : undefined
  const destRoot = path.resolve(options.dest ?? remembered ?? path.join(global.projectsDir ?? defaultProjectsDir(), entry.name))
  const samePath = path.resolve(manifest.sourceRoot) === destRoot
  await fs.mkdir(destRoot, { recursive: true })

  let code = null
  if (manifest.code?.remote) {
    if (!existsSync(path.join(destRoot, '.git'))) {
      const existing = await fs.readdir(destRoot).catch(() => [])
      if (existing.length > 0) {
        throw new Error(`目标目录 ${destRoot} 非空且不是 git 仓库，请换一个空目录`)
      }
      await fs.rmdir(destRoot).catch(() => {})
      await runGit(['clone', '--quiet', manifest.code.remote, destRoot], path.dirname(destRoot))
    }
    const backupRef = `refs/hop/backup/${Date.now()}`
    if (await tryGit(['rev-parse', '--verify', '--quiet', 'HEAD'], destRoot)) {
      const head = await runGit(['rev-parse', 'HEAD'], destRoot)
      await runGit(['update-ref', backupRef, head], destRoot)
    }
    code = await pullCode(destRoot, manifest.code.remote, manifest.code.branch)
  }

  const attachments = await ensureAttachments(ctx, stateDir, manifest)

  const results = []
  const idMap = new Map()
  const ordered = [...manifest.sessions].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0))
  for (const item of ordered) {
    const text = decompress(item.codec, await fs.readFile(path.join(stateDir, item.file)))
    const parsed = parseLog(text)
    let header = { ...cleanHeader(parsed.header), cwd: samePath ? parsed.header.cwd : destRoot }
    let events = parsed.events
    if (!samePath) {
      for (const from of [manifest.projectRoot, manifest.sourceRoot, parsed.header.cwd]) {
        if (typeof from === 'string' && from.length > 0 && from !== destRoot) {
          events = rewriteStrings(events, from, destRoot)
        }
      }
    }
    if (header.parentSession && idMap.has(header.parentSession)) {
      header.parentSession = idMap.get(header.parentSession)
    }
    if (header.parentSession && !manifest.sessions.some((other) => other.id === header.parentSession)) {
      delete header.parentSession
    }
    if (ctx.sessions.get(header.id) !== undefined) {
      const copyId = `session-${randomUUID()}`
      idMap.set(item.id, copyId)
      header = { ...header, id: copyId }
    }
    try {
      const result = await importOneSession(ctx, { header, events })
      results.push({ ...result, events: events.length, copied: header.id !== item.id })
    } catch (error) {
      results.push({ id: item.id, action: 'failed', error: short(error?.message ?? error) })
    }
  }

  const rootEntry = manifest.sessions.find((item) => !item.parent) ?? manifest.sessions[0]
  const rootId = rootEntry ? (idMap.get(rootEntry.id) ?? rootEntry.id) : undefined
  const workspace = rootId && options.attach !== false
    ? await attachToWorkspace(ctx, rootId, destRoot)
    : undefined

  await writeConfig(destRoot, { stateRemote: relay, projectId: entry.id, codeRemote: manifest.code?.remote ?? null })
  await saveLocalState({ [entry.id]: { id: entry.id, name: manifest.projectName, localPath: destRoot, lastPull: new Date().toISOString() } })

  const created = results.filter((item) => item.action === 'created').length
  const appended = results.filter((item) => item.action === 'appended').length
  const same = results.filter((item) => item.action === 'same').length
  const failed = results.filter((item) => item.action === 'failed' || item.action === 'diverged')

  return {
    destRoot,
    sessionId: rootId,
    results,
    text: [
      `已把「${manifest.projectName}」拉到 ${destRoot}${samePath ? '' : '（旧路径已改写成本机路径）'}`,
      `会话：新建 ${created}，追加 ${appended}，未变 ${same}${failed.length ? `，异常 ${failed.length}` : ''}`,
      ...failed.map((item) => `异常 ${item.id}: ${item.error ?? item.action}`),
      `附件：补齐 ${attachments} 个`,
      code ? `代码：${code.mode}${code.stat ? ` ${short(code.stat, 200)}` : ''}${code.error ? `（${code.error}）` : ''}` : '代码：这次只恢复了会话',
      options.attach === false
        ? '侧边栏：未挂载'
        : workspace?.error
          ? `侧边栏：挂载失败 ${workspace.error}`
          : '侧边栏：已挂到项目下，点开就能继续',
      `会话 id：${rootId}`
    ].join('\n')
  }
}

async function listRemote(ctx, agent, options = {}) {
  const relay = await resolveRelay(ctx, agent, undefined, options.relay)
  const { dir, branch } = await ensureStateRepo(relay)
  const index = await readRelayIndex(dir)
  const entries = Object.values(index.projects).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  const global = await loadGlobal()
  const state = await loadLocalState()
  const lines = [`接力仓库：${relay}（${branch}）`]
  if (entries.length === 0) {
    lines.push('', '还没有项目。在任意项目里运行 /hop push 就会加进来。')
    return lines.join('\n')
  }
  lines.push(`共 ${entries.length} 个项目，下载目录 ${global.projectsDir ?? defaultProjectsDir()}：`, '')
  for (const entry of entries) {
    const remembered = state.projects[entry.id]?.localPath
    const source = typeof entry.sourceRoot === 'string' && existsSync(entry.sourceRoot) ? entry.sourceRoot : undefined
    const local = remembered && existsSync(remembered) ? remembered : source
    const downloaded = Boolean(local)
    lines.push(`  ${downloaded ? '✓' : '·'} ${entry.name.padEnd(20)} ${String(entry.sessions ?? 0).padStart(2)} 会话  ${String(entry.attachments ?? 0).padStart(3)} 附件  ${formatTime(entry.updatedAt)}  ${downloaded ? local : '未下载'}`)
  }
  lines.push('', '拉取：/hop pull <项目名> [目标目录]')
  return lines.join('\n')
}

async function status(ctx, agent, options = {}) {
  const global = await loadGlobal()
  const root = rootOf(ctx, agent, options.project)
  const cfg = await readConfig(root)
  const lines = [
    `本机：${deviceName()}`,
    global.relay ? `接力仓库：${global.relay}` : '接力仓库：未配置（/hop setup <私有仓库地址>）',
    `默认下载目录：${global.projectsDir ?? defaultProjectsDir()}`,
    cfg
      ? `当前项目：${root}\n  项目 id：${cfg.projectId}`
      : `当前项目：${root}（还没接力过，/hop push 会自动加入）`
  ]
  return lines.join('\n')
}

async function setup(ctx, agent, options) {
  if (!options.relay) throw new Error('用法：/hop setup <私有仓库地址> [下载目录]')
  // 先验证能不能访问，失败就不要把坏地址写进配置
  const probe = await probeRepo(options.relay)
  if (!probe.ok) throw new Error(probe.message)
  const patch = { relay: options.relay, device: deviceName() }
  if (options.dir) patch.projectsDir = path.resolve(options.dir)
  await saveGlobal(patch)
  const { dir, branch } = await ensureStateRepo(options.relay)
  const index = await readRelayIndex(dir)
  const count = Object.keys(index.projects).length
  return [
    `接力仓库已配置：${options.relay}（${branch}）`,
    `本机：${deviceName()}`,
    `已有项目：${count} 个`,
    '',
    '以后只需要：',
    '  /hop push            把当前项目交上去',
    '  /hop list            看仓库里有哪些项目',
    '  /hop pull <项目名>   在另一台电脑下载'
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/* 给界面用的 JSON 接口                                                 */
/* ------------------------------------------------------------------ */

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  })
}

/** 面板要的数据：仓库配置 + 项目清单 + 本机是否已有。 */
async function hopState(ctx) {
  const global = await loadGlobal()
  const state = await loadLocalState()
  const view = {
    configured: Boolean(global.relay),
    relay: global.relay ?? null,
    device: deviceName(),
    projectsDir: global.projectsDir ?? defaultProjectsDir(),
    projects: []
  }
  if (!global.relay) return view
  try {
    const { dir, branch } = await ensureStateRepo(global.relay)
    view.branch = branch
    const index = await readRelayIndex(dir)
    view.projects = Object.values(index.projects)
      .map((entry) => {
        const remembered = state.projects[entry.id]?.localPath
        const local = remembered && existsSync(remembered)
          ? remembered
          : typeof entry.sourceRoot === 'string' && existsSync(entry.sourceRoot)
            ? entry.sourceRoot
            : null
        return { ...entry, localPath: local, downloaded: Boolean(local) }
      })
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  } catch (error) {
    view.error = String(error?.message ?? error)
  }
  return view
}

/* ------------------------------------------------------------------ */
/* 平台识别 / 连通性检测 / SSH 密钥                                      */
/* ------------------------------------------------------------------ */

const PROVIDER_HOSTS = {
  github: 'github.com',
  gitee: 'gitee.com'
}

function protocolOf(url) {
  return /^(git@|ssh:|git\+ssh)/.test(String(url)) ? 'ssh' : 'https'
}

function providerOf(url) {
  const text = String(url)
  if (text.includes('github.com')) return 'github'
  if (text.includes('gitee.com')) return 'gitee'
  return 'other'
}

function classifyGitFailure(message) {
  const text = String(message).toLowerCase()
  if (/permission denied|publickey|authentication failed|could not read username|terminal prompts disabled|\b401\b|\b403\b/.test(text)) return 'auth'
  if (/repository .*not found|does not exist|not found|\b404\b/.test(text)) return 'notfound'
  if (/could not resolve host|connection (timed out|refused)|network is unreachable|timeout/.test(text)) return 'network'
  return 'unknown'
}

/** 只读探测：能不能访问这个仓库（不做任何写入）。 */
async function probeRepo(url) {
  try {
    await runGit(['ls-remote', '--heads', url], os.tmpdir())
    return { ok: true }
  } catch (error) {
    const message = String(error?.message ?? error)
    return { ok: false, message, kind: classifyGitFailure(message) }
  }
}

async function sshKeyInfo() {
  const dir = path.join(os.homedir(), '.ssh')
  for (const name of ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub']) {
    const file = path.join(dir, name)
    if (!existsSync(file)) continue
    try {
      const publicKey = (await fs.readFile(file, 'utf8')).trim()
      if (publicKey.length > 0) return { exists: true, path: file, publicKey }
    } catch {
      /* 读不到就当没有 */
    }
  }
  return { exists: false, path: path.join(dir, 'id_ed25519.pub') }
}

/** 没有密钥就生成一把 ed25519；已有则直接返回。 */
async function ensureSshKey() {
  const current = await sshKeyInfo()
  if (current.exists) return current
  const dir = path.join(os.homedir(), '.ssh')
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'id_ed25519')
  await new Promise((resolve, reject) => {
    execFile('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'dsh-hop', '-f', file], (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()))
      else resolve()
    })
  })
  const created = await sshKeyInfo()
  if (!created.exists) throw new Error('ssh-keygen 执行成功但没有找到公钥')
  return created
}

/** 面板用的体检结果。 */
async function hopDoctor(ctx) {
  const global = await loadGlobal()
  const key = await sshKeyInfo()
  const view = {
    configured: Boolean(global.relay),
    relay: global.relay ?? null,
    provider: global.relay ? providerOf(global.relay) : null,
    protocol: global.relay ? protocolOf(global.relay) : null,
    sshKey: { exists: key.exists, path: key.path },
    reachable: null
  }
  if (!global.relay) return view
  const probe = await probeRepo(global.relay)
  view.reachable = probe.ok
  if (!probe.ok) {
    view.error = short(probe.message, 500)
    view.hint = probe.kind
  }
  return view
}

const pullJobs = new Map()

/** 后台跑一次拉取，面板轮询结果。 */
function startPullJob(ctx, options) {
  const id = randomUUID()
  const job = { id, status: 'running', text: '', startedAt: Date.now() }
  pullJobs.set(id, job)
  for (const key of [...pullJobs.keys()].slice(0, Math.max(0, pullJobs.size - 20))) pullJobs.delete(key)
  ;(async () => {
    try {
      const result = await pull(ctx, null, options)
      job.status = 'done'
      job.text = result.text
      job.sessionId = result.sessionId
      job.destRoot = result.destRoot
    } catch (error) {
      job.status = 'error'
      job.text = String(error?.message ?? error)
    }
    job.finishedAt = Date.now()
  })()
  return job
}

/* ------------------------------------------------------------------ */
/* 注册                                                                 */
/* ------------------------------------------------------------------ */

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text']
  },
  render: (_args, value) => [{ type: 'text', text: value.text }]
}

function tool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: definition.properties,
      ...(definition.required?.length ? { required: definition.required } : {})
    },
    output: TEXT_OUTPUT,
    execute: definition.execute
  }
}

const OPTIONAL_PROJECT = {
  type: 'string',
  description: 'Optional subdirectory of the working directory to treat as the project root.'
}

function hopTools(ctx) {
  return [
    tool({
      name: 'hop_status',
      description: 'Show cross-machine relay status: the configured relay repository, this device, the download directory, and whether the current project is registered.',
      properties: { project: OPTIONAL_PROJECT },
      execute: async (args, exec) => ({ text: await status(ctx, exec.agent, args) })
    }),
    tool({
      name: 'hop_list',
      description: 'List the projects stored in the relay repository, marking which ones already exist on this computer. Use it to answer "what can I pull here".',
      properties: {},
      execute: async (args, exec) => ({ text: await listRemote(ctx, exec.agent, args) })
    }),
    tool({
      name: 'hop_push',
      description: 'Hand the current project off: flush the session, export it (plus subagent sessions and attachments) into the relay repository, register the project in the relay index, snapshot the git working tree to hop/<device>, and push. No per-project setup is needed once a relay is configured.',
      properties: {
        message: { type: 'string', description: 'Optional note describing where the work stopped.' },
        project: OPTIONAL_PROJECT,
        session: { type: 'string', description: 'Session id to export instead of the calling session. Use it to hand off an older, closed session.' }
      },
      execute: async (args, exec) => ({ text: (await push(ctx, exec.agent, args)).text })
    }),
    tool({
      name: 'hop_pull',
      description: 'Take over a project on this computer: fetch the relay, import the session log (rewriting old absolute paths to the destination), restore attachments, sync the code branch, and attach the session to the sidebar. The project may be named instead of passed as a path.',
      properties: {
        project: { type: 'string', description: 'Project name or id inside the relay repository, e.g. "biao-live-v3". Omit when the relay holds exactly one project.' },
        dest: { type: 'string', description: 'Absolute destination directory. Defaults to the download directory plus the project name.' },
        relay: { type: 'string', description: 'Relay repository URL; defaults to the configured one.' },
        attach: { type: 'boolean', description: 'Attach the imported root session to the destination project in the sidebar. Defaults to true.' }
      },
      execute: async (args, exec) => ({ text: (await pull(ctx, exec.agent, args)).text })
    }),
    tool({
      name: 'hop_setup',
      description: 'Configure the single relay repository used for every project on this computer, storing the URL in the DSH home config. Needed once per machine.',
      properties: {
        relay: { type: 'string', description: 'Private git repository URL used to carry sessions and attachments.' },
        dir: { type: 'string', description: 'Optional default directory for pulled projects.' }
      },
      required: ['relay'],
      execute: async (args, exec) => ({ text: await setup(ctx, exec.agent, args) })
    })
  ]
}

export function apply(ctx) {
  for (const item of hopTools(ctx)) {
    ctx.effect(() => ctx.tools.register(item), `dsh-hop: ${item.name}`)
  }

  ctx.inject(['connection'], (scoped) => {
    scoped.connection.fetch.register({
      path: '/api/hop/state',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => jsonResponse(await hopState(ctx))
    })
    scoped.connection.fetch.register({
      path: '/api/hop/doctor',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => jsonResponse(await hopDoctor(ctx))
    })
    scoped.connection.fetch.register({
      path: '/api/hop/ssh-key',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const key = await ensureSshKey()
          return jsonResponse({ ok: true, publicKey: key.publicKey, path: key.path })
        } catch (error) {
          return jsonResponse({ ok: false, error: String(error?.message ?? error) }, 500)
        }
      }
    })
    scoped.connection.fetch.register({
      path: '/api/hop/setup',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json()
          const text = await setup(ctx, null, body)
          return jsonResponse({ ok: true, text, doctor: await hopDoctor(ctx) })
        } catch (error) {
          const message = String(error?.message ?? error)
          const hint = classifyGitFailure(message)
          return jsonResponse({ ok: false, error: message, hint, provider: providerOf(body?.relay ?? ''), protocol: protocolOf(body?.relay ?? '') })
        }
      }
    })
    scoped.connection.fetch.register({
      path: '/api/hop/pull',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json()
          const job = startPullJob(ctx, { project: body.project, dest: body.dest })
          return jsonResponse({ ok: true, jobId: job.id })
        } catch (error) {
          return jsonResponse({ ok: false, error: String(error?.message ?? error) }, 400)
        }
      }
    })
    scoped.connection.fetch.register({
      path: '/api/hop/job',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const id = new URL(request.url).searchParams.get('id') ?? ''
        const job = pullJobs.get(id)
        if (!job) return jsonResponse({ ok: false, error: '任务不存在' }, 404)
        return jsonResponse({ ok: true, ...job })
      }
    })
  }, 'dsh-hop: panel routes')

  ctx.effect(() => ctx.commands.register({
    definitionId: 'dsh-hop',
    name: 'hop',
    description: '跨机接力：/hop push 提交，/hop list 看清单，/hop pull 名字 下载',
    input: { hint: 'push | list | pull <名字> [目录] | setup <仓库> | status' },
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim()
      const [sub, ...rest] = raw.split(/\s+/).filter(Boolean)
      try {
        if (!sub) {
          const global = await loadGlobal()
          return { kind: 'success', text: global.relay ? await listRemote(ctx, invocation.agent) : await status(ctx, invocation.agent) }
        }
        if (sub === 'list' || sub === 'ls') return { kind: 'success', text: await listRemote(ctx, invocation.agent) }
        if (sub === 'push') {
          const result = await push(ctx, invocation.agent, { message: rest.join(' ') })
          return { kind: 'success', text: result.text }
        }
        if (sub === 'pull') {
          const [project, dest] = rest
          const result = await pull(ctx, invocation.agent, { project, dest })
          return { kind: 'success', text: result.text }
        }
        if (sub === 'setup' || sub === 'init') {
          const [relay, dir] = rest
          return { kind: 'success', text: await setup(ctx, invocation.agent, { relay, dir }) }
        }
        if (sub === 'status') return { kind: 'success', text: await status(ctx, invocation.agent) }
        return { kind: 'error', text: `未知子命令 ${sub}。可用：push / list / pull / setup / status` }
      } catch (error) {
        return { kind: 'error', text: String(error?.message ?? error) }
      }
    }
  }), 'dsh-hop: command')
}
