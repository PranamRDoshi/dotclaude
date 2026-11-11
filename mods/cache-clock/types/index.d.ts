/**
 * State contract for the cache-clock mod: what it keeps in $.state so a hot
 * reload keeps the clock, plus the usage split it reads when the runtime has it.
 */

/**
 * The per-TTL cache-write split the Messages API reports. Not part of the
 * engine's TurnUsage/ModelUsage contract (four counts only), so it is read
 * defensively and may be absent at run time.
 */
export type CacheClockUsageSplit = {
  cache_creation?: {
    ephemeral_1h_input_tokens?: number
    ephemeral_5m_input_tokens?: number
  } | null
}

declare module 'claude-code' {
  interface PluginState {
    'cache-clock': {
      /** Epoch ms of the last main-thread response (or kept-warm fork) that touched the cache. */
      lastAt: number | null
      /** TTL of the cached prefix in ms; null until one is known. */
      ttlMs: number | null
      /** True while a Keep warm fork is in flight. */
      isWarming: boolean
    }
  }
}
