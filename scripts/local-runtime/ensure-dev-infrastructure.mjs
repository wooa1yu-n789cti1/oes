#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadRuntimeConfig } from './src/config.mjs'
import { releaseFifoIdentity } from './src/locks.mjs'
import { reopenManifest, resolveEndpoint, resolveResources } from './src/manifest.mjs'
import { assertDockerIdentity, isMissingDockerObject } from './src/docker-driver.mjs'
import { publishStackState, startRuntime } from './src/orchestrator.mjs'
import { runChecked } from './src/process.mjs'
import { removeStackLease, reopenStackLease, stackLeasePath } from './src/stack-lease.mjs'

const root = path.resolve(import.meta.dirname, '../..')

/** Returns all published Run manifest paths below the configured state root, newest first. */
function listRunManifests(stateRoot) {
  const stacksRoot = path.join(stateRoot, 'stacks')
  if (!fs.existsSync(stacksRoot)) return []
  const results = []
  for (const stackName of fs.readdirSync(stacksRoot)) {
    const runsRoot = path.join(stacksRoot, stackName, 'runs')
    if (!fs.existsSync(runsRoot)) continue
    for (const taskName of fs.readdirSync(runsRoot)) {
      const taskRoot = path.join(runsRoot, taskName)
      for (const runName of fs.readdirSync(taskRoot)) {
        const manifestPath = path.join(taskRoot, runName, 'manifest.json')
        if (fs.existsSync(manifestPath))
          results.push({ path: manifestPath, modifiedAt: fs.statSync(manifestPath).mtimeMs })
      }
    }
  }
  return results.sort((left, right) => right.modifiedAt - left.modifiedAt)
}

/** Reopens one Docker container through its sealed object ID. */
function inspectDockerContainer(objectId) {
  return JSON.parse(
    runChecked('docker', ['inspect', '--type', 'container', objectId], { timeout: 20000 }).stdout
  )[0]
}

/** Finds the newest structurally valid DEV infrastructure registration without trusting recorded readiness. */
export function findRegisteredDevInfrastructure({ stateRoot, owners }) {
  const expectedOwners = [...owners].sort().join(',')
  for (const candidate of listRunManifests(stateRoot)) {
    try {
      const manifest = reopenManifest(candidate.path)
      if (
        manifest.profile !== 'DEV' ||
        manifest.lifecycle !== 'REGISTERED' ||
        manifest.taskKey !== 'developer_dev' ||
        [...manifest.owners].sort().join(',') !== expectedOwners ||
        manifest.endpoints.some((binding) => binding.source !== 'STACK') ||
        fs.existsSync(path.join(manifest.runDirectory, 'cleanup.json'))
      ) continue
      const leasePath = stackLeasePath(manifest.stackRoot, manifest.taskKey, manifest.runId)
      reopenStackLease(leasePath, {
        stackRoot: manifest.stackRoot,
        stackKey: manifest.stackKey,
        devStackId: manifest.devStackId,
        taskKey: manifest.taskKey,
        runId: manifest.runId
      })
      if (!manifest.endpoints.length || manifest.endpoints.some((binding) => !resolveEndpoint(manifest, binding)?.ready)) continue
      return { manifest, manifestPath: candidate.path }
    } catch {}
  }
  return null
}

/** Classifies every sealed shared container as active or stopped while failing closed on identity drift. */
export function inspectDevInfrastructureContainers(
  manifest,
  { inspectContainer = inspectDockerContainer, resolveManifestResources = resolveResources } = {}
) {
  const resources = resolveManifestResources(manifest, { includeStack: true })
  const containers = resources.filter(
    (resource) =>
      resource.scope === 'SHARED' &&
      resource.kind === 'container' &&
      resource.pool === manifest.pool
  )
  if (!containers.length) throw new Error('DEV_INFRA_SHARED_CONTAINERS_REQUIRED')

  const byName = new Map(containers.map((resource) => [resource.name, resource]))
  for (const resource of resources.filter(
    (item) => item.containerScope === 'SHARED' && item.pool === manifest.pool
  )) {
    const container = byName.get(resource.containerName)
    if (
      !container ||
      container.objectId !== resource.containerObjectId
    ) {
      throw new Error(
        `DEV_INFRA_CONTAINER_REFERENCE_MISMATCH provider=${resource.provider} kind=${resource.kind}`
      )
    }
  }

  const stopped = []
  for (const resource of containers) {
    let observed
    try {
      observed = inspectContainer(resource.objectId)
    } catch (cause) {
      if (isMissingDockerObject(cause, 'container')) {
        try {
          const replacement = inspectContainer(resource.name)
          throw new Error(
            `DEV_INFRA_CONTAINER_IDENTITY_MISMATCH provider=${resource.provider} expectedObjectId=${resource.objectId} observedObjectId=${replacement.Id}`,
            { cause }
          )
        } catch (nameCause) {
          if (!isMissingDockerObject(nameCause, 'container')) throw nameCause
          throw new Error(
            `DEV_INFRA_CONTAINER_MISSING provider=${resource.provider} objectId=${resource.objectId}`,
            { cause }
          )
        }
      }
      throw new Error(`DEV_INFRA_CONTAINER_INSPECTION_FAILED provider=${resource.provider}`, {
        cause
      })
    }
    try {
      assertDockerIdentity(resource, () => observed)
    } catch (cause) {
      throw new Error(
        `DEV_INFRA_CONTAINER_IDENTITY_MISMATCH provider=${resource.provider} objectId=${resource.objectId}`,
        { cause }
      )
    }
    if (observed.State?.Running !== true) stopped.push(resource.provider)
  }
  return {
    status: stopped.length ? 'STOPPED' : 'ACTIVE',
    containerCount: containers.length,
    stoppedProviders: stopped
  }
}

/** Finds one exact running DEV registration for backend preparation without trusting a stale ready flag. */
export function findReusableDevInfrastructure({ stateRoot, owners, inspectContainer }) {
  const registered = findRegisteredDevInfrastructure({ stateRoot, owners })
  if (!registered) return null
  const containerState = inspectDevInfrastructureContainers(registered.manifest, {
    ...(inspectContainer ? { inspectContainer } : {})
  })
  return containerState.status === 'ACTIVE' ? { ...registered, containerState } : null
}

/** Requires a newly provisioned manifest to contain a ready endpoint for every planned provider. */
function assertProvisionedProvidersReady(started) {
  const providers = started.manifest.plan?.providers || []
  for (const provider of providers) {
    const endpoint = started.manifest.endpoints.find(
      (candidate) => (candidate.allocationProvider || candidate.provider) === provider
    )
    if (!endpoint?.ready) throw new Error(`DEV_INFRA_PROVIDER_NOT_READY provider=${provider}`)
  }
  if (!providers.length || providers.length !== started.manifest.endpoints.length) {
    throw new Error('DEV_INFRA_PROVIDER_SET_INCOMPLETE')
  }
  return providers
}

/** Retires only the superseded Run lease after a fully ready replacement registration exists. */
function retireSupersededRegistration(previous, started) {
  const leasePath = stackLeasePath(
    previous.manifest.stackRoot,
    previous.manifest.taskKey,
    previous.manifest.runId
  )
  removeStackLease(leasePath, {
    stackRoot: previous.manifest.stackRoot,
    stackKey: previous.manifest.stackKey,
    devStackId: previous.manifest.devStackId,
    taskKey: previous.manifest.taskKey,
    runId: previous.manifest.runId
  })
  releaseFifoIdentity(
    previous.manifest.stateRoot,
    previous.manifest.taskKey,
    previous.manifest.runId
  )
  publishStackState(started.context)
}

/** Revalidates or recovers DEV providers through the normal provisioners before publishing readiness. */
export async function ensureDevelopmentInfrastructure({
  rootDirectory = root,
  stateRoot,
  owners,
  findRegistered = findRegisteredDevInfrastructure,
  inspectContainers = inspectDevInfrastructureContainers,
  start = startRuntime,
  retire = retireSupersededRegistration,
  onProgress = () => {}
}) {
  const previous = findRegistered({ stateRoot, owners })
  const previousState = previous ? inspectContainers(previous.manifest) : null
  onProgress({
    stage: previousState?.status === 'STOPPED'
      ? 'INFRASTRUCTURE_RECOVER'
      : previous
        ? 'INFRASTRUCTURE_REVALIDATE'
        : 'INFRASTRUCTURE_REGISTER',
    stoppedProviders: previousState?.stoppedProviders || []
  })

  const started = await start(
    {
      root: rootDirectory,
      profile: 'DEV',
      testClass: 'integration',
      owners,
      taskKey: 'developer_dev',
      driver: 'docker',
      stateRoot
    },
    {
      afterProgressPublished: ({ provider }) =>
        onProgress({ stage: 'PROVIDER_READY', provider })
    }
  )
  try {
    const providers = assertProvisionedProvidersReady(started)
    if (previous) retire(previous, started)
    return {
      started,
      providers,
      reused: Boolean(previous),
      recovered: previousState?.status === 'STOPPED',
      recoveredProviders: previousState?.stoppedProviders || []
    }
  } finally {
    started.releaseSlot()
    started.releaseRunLock()
    started.releaseDevLock()
  }
}

/** Reuses active full DEV infrastructure or registers it once without occupying an execution slot. */
export async function main() {
  const config = loadRuntimeConfig({ root, profile: 'DEV', explicit: {} })
  const owners = Object.keys(
    JSON.parse(fs.readFileSync(path.join(root, 'scripts/local-runtime/relationships.json'), 'utf8')).owners
  )
  const result = await ensureDevelopmentInfrastructure({
    rootDirectory: root,
    stateRoot: config.stateRoot,
    owners,
    onProgress: ({ stage, provider, stoppedProviders }) =>
      process.stdout.write(
        `[local-runtime] stage=${stage}${provider ? ` provider=${provider}` : ''}${stoppedProviders?.length ? ` stopped=${stoppedProviders.join(',')}` : ''}\n`
      )
  })
  process.stdout.write(`${JSON.stringify({
    status: 'INFRA_READY',
    reused: result.reused,
    recovered: result.recovered,
    recoveredProviders: result.recoveredProviders,
    releasedSlots: 1,
    manifestPath: result.started.file,
    manifestFingerprint: result.started.manifest.manifestFingerprint,
    providers: result.providers
  }, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`${error.stack || error.message || error}\n`)
    process.exitCode = 1
  }
}
