/** Read-only loader for Orca's fixed self profile. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SelfProfileLoader {
  get(): string
  readonly path: string
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const defaultProfilePath = resolve(moduleDir, '../../resources/self-profile.md')

export function createSelfProfileLoader(profilePath = defaultProfilePath): SelfProfileLoader {
  if (!existsSync(profilePath)) {
    throw new Error(`Self Profile resource not found: ${profilePath}`)
  }

  const content = readFileSync(profilePath, 'utf8').trim()
  if (!content) {
    throw new Error(`Self Profile resource is empty: ${profilePath}`)
  }

  return { path: profilePath, get: () => content }
}

// Fail during startup when the required system resource is unavailable.
const defaultLoader = createSelfProfileLoader()

export function getSelfProfile(): string {
  return defaultLoader.get()
}

export function getSelfProfileLoader(): SelfProfileLoader {
  return defaultLoader
}
