/**
 * Real rate limit usage from Anthropic OAuth API — background poller.
 *
 * Architecture:
 *   1. OMC cache file (if < 2hr old) → use directly, no API call
 *   2. Meridian disk cache (if < 2hr old) → use directly
 *   3. Background poll from Anthropic API → updates disk + memory cache
 *   4. Self-tracked token estimates → always-available fallback (in pool.ts)
 *
 * CRITICAL: /pool/status NEVER calls the API — it only reads cache.
 * CRITICAL: NEVER write to .credentials.json — read-only on auth files.
 *           Token refresh is managed by Claude Code CLI (claude login).
 *           Writing to credentials caused account cross-contamination bug.
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
    expiresAt?: number
  }
}

// ── Cache ────────────────────────────────────────────────────────────

const OMC_CACHE_MAX_AGE_MS = 2 * 60 * 60_000  // 2 hours
const POLL_INTERVAL_MS = 5 * 60_000             // 5 min
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
    if (age > OMC_CACHE_MAX_AGE_MS) return null
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

// ── Credentials Reader (READ-ONLY) ──────────────────────────────────

function readAccessToken(configDir: string): string | null {
  const credsPath = join(configDir, ".credentials.json")
  if (!existsSync(credsPath)) return null
  try {
    const raw = JSON.parse(readFileSync(credsPath, "utf-8")) as CredentialsFile
    const oauth = raw.claudeAiOauth
    if (!oauth?.accessToken) return null
    // Skip expired tokens — user needs to run `claude login`
    if (oauth.expiresAt != null && oauth.expiresAt <= Date.now()) {
      console.error(`[POOL] Token expired for config dir ${configDir} — run 'claude login' to refresh`)
      return null
    }
    return oauth.accessToken
  } catch {
    return null
  }
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
          resolve(null)
          return
        }
        try {
          const data = JSON.parse(body)
          // Anthropic returns utilization as percent (72.0 = 72%)
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
  // Priority 1: OMC cache (free, no API call)
  const omcData = readOmcCache(configDir)
  if (omcData) {
    cache.set(profileId, omcData)
    return
  }

  // Priority 2: Meridian disk cache (survives restarts)
  const diskData = readMeridianCache(profileId)
  if (diskData) {
    cache.set(profileId, diskData)
    // Don't return — still try API for fresher data
  }

  // Priority 3: Anthropic API (read-only — never modify credentials)
  const token = readAccessToken(configDir)
  if (!token) return  // expired or missing — user needs `claude login`

  const apiData = await fetchUsageFromApi(token)
  if (apiData) {
    cache.set(profileId, apiData)
    writeMeridianCache(profileId, apiData)
    console.error(`[POOL] Fetched real usage for "${profileId}": 5h=${apiData.fiveHourPercent}% 7d=${apiData.weeklyPercent}%`)
  }
  // If API failed (429/401), keep existing cache
}

async function pollAllProfiles(): Promise<void> {
  for (const p of registeredProfiles) {
    await pollProfile(p.id, p.configDir)
  }
}

// ── Public API ───────────────────────────────────────────────────────

export function startUsagePoller(profiles: Array<{ id: string; configDir?: string }>): void {
  registeredProfiles = profiles.map(p => ({
    id: p.id,
    configDir: p.configDir || join(homedir(), ".claude"),
  }))
  pollAllProfiles().catch(() => {})
  if (pollerInterval) clearInterval(pollerInterval)
  pollerInterval = setInterval(() => {
    pollAllProfiles().catch(() => {})
  }, POLL_INTERVAL_MS)
}

export function getCachedUsage(profileId: string): RealUsage | null {
  return cache.get(profileId) ?? null
}

export function getAllCachedUsage(): Map<string, RealUsage> {
  return new Map(cache)
}

export function stopUsagePoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval)
    pollerInterval = null
  }
  cache.clear()
  registeredProfiles = []
}
