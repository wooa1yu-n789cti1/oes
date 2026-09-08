import { canonicalJson } from './canonical.mjs'

const SHARED_RESOURCE_IDENTITIES = {
  container: 'name',
  network: 'name',
  volume: 'name',
  image: 'name',
  database: 'database',
  bucket: 'bucket',
  'acl-user': 'user',
  certificate: 'owner',
  'simulated-provider': 'name',
  'simulated-logical': 'owner'
}

/** Produces the single collision-free Stack identity for every supported shared resource kind. */
export function sharedResourceIdentity(resource) {
  const field = SHARED_RESOURCE_IDENTITIES[resource.kind]
  const pool = resource.pool || resource.labels?.['oes.runtime.pool']
  if (resource.scope !== 'SHARED' || !resource.provider || !pool || !field || typeof resource[field] !== 'string' || !resource[field]) throw new Error(`STACK_SHARED_RESOURCE_IDENTITY_INVALID provider=${resource.provider || 'UNKNOWN'} kind=${resource.kind || 'UNKNOWN'}`)
  return canonicalJson([resource.provider, pool, resource.kind, field, resource[field]])
}
