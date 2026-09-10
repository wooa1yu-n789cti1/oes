import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

export const TEST_TYPES = Object.freeze(['unit', 'component', 'contract', 'integration', 'journey'])

/** Selects the mature package-native scripts used by each orchestration lane. */
export function packageScriptsForKind(
  record,
  kind,
  { delegateBuild = false, delegateTypecheck = false } = {}
) {
  if (kind === 'build') return record.scripts?.build && !delegateBuild ? ['build'] : []
  if (kind !== 'static') throw new Error(`Unknown package script kind: ${kind}`)
  return Object.keys(record.scripts || {})
    .filter(
      (script) =>
        (script === 'typecheck' && !delegateTypecheck) ||
        script === 'check:type' ||
        script === 'check:static' ||
        script.startsWith('check:static:')
    )
    .sort()
}

/** Resolves the concrete service owners needed by selected cross-service Journey families. */
export function integrationOwnersForTests(tests, relationships) {
  const owners = new Set()
  for (const test of tests) {
    if (test.type !== 'journey') {
      owners.add(test.owner)
      continue
    }
    const families = (relationships.journeyFamilies || []).filter((family) =>
      (family.journeyGlobs || []).some((glob) => matchesAny(test.path, [glob]))
    )
    if (families.length !== 1) {
      throw new Error(
        `Journey must match exactly one family: ${test.path}; matches=${families.length}`
      )
    }
    for (const owner of families[0].consumerOwners || []) owners.add(owner)
  }
  return [...owners].sort()
}

const canonicalTestPattern =
  /\.(unit|component|contract|integration|journey)\.spec\.(?:(?:c|m)?(?:j|t)sx?|kt)$/
const ordinaryTestPattern = /\.(?:spec|test)\.(?:(?:c|m)?(?:j|t)sx?|kt)$/
const androidTestPattern = /\/src\/(test|androidTest)\/.*Test\.kt$/
const ignoredDirectoryNames = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.tmp',
  'coverage',
  'dist',
  'generated',
  'node_modules'
])

/** Normalizes a repository-relative path to portable forward slashes. */
export function normalizePath(value) {
  return value.split(sep).join('/').replace(/^\.\//, '')
}

/** Recursively lists files while excluding generated and dependency directories. */
export function walkFiles(root, current = root, result = []) {
  if (resolve(current) === resolve(root) && result.length === 0) {
    try {
      const repositoryRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      if (realpathSync(repositoryRoot) === realpathSync(root)) {
        return execFileSync(
          'git',
          ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        )
          .split('\0')
          .filter(Boolean)
          .map(normalizePath)
          .filter((path) => existsSync(resolve(root, path)) && statSync(resolve(root, path)).isFile())
      }
    } catch {
      // Non-repository fixture roots retain the filesystem traversal used by unit tests.
    }
  }
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) walkFiles(root, absolute, result)
    else if (entry.isFile()) result.push(normalizePath(relative(root, absolute)))
  }
  return result
}

/** Reads one JSON file and adds its source path to parse failures. */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot parse JSON ${path}: ${error.message}`)
  }
}

/** Finds every package boundary dynamically rather than maintaining a package allowlist. */
export function discoverPackages(root) {
  const records = []
  for (const file of walkFiles(root).filter((path) => basename(path) === 'package.json')) {
    const packageJson = readJson(resolve(root, file))
    const directory = normalizePath(dirname(file)) === '.' ? '' : normalizePath(dirname(file))
    records.push({
      directory,
      name: packageJson.name || (directory ? `path:${directory}` : 'workspace-root'),
      scripts: packageJson.scripts || {},
      dependencies: {
        ...(packageJson.dependencies || {}),
        ...(packageJson.devDependencies || {}),
        ...(packageJson.optionalDependencies || {}),
        ...(packageJson.peerDependencies || {})
      }
    })
  }
  return records.sort((left, right) => {
    const depth = right.directory.split('/').length - left.directory.split('/').length
    return depth || left.directory.localeCompare(right.directory)
  })
}

/** Resolves ownership to the nearest enclosing package boundary. */
export function findOwner(path, packages) {
  const normalized = normalizePath(path)
  if (normalized.startsWith('tests/cross-service/')) {
    return { directory: 'tests/cross-service', name: 'cross-service' }
  }
  return (
    packages.find(
      (candidate) =>
        !candidate.directory ||
        normalized === candidate.directory ||
        normalized.startsWith(`${candidate.directory}/`)
    ) || null
  )
}

/** Maps the Android-native test source sets to the frozen taxonomy. */
function classifyAndroid(path) {
  const match = `/${normalizePath(path)}`.match(androidTestPattern)
  if (!match) return null
  return match[1] === 'test' ? 'unit' : 'integration'
}

/** Determines whether a file name is attempting to define a test. */
function isTestCandidate(path) {
  const normalized = `/${normalizePath(path)}`
  return ordinaryTestPattern.test(normalized) || androidTestPattern.test(normalized)
}

/** Validates the canonical path contract for one classified test. */
function validateLocation(path, type, owner) {
  const normalized = normalizePath(path)
  if (androidTestPattern.test(`/${normalized}`)) return null
  if (type === 'journey') {
    return normalized.startsWith('tests/cross-service/')
      ? null
      : 'Journey tests must be under tests/cross-service/'
  }
  if (!owner || !owner.directory) {
    return 'Test is not contained by a non-root package or service'
  }
  const expected = type === 'unit' || type === 'component' ? 'src/' : 'test/'
  return normalized.startsWith(`${owner.directory}/${expected}`)
    ? null
    : `${type} tests must be under ${owner.directory}/${expected}`
}

/** Discovers every test once and reports all fail-closed taxonomy violations. */
export function discoverTests({ root, files = null, packages = null } = {}) {
  const repositoryRoot = resolve(root || process.cwd())
  const inventory = (files || walkFiles(repositoryRoot)).map(normalizePath).sort()
  const packageRecords = packages || discoverPackages(repositoryRoot)
  const tests = []
  const violations = []

  for (const path of inventory) {
    if (!isTestCandidate(path)) continue
    const canonical = path.match(canonicalTestPattern)
    const androidType = classifyAndroid(path)
    const type = canonical?.[1] || androidType
    if (!type) {
      violations.push({ code: 'UNKNOWN_TEST_CLASS', path })
      continue
    }
    if (/(^|\/)l[123](\/|$)/i.test(path)) {
      violations.push({ code: 'LEGACY_TEST_LAYER', path })
      continue
    }
    const owner = findOwner(path, packageRecords)
    if (!owner || (!owner.directory && !path.startsWith('tests/cross-service/'))) {
      violations.push({ code: 'ORPHAN_TEST', path })
      continue
    }
    const locationError = validateLocation(path, type, owner)
    if (locationError) {
      violations.push({ code: 'INVALID_TEST_LOCATION', path, message: locationError })
      continue
    }
    tests.push({ path, type, owner: owner.name, ownerDirectory: owner.directory })
  }

  const duplicates = tests
    .map((test) => test.path)
    .filter((path, index, paths) => paths.indexOf(path) !== index)
  for (const path of duplicates) violations.push({ code: 'OVERLAPPING_TEST_CLASS', path })

  const counts = Object.fromEntries(TEST_TYPES.map((type) => [type, 0]))
  for (const test of tests) counts[test.type] += 1
  return {
    schemaVersion: 1,
    tests: tests.sort((left, right) => left.path.localeCompare(right.path)),
    counts,
    total: tests.length,
    violations: violations.sort((left, right) =>
      `${left.path}:${left.code}`.localeCompare(`${right.path}:${right.code}`)
    )
  }
}

/** Creates package dependency and reverse-dependency edges from declared workspace packages. */
export function buildWorkspaceGraph(packages) {
  const nameCounts = new Map()
  for (const record of packages) nameCounts.set(record.name, (nameCounts.get(record.name) || 0) + 1)
  const duplicateNames = [...nameCounts]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort()
  const byName = new Map(packages.map((record) => [record.name, record]))
  const dependencies = new Map()
  const reverseDependencies = new Map()
  for (const record of packages) {
    const localDependencies = Object.keys(record.dependencies)
      .filter((name) => byName.has(name))
      .sort()
    dependencies.set(record.name, new Set(localDependencies))
    if (!reverseDependencies.has(record.name)) reverseDependencies.set(record.name, new Set())
    for (const dependency of localDependencies) {
      if (!reverseDependencies.has(dependency)) reverseDependencies.set(dependency, new Set())
      reverseDependencies.get(dependency).add(record.name)
    }
  }
  return {
    byName,
    dependencies,
    reverseDependencies,
    errors: duplicateNames.map((name) => `DUPLICATE_PACKAGE_NAME ${name}`)
  }
}

/** Expands owners through every transitive local consumer. */
export function expandReverseDependencies(initial, graph) {
  const result = new Set(initial)
  const queue = [...initial].sort()
  while (queue.length) {
    const current = queue.shift()
    for (const consumer of [...(graph.reverseDependencies.get(current) || [])].sort()) {
      if (result.has(consumer)) continue
      result.add(consumer)
      queue.push(consumer)
    }
  }
  return result
}

/** Converts a small relationship-table glob into a deterministic regular expression. */
export function globToRegExp(glob) {
  let expression = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        expression += '(?:.*/)?'
        index += 2
      } else {
        expression += '.*'
        index += 1
      }
    } else if (char === '*') expression += '[^/]*'
    else if (char === '?') expression += '[^/]'
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(`${expression}$`)
}

/** Returns true when a path matches at least one configured relationship glob. */
export function matchesAny(path, globs = []) {
  return globs.some((glob) => globToRegExp(glob).test(normalizePath(path)))
}

/** Produces a stable content hash for selector inputs and rule identity. */
export function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Executes Git with stable text settings for repository inspection. */
export function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding || 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  })
}

/** Parses name-status -z output including both paths of rename and copy records. */
export function parseNameStatus(buffer) {
  const fields = buffer.toString('utf8').split('\0')
  const changes = []
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++]
    if (!status) break
    if (/^[RC]/.test(status)) {
      const oldPath = normalizePath(fields[index++] || '')
      const path = normalizePath(fields[index++] || '')
      changes.push({ status, oldPath, path })
    } else {
      const path = normalizePath(fields[index++] || '')
      changes.push({ status, path })
    }
  }
  return changes.sort((left, right) =>
    `${left.path}:${left.oldPath || ''}:${left.status}`.localeCompare(
      `${right.path}:${right.oldPath || ''}:${right.status}`
    )
  )
}

/** Reads the complete Git diff without losing rename or delete information. */
export function readGitChanges(root, base, head) {
  const output = execFileSync(
    'git',
    ['diff', '--name-status', '-z', '--find-renames', base, head, '--'],
    { cwd: root, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }
  )
  return parseNameStatus(output)
}

/** Finds the nearest nested pnpm workspace for an owned package. */
export function findWorkspaceRoot(root, directory) {
  let current = resolve(root, directory || '.')
  const repositoryRoot = resolve(root)
  while (current.startsWith(repositoryRoot)) {
    if (existsSync(join(current, 'pnpm-workspace.yaml')))
      return normalizePath(relative(root, current))
    if (current === repositoryRoot) break
    current = dirname(current)
  }
  return ''
}

/** Reads the package globs from a pnpm workspace manifest without interpreting other YAML keys. */
export function readWorkspacePackagePatterns(path) {
  const patterns = []
  let readingPackages = false
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    if (/^packages:\s*$/u.test(line)) {
      readingPackages = true
      continue
    }
    if (!readingPackages) continue
    if (/^\S/u.test(line)) break
    const match = line.match(/^\s*-\s*['"]?(.+?)['"]?\s*$/u)
    if (match) patterns.push(normalizePath(match[1]))
  }
  return patterns
}

/** Returns whether a package is actually enrolled in its nearest pnpm workspace. */
export function isWorkspacePackage(root, record) {
  const workspaceRoot = findWorkspaceRoot(root, record.directory)
  if (normalizePath(record.directory) === workspaceRoot) return true
  const workspaceManifest = resolve(root, workspaceRoot, 'pnpm-workspace.yaml')
  if (!existsSync(workspaceManifest)) return false
  const packagePath = normalizePath(
    relative(resolve(root, workspaceRoot), resolve(root, record.directory))
  )
  let included = false
  for (const pattern of readWorkspacePackagePatterns(workspaceManifest)) {
    const excluded = pattern.startsWith('!')
    const candidate = excluded ? pattern.slice(1) : pattern
    if (globToRegExp(candidate).test(packagePath)) included = !excluded
  }
  return included
}

/** Ensures a file is present and regular before a CLI consumes it. */
export function requireFile(path) {
  if (!existsSync(path) || !statSync(path).isFile())
    throw new Error(`Required file is missing: ${path}`)
  return path
}
