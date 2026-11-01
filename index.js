/**
 * Host half of @yg/dsh-session-mover.
 *
 * A conversation belongs to the workspace whose directory equals the `cwd`
 * recorded in its session header. Moving it therefore takes two writes that
 * must agree with each other:
 *
 *   1. the session log moves to `<sessions-root>/<projectKey(target)>/<id>/`
 *      and its header line is rewritten with the new `cwd`;
 *   2. the workspace registry detaches the session from its old workspace and
 *      attaches it to the new one, which re-reads that header from disk.
 *
 * Doing only one of the two leaves a log the store or the registry rejects, so
 * this module performs both and puts the log back when the registry refuses.
 */

import { existsSync } from 'node:fs'
import { mkdir, appendFile, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const API_PREFIX = '/yg-session-mover/api'
const MAX_BODY_BYTES = 64 * 1024
const TRACE_PATH = join(homedir(), '.dsh', 'yg-session-mover.log')

async function appendTrace(line) {
  try {
    await appendFile(TRACE_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* tracing is best effort */
  }
}

export const inject = ['webServer', 'connection', 'workspaceRegistry', 'sessionPersistence', 'sessions']

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => handle(ctx, req, res),
      }),
    'yg-session-mover: cross-workspace move endpoint',
  )
}

async function handle(ctx, req, res) {
  if (ctx.connection.requestRejection(req) !== undefined) {
    sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'this connection is not trusted' } })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  const method = pathname.slice(API_PREFIX.length).replace(/^\/+/, '')
  try {
    const payload = await readJsonBody(req)
    if (method === 'move') {
      const result = await moveSession(ctx, payload)
      await appendTrace(`move ${JSON.stringify({ in: payload, out: result })}`)
      sendJson(res, 200, result)
      return
    }
    if (method === 'peek') {
      const result = await peekSession(ctx, payload)
      await appendTrace(`peek ${JSON.stringify({ in: payload, out: result })}`)
      sendJson(res, 200, result)
      return
    }
    sendJson(res, 404, {
      ok: false,
      error: { code: 'unknown-method', message: method === '' ? 'name a method' : `unknown method '${method}'` },
    })
  } catch (error) {
    sendJson(res, 200, { ok: false, error: toErrorInfo(error) })
  }
}

/* ------------------------------------------------------------------ move -- */

async function moveSession(ctx, input) {
  const sessionId = asId(input?.sessionId)
  const targetWorkspaceId = asId(input?.targetWorkspaceId)
  if (sessionId === undefined) return fail('bad-request', 'sessionId is required')
  if (targetWorkspaceId === undefined) return fail('bad-request', 'targetWorkspaceId is required')

  const registry = ctx.workspaceRegistry
  const target = registry.get(targetWorkspaceId)
  if (target === undefined) return fail('unknown-workspace', `no workspace with id '${targetWorkspaceId}'`)

  const owner = registry.list().find((workspace) => workspace.sessionIds.includes(sessionId))
  if (owner !== undefined && owner.id === target.id) {
    return { ok: true, moved: false, reason: 'already-there', workspace: describeWorkspace(target) }
  }
  if ((await isDirectory(target.path)) !== true) {
    return fail('missing-directory', `the target workspace directory no longer exists: ${target.path}`)
  }

  // A live session keeps its immutable header in memory, and the workspace
  // registry validates an attach against that header. Nothing can move a
  // conversation that is currently open, so say so instead of failing later.
  const live = ctx.sessions.get(sessionId)


  const root = sessionsRoot(ctx)
  const relocated = await relocateLog(root, sessionId, target.path)

  invalidateSessionCache(registry, sessionId)
  // The in-memory session still advertises the old directory, and the registry
  // validates an attach against it. Move that value along with the log.
  const liveHeader = live === undefined ? undefined : live.header
  let previousLiveCwd
  if (liveHeader !== undefined) {
    previousLiveCwd = liveHeader.cwd
    try {
      liveHeader.cwd = target.path
    } catch {
      /* a frozen header keeps the old directory until the process restarts */
    }
  }
  rememberSessionPath(registry, sessionId, target.path)
  try {
    if (owner !== undefined) await detachFrom(owner, sessionId)
    await attachTo(target, sessionId)
  } catch (error) {
    if (liveHeader !== undefined) {
      try {
        liveHeader.cwd = previousLiveCwd
      } catch {
        /* nothing else to restore */
      }
    }
    const rollback = await rollbackLog(relocated)
    if (owner !== undefined) {
      rememberSessionPath(registry, sessionId, owner.path)
      await attachTo(owner, sessionId).catch(() => {})
    }
    return { ok: false, error: { ...toErrorInfo(error), code: 'attach-rejected' }, rollback }
  }

  return {
    ok: true,
    moved: relocated.moved,
    from: owner === undefined ? null : describeWorkspace(owner),
    to: describeWorkspace(target),
    logPath: relocated.to,
    bytes: relocated.bytes,
    liveHeader: live === undefined ? null : Object.isExtensible(liveHeader) ? 'rewritten' : 'frozen',
  }
}

/**
 * The registry keeps its own cwd index next to the workspace table. An attach
 * re-reads that index, so a stale entry would filter the session straight back
 * out of the target workspace.
 */
function rememberSessionPath(registry, sessionId, path) {
  const host = registry.host
  if (host !== undefined && typeof host.rememberSessionPath === 'function') {
    host.rememberSessionPath(sessionId, path)
  }
}

/**
 * attachSession rejects any session whose stored cwd differs from the target
 * directory, and a session that is open in this process reports its frozen
 * in-memory header. Move the membership directly instead, after the cwd index
 * already points at the target.
 */
async function attachTo(workspace, sessionId) {
  await workspace.mutate((record) =>
    record.sessionIds.includes(sessionId) ? record : { ...record, sessionIds: [sessionId, ...record.sessionIds] },
  )
}

async function detachFrom(workspace, sessionId) {
  await workspace.mutate((record) =>
    record.sessionIds.includes(sessionId)
      ? { ...record, sessionIds: record.sessionIds.filter((id) => id !== sessionId) }
      : record,
  )
}

async function peekSession(ctx, input) {
  const sessionId = asId(input?.sessionId)
  if (sessionId === undefined) return fail('bad-request', 'sessionId is required')
  const root = sessionsRoot(ctx)
  const located = await findStoredLog(root, sessionId)
  const header = await readHeaderFrom(located.path)
  const owner = ctx.workspaceRegistry.list().find((workspace) => workspace.sessionIds.includes(sessionId))
  return {
    ok: true,
    sessionId,
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    path: located.path,
    project: basename(dirname(dirname(located.path))),
    workspace: owner === undefined ? null : describeWorkspace(owner),
    live: ctx.sessions.get(sessionId) !== undefined,
    liveCount: ctx.sessions.list().length,
    frozen: ctx.sessions.get(sessionId) === undefined ? null : !Object.isExtensible(ctx.sessions.get(sessionId).header),
  }
}

/* ------------------------------------------------------- session storage -- */

async function relocateLog(root, sessionId, targetPath) {
  const located = await findStoredLog(root, sessionId)
  const header = await readHeaderFrom(located.path)
  const previousCwd = typeof header.cwd === 'string' ? header.cwd : undefined
  const destinationDir = sessionDir(root, targetPath, sessionId)
  const inPlace = destinationDir === dirname(located.path)

  if (inPlace && previousCwd === targetPath) {
    return { moved: false, from: located.path, to: located.path, bytes: 0, previousCwd }
  }
  if (!inPlace && existsSync(destinationDir)) {
    throw codedError('destination-exists', `a session folder already exists at ${destinationDir}`)
  }

  const bytes = await rewriteHeader(located.path, { ...header, cwd: targetPath })
  if (inPlace) {
    await writeFile(located.path, bytes)
    return { moved: false, from: located.path, to: located.path, bytes: bytes.length, previousCwd }
  }

  await mkdir(dirname(destinationDir), { recursive: true })
  await mkdir(destinationDir)
  const destinationFile = join(destinationDir, basename(located.path))
  await writeFile(destinationFile, bytes)
  try {
    await rm(dirname(located.path), { recursive: true, force: true })
  } catch (error) {
    // A live conversation keeps its log open on Windows; undo the copy so the
    // store never sees the same session in two project folders.
    await rm(destinationDir, { recursive: true, force: true }).catch(() => {})
    throw codedError('log-open', `this conversation still has its log open, stop it first: ${String(error && error.message)}`)
  }
  return { moved: true, from: located.path, to: destinationFile, bytes: bytes.length, previousCwd }
}

async function rollbackLog(relocated) {
  try {
    if (relocated.previousCwd === undefined) {
      return { attempted: false, reason: 'the stored header carried no cwd, so there is nothing to restore' }
    }
    const header = await readHeaderFrom(relocated.to)
    const bytes = await rewriteHeader(relocated.to, { ...header, cwd: relocated.previousCwd })
    if (relocated.moved !== true) {
      await writeFile(relocated.to, bytes)
      return { attempted: true, ok: true }
    }
    const originalDir = dirname(relocated.from)
    if (existsSync(originalDir)) {
      return { attempted: false, reason: `the original folder is occupied again: ${originalDir}` }
    }
    await mkdir(originalDir, { recursive: true })
    await writeFile(join(originalDir, basename(relocated.to)), bytes)
    await rm(dirname(relocated.to), { recursive: true, force: true })
    return { attempted: true, ok: true }
  } catch (error) {
    return { attempted: true, ok: false, error: toErrorInfo(error) }
  }
}

function sessionsRoot(ctx) {
  const configured = ctx?.sessionPersistence?.root
  if (typeof configured === 'string' && configured !== '') return configured
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
}

async function findStoredLog(root, sessionId) {
  const segment = encodeSegment(sessionId)
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  const hits = []
  for (const entry of projects) {
    if (entry.isDirectory() !== true) continue
    const candidate = join(root, entry.name, segment)
    if ((await isDirectory(candidate)) === true) hits.push(candidate)
  }
  if (hits.length === 0) throw codedError('log-not-found', `no stored log for '${sessionId}' under ${root}`)
  if (hits.length > 1) {
    throw codedError(
      'log-ambiguous',
      `'${sessionId}' appears in ${hits.length} project folders, so the store cannot resolve it: ${hits.join(', ')}`,
    )
  }
  const folder = hits[0]
  const files = (await readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile() === true && /\.jsonl(\.zstd)?$/.test(entry.name))
    .map((entry) => entry.name)
  if (files.length === 0) throw codedError('log-not-found', `the session folder ${folder} holds no .jsonl log`)
  files.sort((a, b) => generationOf(a) - generationOf(b))
  return { path: join(folder, files[files.length - 1]) }
}

function generationOf(name) {
  const match = /\.v(\d+)\./.exec(name)
  return match === null ? 0 : Number(match[1])
}

async function readHeaderFrom(path) {
  const raw = await readFile(path)
  if (!path.endsWith('.zstd')) {
    const newline = raw.indexOf(0x0a)
    return parseHeaderLine(raw.subarray(0, newline === -1 ? raw.length : newline).toString('utf8'))
  }
  const scan = scanZstdFrames(raw, 1)
  if (scan.frames.length === 0) {
    throw codedError('log-corrupt', `the first zstandard frame of ${path} could not be located`)
  }
  const first = scan.frames[0]
  return parseHeaderLine(zstdDecompressSync(raw.subarray(first.start, first.end)).toString('utf8'))
}

async function rewriteHeader(path, nextHeader) {
  const raw = await readFile(path)
  if (!path.endsWith('.zstd')) {
    const newline = raw.indexOf(0x0a)
    const body = newline === -1 ? Buffer.alloc(0) : raw.subarray(newline + 1)
    return Buffer.concat([Buffer.from(`${JSON.stringify(nextHeader)}\n`, 'utf8'), body])
  }
  const scan = scanZstdFrames(raw, 1)
  if (scan.frames.length === 0) {
    throw codedError('log-corrupt', `the first zstandard frame of ${path} could not be located`)
  }
  const first = scan.frames[0]
  const recompressed = zstdCompressSync(Buffer.from(`${JSON.stringify(nextHeader)}\n`, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
  return Buffer.concat([recompressed, raw.subarray(first.end)])
}

function parseHeaderLine(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw codedError('log-corrupt', 'the session log does not begin with a JSON header line')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.type !== 'session') {
    throw codedError('log-corrupt', 'the session log does not begin with a session header')
  }
  return value
}

/** Mirrors the JSONL store so a session folder resolves where the store expects it. */
function encodeSegment(raw) {
  if (raw === '') throw codedError('bad-request', 'an empty name cannot name a session folder')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (const character of raw) {
    const safe = character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
    out += safe ? character : `~${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return '_no-cwd'
  let readable = ''
  let separatorRun = 0
  for (const character of cwd) {
    if (character === '/' || character === '\\' || character === ':') {
      separatorRun += 1
      continue
    }
    if (separatorRun > 0) {
      readable += '-'
      separatorRun = 0
    }
    readable +=
      character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
        ? character
        : `~${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  }
  if (separatorRun > 0) readable += '-'
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function sessionDir(root, cwd, sessionId) {
  return join(root, projectKey(cwd), encodeSegment(sessionId))
}

/* ------------------------------------------------------ zstandard frames -- */

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let start = 0
  while (start < buffer.length && frames.length < maxFrames) {
    let offset = start
    if (buffer.length - offset < 8) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) return { frames, tornStart: start }
    offset += 4
    const descriptor = buffer[offset]
    offset += 1
    const frameContentSizeFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const hasChecksum = (descriptor >> 2) & 1
    const dictionaryFlag = descriptor & 3
    const contentSizeBytes = frameContentSizeFlag === 0 ? (singleSegment === 1 ? 1 : 0) : 1 << frameContentSizeFlag
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    if (singleSegment !== 1) offset += 1
    offset += dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const block = buffer.readUIntLE(offset, 3)
      offset += 3
      const last = (block & 1) !== 0
      const type = (block >>> 1) & 3
      const size = block >>> 3
      if (type === 3) return { frames, tornStart: start }
      offset += type === 1 ? 1 : size
      if (last) break
    }
    if (hasChecksum === 1) offset += 4
    if (offset > buffer.length) return { frames, tornStart: start }
    frames.push({ start, end: offset })
    start = offset
  }
  return { frames }
}

/* -------------------------------------------------------------- registry -- */

/**
 * The registry memoises the headers and canonical cwds it has already resolved.
 * Dropping this session's entries makes `attachSession` read the rewritten log
 * instead of answering from the pre-move snapshot.
 */
function invalidateSessionCache(registry, sessionId) {
  for (const field of ['headers', 'sessionPaths', 'missingSessionPaths', 'invalidSessionPaths']) {
    const store = registry?.[field]
    if (store !== null && typeof store === 'object' && typeof store.delete === 'function') store.delete(sessionId)
  }
}

function describeWorkspace(workspace) {
  return { workspaceId: workspace.id, title: workspace.title, path: workspace.path }
}

/* --------------------------------------------------------------- helpers -- */

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw codedError('bad-request', 'the request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw codedError('bad-request', 'the request body is not JSON')
  }
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function asId(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function fail(code, message) {
  return { ok: false, error: { code, message } }
}

function toErrorInfo(error) {
  if (error !== null && typeof error === 'object') {
    return {
      code: typeof error.code === 'string' ? error.code : 'internal',
      message: typeof error.message === 'string' ? error.message : String(error),
    }
  }
  return { code: 'internal', message: String(error) }
}

/** Pure helpers, exported so the move path can be exercised without a live host. */
export const internals = {
  encodeSegment,
  projectKey,
  sessionDir,
  scanZstdFrames,
  readHeaderFrom,
  rewriteHeader,
  findStoredLog,
  relocateLog,
  rollbackLog,
}
