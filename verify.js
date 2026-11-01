/**
 * Offline proof for the move path: copies one real session folder into a
 * throwaway sessions root, relocates it to another project directory, checks the
 * bytes and the header, then rolls it back. Nothing under the live `.dsh` home
 * is touched.
 */

import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const { encodeSegment, projectKey, sessionDir, scanZstdFrames, readHeaderFrom, relocateLog, rollbackLog, findStoredLog } =
  await import('./index.js').then((module) => module.internals)

const LIVE_ROOT = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? 'C:\\Users\\森', '.dsh'), 'sessions')
const WORK = join(process.cwd(), '.tmp-mover-test')
const ROOT = join(WORK, 'sessions')
const TARGET_CWD = 'D:\\DSH\\ray'

const checks = []
function check(name, condition, detail) {
  checks.push({ name, ok: condition === true, detail })
  console.log(`${condition === true ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`)
}

async function main() {
  await rm(WORK, { recursive: true, force: true })
  await mkdir(ROOT, { recursive: true })

  const sourceProject = '--D-DSH--'
  const entries = await readdir(join(LIVE_ROOT, sourceProject), { withFileTypes: true })
  const sessions = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const files = await readdir(join(LIVE_ROOT, sourceProject, entry.name), { withFileTypes: true })
    const log = files.find((file) => file.isFile() && file.name.endsWith('.jsonl.zstd'))
    if (log === undefined) continue
    const size = (await stat(join(LIVE_ROOT, sourceProject, entry.name, log.name))).size
    sessions.push({ id: entry.name, file: log.name, size })
  }
  sessions.sort((a, b) => a.size - b.size)
  const picked = sessions[0]
  console.log(`source session: ${picked.id} (${picked.file}, ${picked.size} bytes)\n`)

  const staged = join(ROOT, sourceProject, picked.id)
  await mkdir(join(ROOT, sourceProject), { recursive: true })
  await cp(join(LIVE_ROOT, sourceProject, picked.id), staged, { recursive: true })

  const before = await readFile(join(staged, picked.file))
  const beforeScan = scanZstdFrames(before)
  const beforeHeader = await readHeaderFrom(join(staged, picked.file))
  console.log(`before: ${before.length} bytes, ${beforeScan.frames.length} frames, cwd=${beforeHeader.cwd}\n`)

  check('frame scan covers the whole file', beforeScan.frames.at(-1).end === before.length)

  const located = await findStoredLog(ROOT, picked.id)
  check('finds the staged log', located.path === join(staged, picked.file), located.path)

  const relocated = await relocateLog(ROOT, picked.id, TARGET_CWD)
  const expectedDir = sessionDir(ROOT, TARGET_CWD, picked.id)
  check('moves into the target project folder', relocated.to === join(expectedDir, picked.file), relocated.to)
  check('target folder name matches the store convention', expectedDir.endsWith(join(projectKey(TARGET_CWD), encodeSegment(picked.id))), expectedDir)
  check('old folder is gone', await dirExists(staged) === false)

  const after = await readFile(relocated.to)
  const afterScan = scanZstdFrames(after)
  const afterHeader = await readHeaderFrom(relocated.to)

  check('rewrites the header cwd', afterHeader.cwd === TARGET_CWD, `cwd=${afterHeader.cwd}`)
  check('keeps the session id', afterHeader.id === beforeHeader.id, afterHeader.id)
  check('keeps the format version', afterHeader.version === beforeHeader.version, `v${afterHeader.version}`)
  check('keeps the same event-row count in the first frame index', afterScan.frames.length === beforeScan.frames.length,
    `${beforeScan.frames.length} → ${afterScan.frames.length}`)
  check('keeps every byte after the first frame', bufferEquals(
    after.subarray(afterScan.frames[0].end),
    before.subarray(beforeScan.frames[0].end),
  ))

  const beforeRows = decompressRows(before)
  const afterRows = decompressRows(after)
  check('whole file still decompresses', afterRows.length > 0, `${afterRows.length} lines`)
  check('row count unchanged', afterRows.length === beforeRows.length, `${beforeRows.length} → ${afterRows.length}`)
  check('first row is the rewritten header', JSON.parse(afterRows[0]).cwd === TARGET_CWD)
  check('event rows unchanged', afterRows.slice(1).join('\n') === beforeRows.slice(1).join('\n'))

  const again = await findStoredLog(ROOT, picked.id)
  check('the store resolves it in exactly one place', again.path === relocated.to, again.path)

  const duplicate = join(ROOT, '--D-ELSEWHERE--', encodeSegment(picked.id))
  await mkdir(duplicate, { recursive: true })
  await cp(relocated.to, join(duplicate, picked.file))
  const error = await findStoredLog(ROOT, picked.id).then(() => undefined, (caught) => caught)
  check('refuses an ambiguous session id', error?.code === 'log-ambiguous', error?.message)
  await rm(join(ROOT, '--D-ELSEWHERE--'), { recursive: true, force: true })

  const rolled = await rollbackLog(relocated)
  check('rolls back', rolled.ok === true, JSON.stringify(rolled))
  const restored = await readFile(join(staged, picked.file))
  const restoredHeader = await readHeaderFrom(join(staged, picked.file))
  check('rollback restores the original cwd', restoredHeader.cwd === beforeHeader.cwd, restoredHeader.cwd)
  check(
    'rollback restores the original rows',
    decompressRows(restored).join('\n') === decompressRows(before).join('\n'),
    `${restored.length} vs ${before.length} bytes (header frame recompresses at a different length)`,
  )

  const compressRoundTrip = zstdCompressSync(Buffer.from('{"type":"session"}\n', 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
  check('checksum-flagged compression round-trips', zstdDecompressSync(compressRoundTrip).toString('utf8') === '{"type":"session"}\n')

  const failed = checks.filter((entry) => entry.ok !== true)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  await rm(WORK, { recursive: true, force: true })
  if (failed.length > 0) process.exitCode = 1
}

function decompressRows(buffer) {
  const text = zstdDecompressSync(buffer).toString('utf8')
  return text.split('\n').filter((line) => line.trim() !== '')
}

function bufferEquals(left, right) {
  return left.length === right.length && left.equals(right)
}

async function dirExists(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

await main()
