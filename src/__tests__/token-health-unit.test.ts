import { describe, expect, it } from "bun:test"
import { detectTokenAnomalies, type TokenSnapshot, type TokenAnomaly } from "../proxy/tokenHealth"

function makeSnapshot(overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    requestId: "req-001",
    turnNumber: 2,
    inputTokens: 5000,
    outputTokens: 500,
    cacheReadInputTokens: 4000,
    cacheCreationInputTokens: 200,
    cacheHitRate: 0.8,
    isResume: true,
    isPassthrough: false,
    ...overrides,
  }
}

describe("detectTokenAnomalies", () => {
  it("returns empty array when no anomalies", () => {
    const prev = makeSnapshot({ turnNumber: 1, inputTokens: 4500 })
    const curr = makeSnapshot({ turnNumber: 2, inputTokens: 5000 })
    expect(detectTokenAnomalies(curr, prev)).toEqual([])
  })

  it("detects context spike (>60% input growth)", () => {
    const prev = makeSnapshot({ turnNumber: 1, inputTokens: 5000 })
    const curr = makeSnapshot({ turnNumber: 2, inputTokens: 11000 })
    const anomalies = detectTokenAnomalies(curr, prev)
    expect(anomalies.length).toBeGreaterThanOrEqual(1)
    expect(anomalies.some(a => a.type === "context_spike")).toBe(true)
  })

  it("detects cache miss on resume", () => {
    const prev = makeSnapshot({ turnNumber: 1, cacheHitRate: 0.85 })
    const curr = makeSnapshot({
      turnNumber: 2,
      cacheReadInputTokens: 0,
      cacheHitRate: 0,
      isResume: true,
    })
    const anomalies = detectTokenAnomalies(curr, prev)
    expect(anomalies.some(a => a.type === "cache_miss")).toBe(true)
  })

  it("does not flag cache miss on first request (not resume)", () => {
    const curr = makeSnapshot({
      turnNumber: 1,
      cacheReadInputTokens: 0,
      cacheHitRate: 0,
      isResume: false,
    })
    const anomalies = detectTokenAnomalies(curr, undefined)
    expect(anomalies.some(a => a.type === "cache_miss")).toBe(false)
  })

  it("detects sustained high growth rate", () => {
    const prev = makeSnapshot({ turnNumber: 5, inputTokens: 10000 })
    const curr = makeSnapshot({ turnNumber: 6, inputTokens: 17000 })
    const anomalies = detectTokenAnomalies(curr, prev)
    expect(anomalies.some(a => a.type === "context_spike")).toBe(true)
  })

  it("works with no previous snapshot (first turn)", () => {
    const curr = makeSnapshot({ turnNumber: 1 })
    const anomalies = detectTokenAnomalies(curr, undefined)
    expect(anomalies).toEqual([])
  })

  it("includes human-readable detail in each anomaly", () => {
    const prev = makeSnapshot({ turnNumber: 1, inputTokens: 5000, cacheHitRate: 0.9 })
    const curr = makeSnapshot({
      turnNumber: 2, inputTokens: 11000,
      cacheReadInputTokens: 0, cacheHitRate: 0, isResume: true,
    })
    const anomalies = detectTokenAnomalies(curr, prev)
    for (const a of anomalies) {
      expect(a.detail.length).toBeGreaterThan(10)
      expect(a.severity).toMatch(/^(warn|critical)$/)
    }
  })
})
