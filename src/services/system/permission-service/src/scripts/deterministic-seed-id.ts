import { createHash } from 'node:crypto'

/** Converts a domain-separated seed coordinate into a stable RFC-4122-shaped identifier. */
export function deterministicSeedId(sourceCoordinate: string): string {
  const source = createHash('sha256').update(sourceCoordinate).digest('hex').slice(0, 32)
  const versioned = `${source.slice(0, 12)}5${source.slice(13)}`
  const variant = ((Number.parseInt(versioned[16], 16) & 0x3) | 0x8).toString(16)
  const normalized = `${versioned.slice(0, 16)}${variant}${versioned.slice(17)}`
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20)
  ].join('-')
}
