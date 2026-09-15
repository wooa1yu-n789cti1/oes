#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const exactHistoricalPath = 'docs/plans/features/delegated-task-action-grant.md'
const exactHistoricalHash = '9909b5f32668c44635a578dd35a7d37ede655c008edce614f9ff2e26593826e3'
const exactHistoricalConsumers = new Set([
  'AGENTS.md',
  'docs/governance/document-governance.md',
  'docs/contracts/ai-platform/task-assistant-tool-contract.md',
  'src/ai-platform/tool-contracts/registrations/task-assistant-collaboration-task.v1.json',
  'src/ai-platform/tool-contracts/registrations/task-assistant-collaboration-task.v1.static.check.mjs'
])

/** Returns all tracked repository paths so generated and ignored files cannot affect governance. */
function trackedPaths() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'git ls-files failed')
  return result.stdout.split('\0').filter(Boolean)
}

/** Extracts a Markdown link destination without interpreting external URLs or optional titles. */
function markdownDestination(raw) {
  const value = raw.trim()
  if (value.startsWith('<')) return value.slice(1, value.indexOf('>'))
  return value.split(/\s+["']/u, 1)[0]
}

/** Resolves every tracked Markdown relative link and reports missing local targets. */
function checkMarkdownLinks(paths) {
  const failures = []
  for (const path of paths.filter((item) => item.endsWith('.md') && existsSync(resolve(root, item)))) {
    const source = readFileSync(resolve(root, path), 'utf8')
    for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/gu)) {
      const destination = markdownDestination(match[1]).split('#', 1)[0]
      if (!destination || /^(?:[a-z][a-z0-9+.-]*:|#|\/)/iu.test(destination)) continue
      let decoded
      try {
        decoded = decodeURIComponent(destination)
      } catch {
        failures.push(`INVALID_MARKDOWN_LINK ${path} -> ${destination}`)
        continue
      }
      if (!existsSync(resolve(root, dirname(path), decoded))) {
        failures.push(`BROKEN_MARKDOWN_LINK ${path} -> ${destination}`)
      }
    }
  }
  return failures
}

/** Rejects historical-tree references except the exact immutable ToolContract v1 dependency. */
function checkHistoricalReferences(paths) {
  const failures = []
  const actualConsumers = new Set()
  const pattern = /(?:docs\/)?plans\/(?:features|deliveries)\/[A-Za-z0-9._/-]*/gu
  for (const path of paths.filter((item) => existsSync(resolve(root, item)))) {
    if (path === 'checks/document-governance.static.check.mjs') continue
    let source
    try {
      source = readFileSync(resolve(root, path), 'utf8')
    } catch {
      continue
    }
    for (const match of source.matchAll(pattern)) {
      const normalized = match[0].startsWith('docs/') ? match[0] : `docs/${match[0]}`
      if (normalized === exactHistoricalPath) actualConsumers.add(path)
      if (normalized === exactHistoricalPath && exactHistoricalConsumers.has(path)) continue
      failures.push(`HISTORICAL_REFERENCE ${path} -> ${match[0]}`)
    }
  }
  const expected = [...exactHistoricalConsumers].sort()
  const actual = [...actualConsumers].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`HISTORICAL_CONSUMER_SET expected=${expected.join(',')} actual=${actual.join(',')}`)
  }
  return failures
}

/** Ensures the only current-tree historical file is the byte-exact immutable v1 dependency. */
function checkHistoricalTree(paths) {
  const failures = []
  const current = paths.filter(
    (path) =>
      existsSync(resolve(root, path)) &&
      (path.startsWith('docs/plans/features/') || path.startsWith('docs/plans/deliveries/'))
  )
  if (current.length !== 1 || current[0] !== exactHistoricalPath) {
    failures.push(`HISTORICAL_TREE ${current.join(',') || 'empty'}`)
    return failures
  }
  const actual = createHash('sha256').update(readFileSync(resolve(root, exactHistoricalPath))).digest('hex')
  if (actual !== exactHistoricalHash) failures.push(`IMMUTABLE_V1_SOURCE_HASH ${actual}`)
  return failures
}

/** Rejects explicit frozen, accepted, or implemented document states in the active design directory. */
function checkActiveDesignStates(paths) {
  const failures = []
  const designs = paths.filter(
    (path) =>
      path.startsWith('docs/plans/designs/') &&
      path.endsWith('.md') &&
      !path.endsWith('/README.md') &&
      existsSync(resolve(root, path))
  )
  for (const path of designs) {
    const source = readFileSync(resolve(root, path), 'utf8')
    if (/^\s*doNotUseAsStableSource\s*:/imu.test(source)) {
      failures.push(`CONFLICTING_DESIGN_AUTHORITY_FIELD ${path} -> doNotUseAsStableSource`)
    }
    for (const match of source.matchAll(/^\s*(?:status|designStatus)\s*:\s*(.+)$/gimu)) {
      const value = match[1].trim().toUpperCase()
      if (/^(?:ACTIVE_DESIGN_WORKSPACE|ACTIVE_LONG_TERM_DESIGN)$/u.test(value)) continue
      if (/(?:FROZEN|ACCEPTED|IMPLEMENTED)/u.test(value)) {
        failures.push(`INACTIVE_DESIGN_WORKSPACE ${path} -> ${match[1].trim()}`)
      }
    }
  }
  return { failures, count: designs.length }
}

/** Rejects user-specific home-directory paths from tracked Markdown. */
function checkHomePaths(paths) {
  const failures = []
  const pattern = /(?:\/(?:Users|home)\/[^/\s)]+\/|[A-Za-z]:\\Users\\[^\\\s)]+\\)/u
  for (const path of paths.filter((item) => item.endsWith('.md') && existsSync(resolve(root, item)))) {
    if (pattern.test(readFileSync(resolve(root, path), 'utf8'))) failures.push(`HOME_PATH ${path}`)
  }
  return failures
}

/** Runs one Git whitespace/error check and preserves the failing surface in its diagnostic. */
function runGitDiffCheck(repositoryRoot, code, args) {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
  return result.status === 0 ? [] : [`${code} ${result.stdout}${result.stderr}`.trim()]
}

/** Checks the committed candidate, staged index, and unstaged worktree without assuming a parent commit. */
export function checkGitDiff(repositoryRoot = root) {
  const failures = []
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  })
  if (head.status === 0) {
    const parent = spawnSync('git', ['rev-parse', '--verify', 'HEAD^'], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    })
    const committedArgs = parent.status === 0
      ? ['diff', '--check', parent.stdout.trim(), 'HEAD']
      : ['diff-tree', '--root', '--check', '--no-commit-id', '-r', 'HEAD']
    failures.push(...runGitDiffCheck(repositoryRoot, 'GIT_COMMITTED_DIFF_CHECK', committedArgs))
  }
  failures.push(
    ...runGitDiffCheck(repositoryRoot, 'GIT_CACHED_DIFF_CHECK', ['diff', '--cached', '--check']),
    ...runGitDiffCheck(repositoryRoot, 'GIT_WORKTREE_DIFF_CHECK', ['diff', '--check'])
  )
  return failures
}

/** Executes the repository document-governance checks. */
export function main() {
  const paths = trackedPaths()
  const activeDesigns = checkActiveDesignStates(paths)
  const failures = [
    ...checkMarkdownLinks(paths),
    ...checkHistoricalReferences(paths),
    ...checkHistoricalTree(paths),
    ...activeDesigns.failures,
    ...checkHomePaths(paths),
    ...checkGitDiff()
  ]

  if (failures.length) {
    for (const failure of failures) console.error(failure)
    console.error(`DOCS_CHECK=FAIL failures=${failures.length}`)
    return 1
  }
  const markdown = paths.filter((path) => path.endsWith('.md') && existsSync(resolve(root, path))).length
  console.log(`DOCS_CHECK=PASS markdown=${markdown} activeDesigns=${activeDesigns.count} historicalExceptions=1`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = main()
}
