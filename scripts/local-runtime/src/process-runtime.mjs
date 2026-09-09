import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveCredentialReference } from './credentials.mjs'
import { cleanProcessEnvironment } from './bootstrap.mjs'
import { environmentForOwner, publishManifest, reopenManifest } from './manifest.mjs'
import { cleanupDockerResource, exactResourceToken, runtimeLabels } from './docker-driver.mjs'
import { canonicalJson, sha256, writeAtomic } from './canonical.mjs'
import { runChecked } from './process.mjs'
import { trustedProcessEnvironment } from './trusted-runtime-config.mjs'
import { auditDevelopmentProcessEnvironments } from './development-process-config.mjs'
import { withExclusiveLock } from './locks.mjs'
import { publishStackState } from './orchestrator.mjs'

/** Reserves one OS-assigned loopback port until the caller explicitly hands it to a child. */
export async function reservePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      let released = false
      resolvePromise({
        port: address.port,
        release: () => new Promise((resolveRelease, rejectRelease) => {
          if (released) return resolveRelease()
          released = true
          server.close((error) => error ? rejectRelease(error) : resolveRelease())
        })
      })
    })
  })
}

/** Polls one exact process endpoint until it is reachable or exits. */
async function waitForProcess(child, owner, port, timeoutMs = 180000, signal) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw signal.reason
    if (child.exitCode !== null) throw new Error(`DEV_PROCESS_EXITED owner=${owner} exit=${child.exitCode}`)
    const ready = await new Promise((resolvePromise) => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      const done = (value) => { socket.destroy(); resolvePromise(value) }
      socket.setTimeout(250, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false))
    })
    if (ready) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error(`DEV_PROCESS_READINESS_TIMEOUT owner=${owner} port=${port}`)
}

/** Polls one host UDS facade until it accepts a local connection or its process exits. */
async function waitForUnixProcess(child, owner, socketPath, timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`DEV_PROCESS_EXITED owner=${owner} exit=${child.exitCode}`)
    const ready = await new Promise((resolvePromise) => {
      const socket = net.createConnection(socketPath)
      const done = (value) => { socket.destroy(); resolvePromise(value) }
      socket.setTimeout(250, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false))
    })
    if (ready) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`DEV_PROCESS_READINESS_TIMEOUT owner=${owner} socket=${socketPath}`)
}

/** Projects every supported URL spelling for one exact local gRPC endpoint. */
export function endpointEnvironment(owner, port) {
  const stem = owner.replace(/-service$/u, '').replace(/[^a-zA-Z0-9]/gu, '_').toUpperCase()
  const host = `${owner}.localhost`
  const url = `${host}:${port}`
  return {
    [`GRPC_SERVICE_${stem}_URL`]: url,
    [`${stem}_GRPC_URL`]: url,
    [`${stem}_SERVICE_GRPC_URL`]: url,
    [`${stem}_SERVICE_HOST`]: host,
    [`${stem}_SERVICE_PORT`]: String(port)
  }
}

/** Creates the minimal endpoint projection declared for one owner plus its own endpoint. */
export function downstreamEnvironment(owner, ports, declarations) {
  const permitted = new Set([owner, ...(declarations.owners[owner].downstreams || [])])
  return Object.assign({}, ...[...permitted].filter((downstream) => ports[downstream]).map((downstream) => endpointEnvironment(downstream, ports[downstream])))
}

/** Produces Gateway's authenticated readiness list from only selected declared downstreams. */
export function gatewayReadinessEnvironment(ports, declarations) {
  const targets = (declarations.owners['api-gateway'].downstreams || [])
    .filter((owner) => ports[owner])
    .map((owner) => `${owner}=grpcs://${owner}.localhost:${ports[owner]}`)
  return targets.length ? { GATEWAY_READINESS_TARGETS: targets.join(',') } : {}
}

/** Hashes the exact signer source tree used to build the isolated runtime image. */
export function signerSourceHash(root) {
  const source = path.join(root, 'docker/grpc-trust/execution-token-signer')
  const files = []
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name)
      const stat = fs.statSync(file)
      if (stat.isDirectory()) visit(file)
      else files.push(path.relative(source, file))
    }
  }
  visit(source)
  const hash = crypto.createHash('sha256')
  for (const file of files) hash.update(file).update('\0').update(fs.readFileSync(path.join(source, file))).update('\0')
  return hash.digest('hex')
}

/** Derives a short task/run-owned signer socket root within macOS Unix-socket limits. */
export function signerWorkDirectory(manifest) {
  return path.join('/private/tmp', `oes-signer-${sha256(`${manifest.stateRoot}:${manifest.taskKey}:${manifest.runId}`).slice(0, 12)}`)
}

/** Builds and starts one isolated run-owned protected signer, returning only reference metadata. */
export async function startProtectedSigner(root, manifest, signal) {
  const sourceHash = signerSourceHash(root)
  const provider = 'execution-token-signer'
  const imageLabels = runtimeLabels(manifest, 'SHARED', provider)
  const image = `oes-v2-${exactResourceToken(manifest.stackKey, 32)}-execution-signer:${sourceHash.slice(0, 16)}`
  let observedImage
  try { observedImage = JSON.parse(runChecked('docker', ['image', 'inspect', image], { timeout: 20000 }).stdout)[0] } catch { /* Build the exact Stack cache below. */ }
  if (!observedImage) {
    runChecked('docker', ['build', '--tag', image, ...Object.entries(imageLabels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), '--file', path.join(root, 'docker/grpc-trust/execution-token-signer/local/softhsm2/Dockerfile'), path.join(root, 'docker/grpc-trust/execution-token-signer')], { timeout: 900000 })
    observedImage = JSON.parse(runChecked('docker', ['image', 'inspect', image], { timeout: 20000 }).stdout)[0]
  }
  if (Object.entries(imageLabels).some(([key, value]) => observedImage.Config?.Labels?.[key] !== value)) throw new Error(`SIGNER_IMAGE_LABEL_MISMATCH image=${image}`)
  const work = signerWorkDirectory(manifest)
  if (fs.existsSync(work)) throw new Error(`SIGNER_WORK_DIRECTORY_EXISTS path=${work}`)
  fs.mkdirSync(work, { recursive: true, mode: 0o700 })
  const labels = runtimeLabels(manifest, 'RUN', provider)
  const marker = path.join(work, '.oes-runtime-resource.json')
  writeAtomic(marker, { schemaVersion: 2, path: work, labels })
  const directoryResource = { provider: 'execution-token-signer', scope: 'RUN', kind: 'directory', path: work, marker, objectId: sha256(fs.readFileSync(marker)), labels, cleanup: 'DELETE_DIRECTORY_EXACT' }
  const name = `oes-v2-${exactResourceToken(`${manifest.taskKey}:${manifest.runId}`)}-execution-signer`
  const socket = path.join(work, 'signer.sock')
  const containerSocket = path.join(work, 'container.sock')
  const ready = path.join(work, 'ready')
  const uid = process.getuid?.() ?? 65532
  const gid = process.getgid?.() ?? 65532
  let proxyChild = null
  try {
    runChecked('docker', [
      'run', '--detach', '--name', name,
      ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
      '--network', 'none', '--read-only', '--user', `${uid}:${gid}`,
      '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
      '--tmpfs', '/tmp:mode=1777,exec,size=256m', '--volume', `${work}:/execution-signer`,
      '--env', 'EXECUTION_SIGNER_RUNTIME_MODE=1',
      '--env', 'EXECUTION_SIGNER_HOST_WORK_DIR=/execution-signer',
      '--env', 'EXECUTION_SIGNER_KEEP_HOST_WORK_DIR=1',
      '--env', 'EXECUTION_SIGNER_READY_PATH=/execution-signer/ready',
      '--env', 'AUTH_EXECUTION_SIGNER_SOCKET_PATH=/execution-signer/container.sock',
      image
    ], { timeout: 180000 })
    const observed = JSON.parse(runChecked('docker', ['inspect', '--type', 'container', name], { timeout: 20000 }).stdout)[0]
    if (observed.Image !== observedImage.Id) throw new Error(`SIGNER_IMAGE_IDENTITY_MISMATCH image=${image}`)
    const imageResource = { provider, pool: manifest.pool, scope: 'SHARED', kind: 'image', name: image, objectId: observedImage.Id, labels: imageLabels, sourceHash, cleanup: 'PRESERVE_SHARED' }
    const containerResource = { provider, pool: manifest.pool, scope: 'RUN', kind: 'container', name, objectId: observed.Id, labels, volume: null, cleanup: 'DELETE_EXACT', sourceHash, imageId: observedImage.Id }
    const started = Date.now()
    while (Date.now() - started < 180000) {
      if (signal?.aborted) throw signal.reason
      if (fs.existsSync(ready) && fs.existsSync(socket) && fs.statSync(socket).isSocket()) {
        const keyReference = fs.readFileSync(ready, 'utf8').trim()
        if (!keyReference.startsWith('pkcs11:')) throw new Error('SIGNER_KEY_REFERENCE_INVALID')
        return { resources: [imageResource, directoryResource, containerResource], children: [{ owner: 'execution-token-signer-proxy', kind: 'support', child: proxyChild }], environment: { AUTH_EXECUTION_SIGNER_SOCKET_PATH: socket, AUTH_EXECUTION_KMS_KEY_REF: keyReference }, endpoint: { provider: 'execution-token-signer', authority: `unix:${socket}`, ready: true, owners: ['auth-service'], environment: {}, credentialReference: null } }
      }
      if (fs.existsSync(ready) && fs.existsSync(containerSocket) && fs.statSync(containerSocket).isSocket() && !proxyChild) {
        proxyChild = spawn(process.execPath, [path.join(root, 'scripts/local-runtime/src/uds-docker-proxy.mjs')], { cwd: root, env: { ...cleanProcessEnvironment(), OES_PROXY_SOCKET_PATH: socket, OES_PROXY_CONTAINER_NAME: name }, stdio: 'inherit' })
        await waitForUnixProcess(proxyChild, 'execution-token-signer-proxy', socket)
      }
      const running = JSON.parse(runChecked('docker', ['inspect', '--format', '{{json .State}}', name], { timeout: 10000 }).stdout)
      if (!running.Running) throw new Error(`SIGNER_CONTAINER_EXITED exit=${running.ExitCode}`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    }
    throw new Error('SIGNER_READINESS_TIMEOUT')
  } catch (error) {
    if (proxyChild?.exitCode === null) proxyChild.kill('SIGTERM')
    try { runChecked('docker', ['rm', '--force', name], { timeout: 20000 }) } catch { /* Preserve the primary failure. */ }
    fs.rmSync(work, { recursive: true, force: true })
    throw error
  }
}

/** Publishes signer cache through Stack authority and retains only Run-owned signer truth in the Run. */
export function publishDevelopmentProcessManifest(manifestPath, { signer = null, issuerEndpoints = [], processEndpoints = [] } = {}) {
  const manifest = reopenManifest(manifestPath)
  const sharedSignerResources = (signer?.resources || []).filter((resource) => resource.scope === 'SHARED')
  const stackManifestReference = sharedSignerResources.length ? publishStackState(manifest, sharedSignerResources).reference : manifest.stackManifestReference
  const runSignerResources = (signer?.resources || []).filter((resource) => resource.scope !== 'SHARED')
  const raw = { ...manifest, lifecycle: 'REGISTERED', resources: [...manifest.resources, ...runSignerResources], endpoints: [...manifest.endpoints, ...(signer ? [signer.endpoint] : []), ...issuerEndpoints, ...processEndpoints], stackManifestReference }
  delete raw.manifestFingerprint
  return publishManifest(path.dirname(manifestPath), raw)
}

/** Verifies a directory marker before recursively deleting a run-owned signer work root. */
export function cleanupRuntimeDirectory(resource) {
  const bytes = fs.readFileSync(resource.marker)
  if (sha256(bytes) !== resource.objectId) throw new Error('DIRECTORY_RESOURCE_MARKER_MISMATCH')
  const marker = JSON.parse(bytes.toString('utf8'))
  if (marker.path !== resource.path || canonicalJson(marker.labels) !== canonicalJson(resource.labels)) throw new Error('DIRECTORY_RESOURCE_IDENTITY_MISMATCH')
  fs.rmSync(resource.path, { recursive: true })
  return { resource, disposition: 'DELETED_EXACT', exitStatus: 0 }
}

/** Starts selected host-process business services and republishes their ready endpoints atomically. */
export async function startDevelopmentProcesses(manifestPath, { root, selectorPath, signal } = {}) {
  const manifest = reopenManifest(manifestPath)
  if (manifest.profile !== 'DEV') throw new Error('DEVELOPMENT_PROCESS_PROFILE_REQUIRED')
  const declarations = JSON.parse(fs.readFileSync(path.join(root, 'scripts/local-runtime/relationships.json'), 'utf8'))
  const children = []
  let signer = null
  try {
    if (manifest.owners.includes('auth-service')) {
      signer = await startProtectedSigner(root, manifest, signal)
      children.push(...signer.children)
    }
    if (signal?.aborted) throw signal.reason
    const started = await withExclusiveLock(path.join(manifest.stateRoot, 'locks', 'process-port-allocation.lock'), async () => {
      let lastError
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const ownerReservations = Object.fromEntries(await Promise.all(manifest.owners.map(async (owner) => [owner, await reservePort()])))
        const issuerReservation = await reservePort()
        const authHttpReservation = manifest.owners.includes('auth-service') ? await reservePort() : null
        const reservations = [...Object.values(ownerReservations), issuerReservation, authHttpReservation].filter(Boolean)
        const attemptChildren = []
        const ports = Object.fromEntries(Object.entries(ownerReservations).map(([owner, reservation]) => [owner, reservation.port]))
        const issuerPort = issuerReservation.port
        const authHttpPort = authHttpReservation?.port || null
        try {
          const environments = Object.fromEntries(manifest.owners.map((owner) => {
            const providerEnvironment = environmentForOwner(manifest, owner, resolveCredentialReference)
            const trustedEnvironment = trustedProcessEnvironment({ root, manifest, owner, issuerPort, selectorPath })
            return [owner, {
              ...cleanProcessEnvironment(),
              ...providerEnvironment,
              ...downstreamEnvironment(owner, ports, declarations),
              ...trustedEnvironment,
              MODULE_NAME: owner,
              GRPC_LISTEN_HOST: '127.0.0.1',
              GRPC_LISTEN_PORT: String(ports[owner]),
              SERVICE_REGISTRY_IP: '127.0.0.1',
              SERVICE_REGISTRY_PORT: String(ports[owner]),
              ...(owner === 'api-gateway' ? { SERVICE_PORT: String(ports[owner]), ...gatewayReadinessEnvironment(ports, declarations) } : {}),
              ...(owner === 'auth-service' ? { AUTH_HTTP_PORT: String(authHttpPort), ...signer.environment } : {})
            }]
          }))
          auditDevelopmentProcessEnvironments(environments, declarations)
          if (authHttpPort) {
            const authEnvironment = environmentForOwner(manifest, 'auth-service', resolveCredentialReference)
            await issuerReservation.release()
            await authHttpReservation.release()
            const child = spawn(process.execPath, [path.join(root, 'scripts/local-runtime/src/issuer-server.mjs')], { cwd: root, env: { ...cleanProcessEnvironment(), OES_ISSUER_PORT: String(issuerPort), OES_AUTH_HTTP_PORT: String(authHttpPort), OES_ISSUER_CERT_PATH: authEnvironment.OES_GRPC_TLS_CERT_PATH, OES_ISSUER_KEY_PATH: authEnvironment.OES_GRPC_TLS_KEY_PATH }, stdio: 'inherit' })
            attemptChildren.push({ owner: 'local-issuer', kind: 'support', port: issuerPort, child })
            await waitForProcess(child, 'local-issuer', issuerPort, 180000, signal)
          } else {
            await issuerReservation.release()
          }
          for (const owner of manifest.owners) {
            await ownerReservations[owner].release()
            const child = spawn('pnpm', ['--filter', owner, 'dev'], { cwd: root, env: environments[owner], stdio: 'inherit' })
            attemptChildren.push({ owner, kind: 'service', port: ports[owner], child })
          }
          await Promise.all(attemptChildren.filter(({ kind }) => kind === 'service').map(({ child, owner, port }) => waitForProcess(child, owner, port, 180000, signal)))
          return { attemptChildren, ports, issuerPort, authHttpPort, attempt }
        } catch (error) {
          lastError = error
          await Promise.allSettled(reservations.map((reservation) => reservation.release()))
          await stopDevelopmentProcesses(attemptChildren)
          if (attempt === 3 || !/DEV_PROCESS_EXITED/u.test(String(error?.message || error))) throw error
        }
      }
      throw lastError
    }, { timeoutMs: 600000 })
    children.push(...started.attemptChildren)
    const processEndpoints = started.attemptChildren.filter(({ kind }) => kind === 'service').map(({ owner, port, child }) => ({ provider: 'host-process', authority: `pid:${child.pid}:tcp:${port}`, host: `${owner}.localhost`, port, ready: true, owners: manifest.owners.filter((candidate) => candidate === owner || declarations.owners[candidate].downstreams?.includes(owner)), environment: endpointEnvironment(owner, port), credentialReference: null }))
    const issuerEndpoints = started.authHttpPort ? [{ provider: 'host-issuer', authority: `pid:${started.attemptChildren.find(({ owner }) => owner === 'local-issuer').child.pid}:https:${started.issuerPort}`, host: 'issuer.local.oes.internal', port: started.issuerPort, ready: true, owners: manifest.owners, environment: { AUTH_EXECUTION_ISSUER: `https://issuer.local.oes.internal:${started.issuerPort}` }, credentialReference: null }] : []
    const published = publishDevelopmentProcessManifest(manifestPath, { signer, issuerEndpoints, processEndpoints })
    return { children, manifest: published.manifest, manifestPath: published.file }
  } catch (error) {
    await stopDevelopmentProcesses(children)
    if (signer) {
      for (const resource of [...signer.resources].reverse()) {
        const result = resource.kind === 'directory' ? cleanupRuntimeDirectory(resource) : cleanupDockerResource(resource, manifest)
        if (result.exitStatus !== 0) error.cleanupFailure = result.reason
      }
    }
    throw error
  }
}

/** Stops every selected host process child-first with a bounded force fallback. */
export async function stopDevelopmentProcesses(children) {
  for (const { child } of [...children].reverse()) if (child.exitCode === null) child.kill('SIGTERM')
  await Promise.all(children.map(({ child }) => new Promise((resolvePromise) => {
    if (child.exitCode !== null) return resolvePromise()
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 5000)
    child.once('exit', () => { clearTimeout(timer); resolvePromise() })
  })))
}
