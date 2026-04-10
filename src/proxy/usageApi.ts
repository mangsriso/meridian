/**
 * Fetch real rate limit usage from Anthropic OAuth API per profile.
 *
 * Reads OAuth credentials from each profile's CLAUDE_CONFIG_DIR,
 * calls api.anthropic.com/api/oauth/usage, and caches results.
 *
 * Based on OMC (oh-my-claudecode) usage-api.js pattern.
 */

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import https from "node:https"

export interface RealUsage {
  fiveHourPercent: number
  weeklyPercent: number
  fiveHourResetsAt?: string
  weeklyResetsAt?: string
  fetchedAt: number
  error?: string
}

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
  }
}

// Cache per profile — poll every 60s, stale after 5min
const CACHE_TTL_MS = 60_000
const STALE_MS = 5 * 60_000
const cache = new Map<string, { data: RealUsage; fetchedAt: number }>()

/** Read OAuth credentials from a profile's config directory */
function readCredentials(configDir: string): { accessToken: string; refreshToken?: string } | null {
  const credsPath = join(configDir, ".credentials.json")
  if (!existsSync(credsPath)) return null
  try {
    const raw = JSON.parse(readFileSync(credsPath, "utf-8")) as CredentialsFile
    const oauth = raw.claudeAiOauth
    if (!oauth?.accessToken) return null
    return { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken }
  } catch {
    return null
  }
}

/** Fetch usage from Anthropic API */
function fetchUsage(accessToken: string): Promise<RealUsage> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/api/oauth/usage",
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      timeout: 10_000,
    }, (res) => {
      let body = ""
      res.on("data", (chunk: Buffer) => { body += chunk.toString() })
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            resolve({ fiveHourPercent: -1, weeklyPercent: -1, fetchedAt: Date.now(), error: `HTTP ${res.statusCode}` })
            return
          }
          const data = JSON.parse(body)
          // Anthropic returns: { five_hour: { utilization: 0.02 }, seven_day: { utilization: 0.67 } }
          const fh = data.five_hour?.utilization ?? 0
          const sd = data.seven_day?.utilization ?? 0
          resolve({
            fiveHourPercent: Math.round(fh * 100),
            weeklyPercent: Math.round(sd * 100),
            fiveHourResetsAt: data.five_hour?.resets_at,
            weeklyResetsAt: data.seven_day?.resets_at,
            fetchedAt: Date.now(),
          })
        } catch {
          resolve({ fiveHourPercent: -1, weeklyPercent: -1, fetchedAt: Date.now(), error: "parse error" })
        }
      })
    })
    req.on("error", (err) => {
      resolve({ fiveHourPercent: -1, weeklyPercent: -1, fetchedAt: Date.now(), error: err.message })
    })
    req.on("timeout", () => {
      req.destroy()
      resolve({ fiveHourPercent: -1, weeklyPercent: -1, fetchedAt: Date.now(), error: "timeout" })
    })
    req.end()
  })
}

/**
 * Get real usage for a profile. Cached with 60s TTL.
 * Returns null if no credentials found or configDir not set.
 */
/**
 * Read OMC usage cache file as fallback when API call fails.
 * OMC writes to {configDir}/plugins/oh-my-claudecode/.usage-cache.json
 */
function readOmcCache(configDir: string): RealUsage | null {
  const cachePath = join(configDir, "plugins", "oh-my-claudecode", ".usage-cache.json")
  if (!existsSync(cachePath)) return null
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"))
    if (raw.error || !raw.data) return null
    return {
      fiveHourPercent: raw.data.fiveHourPercent ?? -1,
      weeklyPercent: raw.data.weeklyPercent ?? -1,
      fiveHourResetsAt: raw.data.fiveHourResetsAt,
      weeklyResetsAt: raw.data.weeklyResetsAt,
      fetchedAt: raw.timestamp ?? Date.now(),
    }
  } catch {
    return null
  }
}

export async function getRealUsage(profileId: string, configDir?: string): Promise<RealUsage | null> {
  const dir = configDir || join(homedir(), ".claude")

  // Check cache
  const cached = cache.get(profileId)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data
  }

  // Read credentials
  const creds = readCredentials(dir)
  if (!creds) {
    // No credentials — try OMC cache as last resort
    return readOmcCache(dir)
  }

  // Fetch from Anthropic API
  const usage = await fetchUsage(creds.accessToken)

  // Cache successful results
  if (!usage.error) {
    cache.set(profileId, { data: usage, fetchedAt: Date.now() })
    return usage
  }

  // API failed — try stale in-memory cache
  if (cached && Date.now() - cached.fetchedAt < STALE_MS) {
    return cached.data
  }

  // Last resort — read OMC cache file
  const omcData = readOmcCache(dir)
  if (omcData) {
    cache.set(profileId, { data: omcData, fetchedAt: omcData.fetchedAt })
    return omcData
  }

  return usage
}

/**
 * Get real usage for all profiles at once.
 * Returns map of profileId → RealUsage.
 */
export async function getAllProfileUsage(
  profiles: Array<{ id: string; configDir?: string }>
): Promise<Map<string, RealUsage>> {
  const results = new Map<string, RealUsage>()
  await Promise.all(profiles.map(async (p) => {
    const usage = await getRealUsage(p.id, p.configDir)
    if (usage) results.set(p.id, usage)
  }))
  return results
}
