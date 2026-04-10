/**
 * Profile pool with health-based auto-rotation.
 *
 * When a profile hits a rate limit, its health score drops and the pool
 * selects the next healthy profile automatically. Scores recover passively
 * over time so temporarily degraded profiles rejoin the rotation.
 *
 * Algorithm based on opencode-antigravity-auth patterns:
 *   Health Score (0-100) + LRU tie-breaking + jitter
 *
 * This is a leaf module — no imports from server.ts or session/.
 */

export interface ProfileHealth {
  profileId: string
  score: number          // 0-100, starts at 70
  lastUsed: number       // timestamp ms
  cooldownUntil: number  // timestamp ms — skip until this time
  lastRecovery: number   // timestamp ms — last passive recovery tick
}

const MIN_VIABLE_SCORE = 30
const INITIAL_SCORE = 70
const MAX_SCORE = 100

// Score adjustments
const SUCCESS_BONUS = 1
const RATE_LIMIT_PENALTY = -15
const FAILURE_PENALTY = -20

// Passive recovery: +2 points per hour
const RECOVERY_INTERVAL_MS = 30 * 60 * 1000  // check every 30min
const RECOVERY_POINTS = 1

// Cooldown durations
const RATE_LIMIT_COOLDOWN_MS = 2 * 60 * 1000  // 2 min cooldown after rate limit

const healthMap = new Map<string, ProfileHealth>()

function getOrCreate(profileId: string): ProfileHealth {
  let h = healthMap.get(profileId)
  if (!h) {
    h = {
      profileId,
      score: INITIAL_SCORE,
      lastUsed: 0,
      cooldownUntil: 0,
      lastRecovery: Date.now(),
    }
    healthMap.set(profileId, h)
  }
  return h
}

/** Apply passive recovery to all profiles */
function tickRecovery(): void {
  const now = Date.now()
  for (const h of healthMap.values()) {
    if (now - h.lastRecovery >= RECOVERY_INTERVAL_MS && h.score < MAX_SCORE) {
      h.score = Math.min(MAX_SCORE, h.score + RECOVERY_POINTS)
      h.lastRecovery = now
    }
  }
}

/**
 * Select the best profile from a list of profile IDs.
 * Returns the profileId with highest score that isn't in cooldown.
 * Falls back to the first profile if all are exhausted.
 */
export function selectProfile(profileIds: string[]): string {
  if (profileIds.length === 0) return "default"
  if (profileIds.length === 1) return profileIds[0]!

  tickRecovery()

  const now = Date.now()
  let best: ProfileHealth | null = null
  let bestScore = -Infinity

  for (const id of profileIds) {
    const h = getOrCreate(id)

    // Skip profiles in cooldown
    if (h.cooldownUntil > now) continue

    // Skip profiles below minimum viable score
    if (h.score < MIN_VIABLE_SCORE) continue

    // Score = health + LRU bonus (older = better) + jitter
    const lruBonus = (now - h.lastUsed) / 60000  // +1 per minute since last use
    const jitter = Math.random() * 3
    const effectiveScore = h.score + lruBonus + jitter

    if (effectiveScore > bestScore) {
      bestScore = effectiveScore
      best = h
    }
  }

  // All profiles exhausted — return the one with shortest remaining cooldown
  if (!best) {
    let shortest: ProfileHealth | null = null
    let shortestWait = Infinity
    for (const id of profileIds) {
      const h = getOrCreate(id)
      const wait = h.cooldownUntil - now
      if (wait < shortestWait) {
        shortestWait = wait
        shortest = h
      }
    }
    best = shortest ?? getOrCreate(profileIds[0]!)
  }

  best.lastUsed = now
  return best.profileId
}

/** Record a successful request for a profile */
export function recordSuccess(profileId: string): void {
  const h = getOrCreate(profileId)
  h.score = Math.min(MAX_SCORE, h.score + SUCCESS_BONUS)
}

/** Record a rate limit hit — drops score and sets cooldown */
export function recordRateLimit(profileId: string): void {
  const h = getOrCreate(profileId)
  h.score = Math.max(0, h.score + RATE_LIMIT_PENALTY)
  h.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
  console.error(`[POOL] Profile "${profileId}" rate-limited — score=${h.score}, cooldown=${RATE_LIMIT_COOLDOWN_MS / 1000}s`)
}

/** Record a general failure */
export function recordFailure(profileId: string): void {
  const h = getOrCreate(profileId)
  h.score = Math.max(0, h.score + FAILURE_PENALTY)
}

/** Get health status for all known profiles (for telemetry/debugging) */
export function getPoolStatus(): Array<ProfileHealth & { available: boolean }> {
  tickRecovery()
  const now = Date.now()
  return Array.from(healthMap.values()).map(h => ({
    ...h,
    available: h.score >= MIN_VIABLE_SCORE && h.cooldownUntil <= now,
  }))
}

// ── Session Stickiness ──────────────────────────────────────────────
// Once a conversation starts on a profile, subsequent requests in the
// same session MUST use the same profile to preserve session resume
// and prompt cache affinity.

const sessionProfileMap = new Map<string, string>()
const SESSION_STICKY_TTL_MS = 6 * 60 * 60 * 1000  // 6 hours (covers Claude's 5hr session TTL)
const sessionExpiryMap = new Map<string, number>()

/**
 * Look up which profile a session is sticky to.
 * Returns undefined if the session has no affinity yet, or if the
 * sticky profile is currently in cooldown (break stickiness to avoid
 * sending requests to a rate-limited profile repeatedly).
 */
export function getSessionProfile(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  const profileId = sessionProfileMap.get(sessionId)
  if (!profileId) return undefined
  const expiry = sessionExpiryMap.get(sessionId) ?? 0
  if (Date.now() > expiry) {
    sessionProfileMap.delete(sessionId)
    sessionExpiryMap.delete(sessionId)
    return undefined
  }
  // Break stickiness if the profile is in cooldown — better to start
  // a fresh session on a healthy profile than fail repeatedly on a
  // rate-limited one. The session will be re-bound to the new profile.
  const health = healthMap.get(profileId)
  if (health && health.cooldownUntil > Date.now()) {
    console.error(`[POOL] Breaking session stickiness for "${profileId}" (in cooldown) — will select new profile`)
    sessionProfileMap.delete(sessionId)
    sessionExpiryMap.delete(sessionId)
    return undefined
  }
  return profileId
}

/**
 * Bind a session to a profile. Called after the first request in a conversation.
 */
export function bindSessionProfile(sessionId: string | undefined, profileId: string): void {
  if (!sessionId) return
  sessionProfileMap.set(sessionId, profileId)
  sessionExpiryMap.set(sessionId, Date.now() + SESSION_STICKY_TTL_MS)
  // Lazy cleanup: prune expired entries when map grows large
  if (sessionProfileMap.size > 10000) {
    const now = Date.now()
    for (const [key, expiry] of sessionExpiryMap.entries()) {
      if (now > expiry) {
        sessionProfileMap.delete(key)
        sessionExpiryMap.delete(key)
      }
    }
  }
}

/** Reset all health state — for testing */
export function resetPool(): void {
  healthMap.clear()
  sessionProfileMap.clear()
  sessionExpiryMap.clear()
}
