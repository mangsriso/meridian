/**
 * Real rate limit usage from Anthropic OAuth API — background poller.
 *
 * Architecture:
 *   1. OMC cache file (if < 15min old) → use directly, no API call
 *   2. In-memory cache (if < 5min old) → use directly
 *   3. Background poll from Anthropic API → updates cache silently
 *   4. Self-tracked token estimates → always-available fallback (in pool.ts)
 *
 * CRITICAL: /pool/status NEVER calls the API — it only reads cache.
 * Background poller runs every 5 minutes to avoid rate limiting.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import https from "node:https"

export interface RealUsage {
  fiveHourPercent: number
  weeklyPercent: number
  fiveHourResetsAt?: string
  weeklyResetsAt?: string
  fetchedAt: number
  source: "anthropic-api" | "omc-cache" | "stale"
}

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
  }
}

// ── Cache ────────────────────────────────────────────────────────────

const OMC_CACHE_MAX_AGE_MS = 2 * 60 * 60_000  // OMC cache valid for 2 hours (stale data >> no data)
const POLL_INTERVAL_MS = 5 * 60_000         // Background poll every 5 min
const API_TIMEOUT_MS = 10_000

const cache = new Map<string, RealUsage>()
let pollerInterval: ReturnType<typeof setInterval> | null = null
let registeredProfiles: Array<{ id: string; configDir: string }> = []

// ── OMC Cache Reader ─────────────────────────────────────────────────

function readOmcCache(configDir: string): RealUsage | null {
  const cachePath = join(configDir, "plugins", "oh-my-claudecode", ".usage-cache.json")
  if (!existsSync(cachePath)) return null
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"))
    if (raw.error || !raw.data) return null
    const age = Date.now() - (raw.timestamp ?? 0)
    if (age > OMC_CACHE_MAX_AGE_MS) return null  // too stale
    return {
      fiveHourPercent: raw.data.fiveHourPercent ?? -1,
      weeklyPercent: raw.data.weeklyPercent ?? -1,
      fiveHourResetsAt: raw.data.fiveHourResetsAt,
      weeklyResetsAt: raw.data.weeklyResetsAt,
      fetchedAt: raw.timestamp ?? Date.now(),
      source: "omc-cache",
    }
  } catch {
    return null
  }
}

// ── Credentials Reader ───────────────────────────────────────────────

function readCredentials(configDir: string): { accessToken: string; refreshToken?: string; expired: boolean } | null {
  const credsPath = join(configDir, ".credentials.json")
  if (!existsSync(credsPath)) return null
  try {
    const raw = JSON.parse(readFileSync(credsPath, "utf-8")) as CredentialsFile
    const oauth = raw.claudeAiOauth
    if (!oauth?.accessToken) return null
    const expired = oauth.expiresAt != null && oauth.expiresAt <= Date.now()
    return { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expired }
  } catch {
    return null
  }
}

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

interface RefreshResult {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
}

/**
 * Refresh an access token. Returns new tokens.
 * CRITICAL: Refresh tokens are single-use — must persist the new
 * refresh_token from the response or subsequent refreshes will fail.
 */
function refreshAccessToken(refreshToken: string): Promise<RefreshResult | null> {
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }).toString()
    const req = https.request({
      hostname: "platform.claude.com",
      path: "/v1/oauth/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
      timeout: API_TIMEOUT_MS,
    }, (res) => {
      let data = ""
      res.on("data", (chunk: Buffer) => { data += chunk.toString() })
      res.on("end", () => {
        if (res.statusCode !== 200) { resolve(null); return }
        try {
          const parsed = JSON.parse(data)
          if (!parsed.access_token) { resolve(null); return }
          resolve({
            accessToken: parsed.access_token,
            refreshToken: parsed.refresh_token,
            expiresIn: parsed.expires_in,
          })
        } catch { resolve(null) }
      })
    })
    req.on("error", () => resolve(null))
    req.on("timeout", () => { req.destroy(); resolve(null) })
    req.write(body)
    req.end()
  })
}

/** Write refreshed tokens back to credentials file so next refresh works */
function persistRefreshedTokens(configDir: string, result: RefreshResult): void {
  const credsPath = join(configDir, ".credentials.json")
  try {
    const raw = JSON.parse(readFileSync(credsPath, "utf-8"))
    const oauth = raw.claudeAiOauth || raw
    oauth.accessToken = result.accessToken
    if (result.refreshToken) oauth.refreshToken = result.refreshToken
    if (result.expiresIn) oauth.expiresAt = Date.now() + result.expiresIn * 1000
    writeFileSync(credsPath, JSON.stringify(raw, null, 2))
  } catch { /* best effort */ }
}

// ── Anthropic API Fetch ──────────────────────────────────────────────

function fetchUsageFromApi(accessToken: string): Promise<RealUsage | null> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/api/oauth/usage",
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      timeout: API_TIMEOUT_MS,
    }, (res) => {
      let body = ""
      res.on("data", (chunk: Buffer) => { body += chunk.toString() })
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(null)  // rate limited or error — don't overwrite cache
          return
        }
        try {
          const data = JSON.parse(body)
          // Anthropic returns utilization as percent (e.g. 72.0 = 72%)
          // NOT as ratio (0.72) — don't multiply by 100
          const fh = data.five_hour?.utilization ?? 0
          const sd = data.seven_day?.utilization ?? 0
          resolve({
            fiveHourPercent: Math.round(fh),
            weeklyPercent: Math.round(sd),
            fiveHourResetsAt: data.five_hour?.resets_at,
            weeklyResetsAt: data.seven_day?.resets_at,
            fetchedAt: Date.now(),
            source: "anthropic-api",
          })
        } catch {
          resolve(null)
        }
      })
    })
    req.on("error", () => resolve(null))
    req.on("timeout", () => { req.destroy(); resolve(null) })
    req.end()
  })
}

// ── Meridian Disk Cache ──────────────────────────────────────────────
// Persists API results to disk so data survives restarts.
// Especially important for profiles without OMC (e.g. work profile).

const MERIDIAN_CACHE_DIR = join(homedir(), ".config", "meridian", "usage-cache")

function writeMeridianCache(profileId: string, data: RealUsage): void {
  try {
    mkdirSync(MERIDIAN_CACHE_DIR, { recursive: true })
    writeFileSync(
      join(MERIDIAN_CACHE_DIR, `${profileId}.json`),
      JSON.stringify(data, null, 2)
    )
  } catch { /* best effort */ }
}

function readMeridianCache(profileId: string): RealUsage | null {
  const cachePath = join(MERIDIAN_CACHE_DIR, `${profileId}.json`)
  if (!existsSync(cachePath)) return null
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf-8")) as RealUsage
    if (Date.now() - data.fetchedAt > OMC_CACHE_MAX_AGE_MS) return null
    return data
  } catch {
    return null
  }
}

// ── Background Poller ────────────────────────────────────────────────

async function pollProfile(profileId: string, configDir: string): Promise<void> {
  // Priority 1: OMC cache (free, no API call — maintained by OMC plugin)
  const omcData = readOmcCache(configDir)
  if (omcData) {
    cache.set(profileId, omcData)
    return
  }

  // Priority 2: Meridian's own disk cache (survives restarts)
  const diskData = readMeridianCache(profileId)
  if (diskData) {
    cache.set(profileId, diskData)
    // Don't return — still try API to get fresher data
  }

  // Priority 3: Anthropic API
  // Rate limit is per-access-token (~5 req/token, never resets).
  // Fix: if 429 → refresh token → get NEW token → retry with fresh limit.
  const creds = readCredentials(configDir)
  if (!creds) return

  // Try with current token first (unless expired)
  let token = creds.accessToken
  if (creds.expired && creds.refreshToken) {
    const result = await refreshAccessToken(creds.refreshToken)
    if (result) {
      token = result.accessToken
      persistRefreshedTokens(configDir, result)
      console.error(`[POOL] Refreshed expired token for "${profileId}"`)
    }
  }

  let apiData = await fetchUsageFromApi(token)

  // 429 = token rate limited → refresh to get NEW token with fresh limit
  // Refresh tokens are single-use: must persist new tokens to disk
  if (!apiData && creds.refreshToken) {
    console.error(`[POOL] "${profileId}" API failed — refreshing token for fresh rate limit window`)
    const result = await refreshAccessToken(creds.refreshToken)
    if (result) {
      persistRefreshedTokens(configDir, result)
      apiData = await fetchUsageFromApi(result.accessToken)
    }
  }

  if (apiData) {
    cache.set(profileId, apiData)
    writeMeridianCache(profileId, apiData)
    console.error(`[POOL] Fetched real usage for "${profileId}": 5h=${apiData.fiveHourPercent}% 7d=${apiData.weeklyPercent}%`)
  }
  // If API failed, keep existing in-memory cache (from disk or prior API success)
}

async function pollAllProfiles(): Promise<void> {
  for (const p of registeredProfiles) {
    await pollProfile(p.id, p.configDir)  // sequential to avoid burst
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Register profiles and start background polling.
 * Called once at server startup.
 */
export function startUsagePoller(profiles: Array<{ id: string; configDir?: string }>): void {
  registeredProfiles = profiles.map(p => ({
    id: p.id,
    configDir: p.configDir || join(homedir(), ".claude"),
  }))

  // Initial poll immediately
  pollAllProfiles().catch(() => {})

  // Then every 5 minutes
  if (pollerInterval) clearInterval(pollerInterval)
  pollerInterval = setInterval(() => {
    pollAllProfiles().catch(() => {})
  }, POLL_INTERVAL_MS)
}

/**
 * Get cached real usage for a profile.
 * NEVER calls API — returns whatever is in cache (may be null).
 */
export function getCachedUsage(profileId: string): RealUsage | null {
  return cache.get(profileId) ?? null
}

/**
 * Get cached real usage for all registered profiles.
 */
export function getAllCachedUsage(): Map<string, RealUsage> {
  return new Map(cache)
}

/** Stop the background poller — for testing */
export function stopUsagePoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval)
    pollerInterval = null
  }
  cache.clear()
  registeredProfiles = []
}
