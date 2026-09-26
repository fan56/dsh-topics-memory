/**
 * Backend table for the System One integration (design 2026-09-25 §3.1),
 * aligned with dsh-jev-mcp `backends.mjs` (three-endpoint field evidence,
 * zero changes there). Model ids are PINNED versioned ids: aliases
 * (jev-latest & friends) silently move on every vendor release, so routing
 * thresholds and eval numbers stop meaning anything without a deliberate
 * model bump.
 *
 * @module jev/backends
 */

export type JevBackendName = 'zen' | 'native' | 'openrouter'
export type JevFamily = 'systemone' | 'decisions'

export interface JevBackend {
  readonly name: JevBackendName
  /** Wire protocol family: systemone (instructions required, noul criteria
   *  optional, structured score levels allowed) vs decisions (noul criteria
   *  REQUIRED two-sided, score levels strings only). */
  readonly family: JevFamily
  readonly endpoint: string
  readonly defaultModel: string
  readonly keyEnv: string
  readonly keychainService: string
  /** Only zen falls back to its default keychain service when JEV_KEYCHAIN
   *  is unset; native/openrouter expose a service for onboarding but still
   *  require an explicit JEV_KEYCHAIN (dsh-jev-mcp server.mjs parity). */
  readonly keychainByDefault: boolean
}

export const BACKENDS: Readonly<Record<JevBackendName, JevBackend>> = {
  zen: {
    name: 'zen',
    family: 'systemone',
    endpoint: 'https://opencode.ai/zen/v1/systemone',
    defaultModel: 'jev-1.13-free',
    keyEnv: 'JEV_ZEN_API_KEY',
    keychainService: 'opencode-zen-inference',
    keychainByDefault: true,
  },
  native: {
    name: 'native',
    family: 'systemone',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    defaultModel: 'jev-1.13.0',
    keyEnv: 'TYPESAFE_API_KEY',
    keychainService: 'jev-typesafe',
    keychainByDefault: false,
  },
  openrouter: {
    name: 'openrouter',
    family: 'decisions',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    defaultModel: 'typesafe/jev-1.13',
    keyEnv: 'OPENROUTER_API_KEY',
    keychainService: 'openrouter-inference',
    keychainByDefault: false,
  },
}

/** Resolve a config value to a backend; anything but a known name (bare
 *  harnesses, future drift) lands on the config default `zen`. */
export function resolveBackend(name: string | undefined): JevBackend {
  if (name === 'native' || name === 'openrouter') return BACKENDS[name]
  return BACKENDS.zen
}
