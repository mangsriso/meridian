import { env, envInt } from "../env"
import { MemoryTelemetryStore } from "./store"
import { MemoryDiagnosticLogStore } from "./logStore"
import type { ITelemetryStore, IDiagnosticLogStore } from "./types"

function createStores(): { telemetry: ITelemetryStore; diagnostics: IDiagnosticLogStore } {
  if (env("TELEMETRY_PERSIST") === "false") {
    return {
      telemetry: new MemoryTelemetryStore(),
      diagnostics: new MemoryDiagnosticLogStore(),
    }
  }

  try {
    const { createSqliteStores } = require("./sqlite") as typeof import("./sqlite")
    const dbPath = env("TELEMETRY_DB") ?? "/home/claude/.claude/telemetry.db"
    const retention = envInt("TELEMETRY_RETENTION_DAYS", 7)
    const stores = createSqliteStores(dbPath, retention)
    return { telemetry: stores.telemetry, diagnostics: stores.diagnostics }
  } catch {
    console.warn("[telemetry] SQLite unavailable, using in-memory store")
    return {
      telemetry: new MemoryTelemetryStore(),
      diagnostics: new MemoryDiagnosticLogStore(),
    }
  }
}

const stores = createStores()

export const telemetryStore: ITelemetryStore = stores.telemetry
export const diagnosticLog: IDiagnosticLogStore = stores.diagnostics

export { MemoryTelemetryStore } from "./store"
export { MemoryDiagnosticLogStore } from "./logStore"
export { createTelemetryRoutes } from "./routes"
export { landingHtml } from "./landing"
export { computePercentiles, computeSummary } from "./percentiles"
export { renderPrometheusMetrics } from "./prometheus"
export { createSqliteStores } from "./sqlite"
export type {
  RequestMetric,
  TelemetrySummary,
  PhaseTiming,
  ITelemetryStore,
  IDiagnosticLogStore,
  DiagnosticLog,
} from "./types"
