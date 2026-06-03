import { createReadStream } from 'node:fs'
import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
} from 'node:fs/promises'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'

const HISTORY_FILE = 'history.jsonl'
const CACHE_TTL_MS = 5_000
const HISTORY_KEEP_DAYS = 14

type SourceKind = 'sessions' | 'archived_sessions'

type ConfidenceLevel = 'high' | 'medium' | 'low'

type DataConfidence = {
  level: ConfidenceLevel
  score: number
  reason: string
}

type ParseFileHealth = {
  file: string
  parsedLines: number
  malformedLines: number
  parseFailures: number
  tokenRecords: number
  usedEvents: number
  fallbackTokenSourceUsed: number
}

type ParseDiagnostics = {
  parsedLines: number
  malformedLines: number
  parseFailures: number
  tokenRecords: number
  usedEvents: number
  ignoredEvents: number
  fallbackTokenSourceUsed: number
  resetEvents: number
  anomalousDeltas: number
  files: ParseFileHealth[]
}

type TokenBucket = {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

type RateWindow = {
  used_percent?: number
  window_minutes?: number
  resets_at?: number
}

type TokenEvent = {
  timestamp: string
  timestampMs: number
  sessionId: string
  source: SourceKind
  totals: TokenBucket
  last: TokenBucket
  totalsSource: 'total' | 'last'
  contextWindow: number | null
  primary: RateWindow | null
  secondary: RateWindow | null
  planType: string | null
}

type UsageEvent = TokenEvent & {
  delta: TokenTotals
}

export type TokenTotals = {
  inputTokens: number
  cachedInputTokens: number
  uncachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type WindowSummary = TokenTotals & {
  activeTokens: number
  eventCount: number
  observedMinutes: number
  coveragePercent: number
  confidence: DataConfidence
}

type HourBucket = {
  hourStart: string
  label: string
  totalTokens: number
  activeTokens: number
  eventCount: number
}

type SessionSummary = TokenTotals & {
  activeTokens: number
  sessionId: string
  eventCount: number
  firstSeen: string
  lastSeen: string
}

type PercentProjection = {
  percentPerHour: number | null
  projectedExhaustAt: string | null
  basisHours: number | null
  confidence: DataConfidence
}

export type GaugeAlert = {
  id: string
  severity: 'info' | 'warning' | 'danger'
  title: string
  detail: string
}

export type HistoryPoint = {
  timestamp: string
  weeklyUsedPercent: number | null
  primaryUsedPercent: number | null
  lastHourTotalTokens: number
  lastHourActiveTokens: number
  lastFiveHourTotalTokens: number
  observedAllTotalTokens: number
  eventCount: number
  sessionCount: number
}

export type UsageSummary = {
  source: {
    codexHome: string
    dataDir: string
    filesScanned: number
    eventsFound: number
    rawTokenRecords: number
    ignoredEvents: number
    parseDiagnostics: ParseDiagnostics
    sessionsFound: number
    generatedAt: string
  }
  latest: {
    timestamp: string | null
    sessionId: string | null
    planType: string | null
    contextWindow: number | null
    last: TokenTotals
    totals: TokenTotals
  }
  limits: {
    primary: {
      usedPercent: number | null
      windowMinutes: number | null
      resetsAt: string | null
    }
    secondary: {
      usedPercent: number | null
      windowMinutes: number | null
      resetsAt: string | null
    }
  }
  windows: {
    lastHour: WindowSummary
    lastFiveHours: WindowSummary
    lastDay: WindowSummary
    observedAll: WindowSummary
  }
  rates: {
    lastHourTokensPerHour: number
    lastHourActiveTokensPerHour: number
    lastHourRateConfidence: DataConfidence
    lastFiveHoursTokensPerHour: number
    lastFiveHoursRateConfidence: DataConfidence
    lastDayTokensPerHour: number
    lastDayRateConfidence: DataConfidence
    weeklyPercent: PercentProjection
  }
  freshness: {
    latestEventAt: string | null
    latestEventAgeMinutes: number | null
    stale: boolean
    staleMinutes: number | null
  }
  timeline: HourBucket[]
  topSessions: SessionSummary[]
  alerts: GaugeAlert[]
  history: {
    samples: HistoryPoint[]
    latest: HistoryPoint | null
    previous: HistoryPoint | null
  }
  accuracy: {
    known: string[]
    estimated: string[]
    caveats: string[]
  }
}

export type UsageOptions = {
  codexHome?: string
  dataDir?: string
  now?: number
  writeHistory?: boolean
  useCache?: boolean
}

let cache: { key: string; expiresAt: number; value: UsageSummary } | null = null
type ParsedTokenEvents = { events: TokenEvent[]; diagnostics: ParseFileHealth }
const fileCache = new Map<
  string,
  { mtimeMs: number; size: number; parsed: ParsedTokenEvents }
>()

export async function getUsageSummary(
  options: UsageOptions = {},
): Promise<UsageSummary> {
  const now = options.now ?? Date.now()
  const codexHome = resolveCodexHome(options.codexHome)
  const dataDir = resolveDataDir(options.dataDir)
  const cacheKey = `${codexHome}|${dataDir}|${options.writeHistory ?? true}`

  if (options.useCache !== false && cache && cache.key === cacheKey && cache.expiresAt > now) {
    return cache.value
  }

  const roots = [
    { dir: path.join(codexHome, 'sessions'), source: 'sessions' as const },
    {
      dir: path.join(codexHome, 'archived_sessions'),
      source: 'archived_sessions' as const,
    },
  ]

  const filesBySource = await Promise.all(
    roots.map(async ({ dir, source }) => {
      const files = await listJsonlFiles(dir)
      return files.map((file) => ({ file, source }))
    }),
  )

  const files = filesBySource.flat()
  const eventGroups = await Promise.all(
    files.map(({ file, source }) => parseTokenEvents(file, source)),
  )
  const parseDiagnostics = aggregateParseDiagnostics(eventGroups)
  const events = eventGroups
    .flatMap((group) => group.events)
    .filter((event) => Number.isFinite(event.timestampMs))
    .sort((a, b) => a.timestampMs - b.timestampMs)

  let summary = buildSummary(
    codexHome,
    dataDir,
    files.length,
    events,
    now,
    [],
    parseDiagnostics,
  )
  const history = options.writeHistory === false
    ? await readHistory(dataDir, now)
    : await recordHistory(dataDir, summary, now)

  summary = {
    ...summary,
    history,
    alerts: buildAlerts(summary, history),
  }

  if (options.useCache !== false) {
    cache = { key: cacheKey, expiresAt: now + CACHE_TTL_MS, value: summary }
  }

  return summary
}

export function resolveCodexHome(explicit?: string): string {
  return (
    explicit ??
    process.env.TOKEN_GAUGE_CODEX_HOME ??
    process.env.CODEX_HOME ??
    path.join(os.homedir(), '.codex')
  )
}

export function resolveDataDir(explicit?: string): string {
  if (explicit) {
    return explicit
  }

  if (process.env.TOKEN_GAUGE_DATA_DIR) {
    return process.env.TOKEN_GAUGE_DATA_DIR
  }

  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'Token Gauge')
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Token Gauge')
  }

  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
    'token-gauge',
  )
}

export function activeTokens(totals: TokenTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.outputTokens +
    totals.reasoningOutputTokens
  )
}

export async function listJsonlFiles(root: string): Promise<string[]> {
  try {
    await access(root)
  } catch {
    return []
  }

  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        return listJsonlFiles(fullPath)
      }
      return entry.isFile() && entry.name.endsWith('.jsonl') ? [fullPath] : []
    }),
  )

  return nested.flat()
}

async function parseTokenEvents(
  filePath: string,
  source: SourceKind,
): Promise<ParsedTokenEvents> {
  const fileStat = await stat(filePath)
  const cached = fileCache.get(filePath)

  if (
    cached &&
    cached.mtimeMs === fileStat.mtimeMs &&
    cached.size === fileStat.size
  ) {
    return cached.parsed
  }

  const sessionId = path.basename(filePath, '.jsonl').replace(/^rollout-/, '')
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  const diagnostics: ParseFileHealth = {
    file: filePath,
    parsedLines: 0,
    malformedLines: 0,
    parseFailures: 0,
    tokenRecords: 0,
    usedEvents: 0,
    fallbackTokenSourceUsed: 0,
  }
  const events: TokenEvent[] = []

  for await (const line of reader) {
    if (!line.trim()) {
      continue
    }

    diagnostics.parsedLines += 1

    if (!line.includes('"token_count"')) {
      diagnostics.malformedLines += 1
      continue
    }

    try {
      const record = JSON.parse(line)
      if (record?.type !== 'event_msg' || record?.payload?.type !== 'token_count') {
        diagnostics.malformedLines += 1
        continue
      }

      const info = record.payload.info ?? {}
      const payloadTotals = parseTotals(info)
      if (!payloadTotals) {
        diagnostics.malformedLines += 1
        continue
      }

      diagnostics.tokenRecords += 1

      if (payloadTotals.source === 'last') {
        diagnostics.fallbackTokenSourceUsed += 1
      }

      const rateLimits = record.payload.rate_limits ?? {}
      const timestamp = String(record.timestamp ?? '')
      const timestampMs = Date.parse(timestamp)
      if (!Number.isFinite(timestampMs)) {
        diagnostics.malformedLines += 1
        continue
      }

      const parsedEvent: TokenEvent = {
        timestamp,
        timestampMs,
        sessionId,
        source,
        totals: payloadTotals.totals,
        totalsSource: payloadTotals.source,
        last: normalizeBucket(info.last_token_usage),
        contextWindow:
          typeof info.model_context_window === 'number'
            ? info.model_context_window
            : null,
        primary: normalizeWindow(rateLimits.primary),
        secondary: normalizeWindow(rateLimits.secondary),
        planType:
          typeof rateLimits.plan_type === 'string'
            ? rateLimits.plan_type
            : null,
        }

      events.push(parsedEvent)
      diagnostics.usedEvents += 1
    } catch {
      diagnostics.parseFailures += 1
      // Session files are append-only logs; a partially written final line is safe to skip.
    }
  }

  const parsed: ParsedTokenEvents = {
    events,
    diagnostics,
  }

  fileCache.set(filePath, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    parsed,
  })

  return parsed
}

function aggregateParseDiagnostics(
  groups: ParsedTokenEvents[],
): ParseDiagnostics {
  const files = groups.map((group) => group.diagnostics)

  return {
    parsedLines: files.reduce((sum, file) => sum + file.parsedLines, 0),
    malformedLines: files.reduce((sum, file) => sum + file.malformedLines, 0),
    parseFailures: files.reduce((sum, file) => sum + file.parseFailures, 0),
    tokenRecords: files.reduce((sum, file) => sum + file.tokenRecords, 0),
    usedEvents: files.reduce((sum, file) => sum + file.usedEvents, 0),
    ignoredEvents: files.reduce(
      (sum, file) => sum + (file.tokenRecords - file.usedEvents),
      0,
    ),
    fallbackTokenSourceUsed: files.reduce(
      (sum, file) => sum + file.fallbackTokenSourceUsed,
      0,
    ),
    resetEvents: 0,
    anomalousDeltas: 0,
    files,
  }
}

function buildSummary(
  codexHome: string,
  dataDir: string,
  filesScanned: number,
  events: TokenEvent[],
  now: number,
  samples: HistoryPoint[],
  parseDiagnostics: ParseDiagnostics,
): UsageSummary {
  const latest = events.at(-1)
  const usageBuild = buildUsageEvents(events)
  const usageEvents = usageBuild.events
  const sessionIds = new Set(events.map((event) => event.sessionId))
  const lastHourEvents = eventsSince(usageEvents, now - 60 * 60 * 1000)
  const lastFiveHourEvents = eventsSince(
    usageEvents,
    now - 5 * 60 * 60 * 1000,
  )
  const lastDayEvents = eventsSince(usageEvents, now - 24 * 60 * 60 * 1000)
  const lastHour = summarizeWindow(lastHourEvents, now - 60 * 60 * 1000, now)
  const lastFiveHours = summarizeWindow(
    lastFiveHourEvents,
    now - 5 * 60 * 60 * 1000,
    now,
  )
  const lastDay = summarizeWindow(lastDayEvents, now - 24 * 60 * 60 * 1000, now)
  const observedAll = summarizeWindow(
    usageEvents,
    usageEvents.at(0)?.timestampMs ?? now,
    now,
  )
  const lastHourRate = perWindowRates(lastHour)
  const lastFiveHoursRate = perWindowRates(lastFiveHours)
  const lastDayRate = perWindowRates(lastDay)

  const latestEventAgeMinutes =
    latest?.timestampMs !== undefined
      ? Math.max(0, (now - latest.timestampMs) / 60000)
      : null
  const hourlyRateProjection = projectPercent(events, now)

  return {
    source: {
      codexHome,
      dataDir,
      filesScanned,
      eventsFound: usageEvents.length,
      rawTokenRecords: parseDiagnostics.tokenRecords,
      ignoredEvents:
        parseDiagnostics.ignoredEvents + usageBuild.ignoredEvents,
      sessionsFound: sessionIds.size,
      parseDiagnostics: {
        ...parseDiagnostics,
        resetEvents: parseDiagnostics.resetEvents + usageBuild.resetEvents,
        anomalousDeltas: parseDiagnostics.anomalousDeltas + usageBuild.anomalousDeltas,
      },
      generatedAt: new Date(now).toISOString(),
    },
    latest: {
      timestamp: latest?.timestamp ?? null,
      sessionId: latest?.sessionId ?? null,
      planType: latest?.planType ?? null,
      contextWindow: latest?.contextWindow ?? null,
      last: toTotals(latest?.last),
      totals: toTotals(latest?.totals),
    },
    limits: {
      primary: toLimit(latest?.primary),
      secondary: toLimit(latest?.secondary),
    },
    windows: {
      lastHour,
      lastFiveHours,
      lastDay,
      observedAll,
    },
    rates: {
      lastHourTokensPerHour: lastHourRate.totalTokensPerHour,
      lastHourActiveTokensPerHour: lastHourRate.activeTokensPerHour,
      lastHourRateConfidence: lastHour.confidence,
      lastFiveHoursTokensPerHour: lastFiveHoursRate.totalTokensPerHour,
      lastFiveHoursRateConfidence: lastFiveHours.confidence,
      lastDayTokensPerHour: lastDayRate.totalTokensPerHour,
      lastDayRateConfidence: lastDay.confidence,
      weeklyPercent: hourlyRateProjection,
    },
    freshness: {
      latestEventAt: latest?.timestamp ?? null,
      latestEventAgeMinutes:
        latestEventAgeMinutes !== null
          ? Math.round(latestEventAgeMinutes)
          : null,
      stale: (latestEventAgeMinutes ?? 0) > 120,
      staleMinutes:
        latestEventAgeMinutes !== null
          ? Math.round(latestEventAgeMinutes)
          : null,
    },
    timeline: buildHourlyTimeline(lastDayEvents, now),
    topSessions: buildSessionSummaries(usageEvents).slice(0, 8),
    alerts: [],
    history: {
      samples,
      latest: samples.at(-1) ?? null,
      previous: samples.at(-2) ?? null,
    },
    accuracy: {
      known: [
        'Reads Codex token_count events from local session JSONL logs.',
        `Observed ${usageEvents.length.toLocaleString()} deduplicated local deltas from ${parseDiagnostics.tokenRecords.toLocaleString()} token events.`,
        parseDiagnostics.fallbackTokenSourceUsed > 0
          ? `${parseDiagnostics.fallbackTokenSourceUsed.toLocaleString()} records used last_token_usage fallback when total_token_usage was missing.`
          : 'Uses total_token_usage as the primary cumulative counter.',
        'Uses Codex-provided rate limit percentages and reset timestamps when present.',
      ],
      estimated: [
        'Burn rate is a rolling local observation, not a server-side billing or quota statement.',
        'Active burn separates uncached input, output, and reasoning tokens from cached input when metadata includes cache counts.',
        `Window rates are normalized by observed minutes to avoid fixed-time assumptions (${Math.round(lastHour.observedMinutes)}m / ${Math.round(lastFiveHours.observedMinutes)}m / ${Math.round(lastDay.observedMinutes)}m).`,
        `Projection uses an EMA-weighted linear trend and reports confidence before producing an exhaust estimate.`,
      ],
      caveats: [
        'ChatGPT plan usage may include activity outside local Codex logs.',
        'Codex app meter and local metadata can disagree if they are updated on different cadences or include different products.',
        parseDiagnostics.malformedLines > 0
          ? `${parseDiagnostics.malformedLines} malformed lines were skipped while parsing logs.`
          : 'Parser accepted all discovered token_count lines.',
        `Observed deltas were filtered for counter resets (${parseDiagnostics.resetEvents}) and likely anomalies (${parseDiagnostics.anomalousDeltas}).`,
      ],
    },
  }
}

function buildUsageEvents(events: TokenEvent[]): {
  events: UsageEvent[]
  resetEvents: number
  anomalousDeltas: number
  ignoredEvents: number
  usageMethodDescription: string
} {
  const bySession = new Map<string, TokenEvent[]>()

  events.forEach((event) => {
    const session = bySession.get(event.sessionId) ?? []
    session.push(event)
    bySession.set(event.sessionId, session)
  })

  const usageEvents: UsageEvent[] = []
  let resetEvents = 0
  let anomalousDeltas = 0
  let ignoredEvents = 0

  bySession.forEach((sessionEvents) => {
    sessionEvents.sort((a, b) => a.timestampMs - b.timestampMs)
    let previous = emptyTotals()
    let previousTimestampMs = NaN
    let hasSeenFirst = false

    sessionEvents.forEach((event) => {
      const current = toTotals(event.totals)
      const elapsedMinutes =
        hasSeenFirst && Number.isFinite(previousTimestampMs)
          ? Math.max(0.25, (event.timestampMs - previousTimestampMs) / 60000)
          : 0

      const delta = subtractPositive(current, previous)
      const droppedCounter =
        hasSeenFirst && Number.isFinite(previous.totalTokens)
          ? current.totalTokens < previous.totalTokens
          : false
      const isHugeSpike =
        hasSeenFirst &&
        delta.totalTokens > 0 &&
        delta.totalTokens / elapsedMinutes > 250_000
      const shouldIgnore = droppedCounter || isHugeSpike

      if (!hasSeenFirst) {
        previous = current
        previousTimestampMs = event.timestampMs
        hasSeenFirst = true
        return
      }

      if (shouldIgnore) {
        ignoredEvents += 1
        if (droppedCounter) {
          resetEvents += 1
        } else if (isHugeSpike) {
          anomalousDeltas += 1
        }
      } else {
        if (!hasSeenFirst || delta.totalTokens > 0) {
          usageEvents.push({ ...event, delta })
        }
      }

      previous = current
      previousTimestampMs = event.timestampMs
      hasSeenFirst = true
    })
  })

  const ordered = usageEvents.sort((a, b) => a.timestampMs - b.timestampMs)

  return {
    events: ordered,
    resetEvents,
    anomalousDeltas,
    ignoredEvents,
    usageMethodDescription:
      'Per-session cumulative deltas with reset and anomalous-delta protections.',
  }
}
function buildAlerts(
  summary: UsageSummary,
  history: UsageSummary['history'],
): GaugeAlert[] {
  const alerts: GaugeAlert[] = []
  const weekly = summary.limits.secondary.usedPercent
  const primary = summary.limits.primary.usedPercent
  const previousWeek = history.previous?.weeklyUsedPercent ?? null
  const previousPrimary = history.previous?.primaryUsedPercent ?? null
  const projection = summary.rates.weeklyPercent
  const parseRisk =
    summary.source.parseDiagnostics.parseFailures +
      summary.source.parseDiagnostics.malformedLines >
    Math.max(1, summary.source.parseDiagnostics.parsedLines * 0.05)
  const applyQuality = (severity: GaugeAlert['severity']) =>
    downgradeSeverity(
      summary.rates.lastHourRateConfidence.level === 'low' || parseRisk
        ? downgradeSeverity(severity)
        : severity,
    )

  const staleMinutes = summary.freshness.staleMinutes
  if (staleMinutes !== null && staleMinutes > 240) {
    alerts.push({
      id: 'local-stale-critical',
      severity: 'danger',
      title: 'Local usage logs stale',
      detail: `No token_count event in the last ${Math.round(staleMinutes)} minutes.`,
    })
  } else if (staleMinutes !== null && staleMinutes > 120) {
    alerts.push({
      id: 'local-stale',
      severity: 'warning',
      title: 'Local usage logs stale',
      detail: `No token_count event in the last ${Math.round(staleMinutes)} minutes.`,
    })
  }

  if (
    weekly !== null &&
    shouldAlertWithHysteresis(weekly, previousWeek, 95, 90)
  ) {
    alerts.push({
      id: 'weekly-critical',
      severity: applyQuality('danger'),
      title: 'Weekly limit almost gone',
      detail: `Codex metadata reports ${weekly.toFixed(0)}% of the weekly window used.`,
    })
  } else if (
    weekly !== null &&
    shouldAlertWithHysteresis(weekly, previousWeek, 85, 82)
  ) {
    alerts.push({
      id: 'weekly-warning',
      severity: applyQuality('warning'),
      title: 'Weekly limit getting tight',
      detail: `Codex metadata reports ${weekly.toFixed(0)}% of the weekly window used.`,
    })
  } else if (
    weekly !== null &&
    shouldAlertWithHysteresis(weekly, previousWeek, 70, 67)
  ) {
    alerts.push({
      id: 'weekly-watch',
      severity:
        summary.rates.weeklyPercent.confidence.level === 'low' ? 'warning' : 'info',
      title: 'Weekly limit watch',
      detail: `Codex metadata reports ${weekly.toFixed(0)}% of the weekly window used.`,
    })
  }

  if (
    primary !== null &&
    shouldAlertWithHysteresis(primary, previousPrimary, 85, 82)
  ) {
    alerts.push({
      id: 'short-window',
      severity: applyQuality(primary >= 95 ? 'danger' : 'warning'),
      title: 'Short window running hot',
      detail: `The short rolling window is at ${primary.toFixed(0)}%.`,
    })
  }

  if (summary.rates.lastHourActiveTokensPerHour >= 1_000_000) {
    alerts.push({
      id: 'active-burn-rate',
      severity: applyQuality(
        summary.rates.lastHourRateConfidence.level === 'low' ? 'info' : 'warning',
      ),
      title: 'High active burn rate',
      detail: `${formatCompact(summary.rates.lastHourActiveTokensPerHour)} active tokens observed in the last hour.`,
    })
  }

  const projectedAt = projection.projectedExhaustAt
  const reset = summary.limits.secondary.resetsAt
  if (
    projection.confidence.level === 'high' &&
    projectedAt &&
    reset &&
    Date.parse(projectedAt) < Date.parse(reset)
  ) {
    alerts.push({
      id: 'projection-before-reset',
      severity: 'danger',
      title: 'Projected to hit 100% before reset',
      detail: `Recent trend projects exhaustion around ${new Date(projectedAt).toLocaleString()}.`,
    })
  } else if (projection.confidence.level === 'low' && projection.percentPerHour !== null) {
    alerts.push({
      id: 'projection-unreliable',
      severity: 'info',
      title: 'Projection confidence low',
      detail: `Current exhaustion estimate is low-confidence: ${projection.confidence.reason}.`,
    })
  }

  const latest = history.latest
  const previous = history.previous
  if (latest && previous) {
    const delta = latest.weeklyUsedPercent !== null && previous.weeklyUsedPercent !== null
      ? latest.weeklyUsedPercent - previous.weeklyUsedPercent
      : 0
    if (delta >= 6) {
      alerts.push({
        id: 'history-jump',
        severity: 'warning',
        title: 'Usage jumped since last sample',
        detail: `Weekly metadata rose ${delta.toFixed(1)} points between history samples.`,
      })
    } else if (delta <= -2 && latest.weeklyUsedPercent !== null && latest.weeklyUsedPercent < 90) {
      alerts.push({
        id: 'history-dropped',
        severity: 'info',
        title: 'Usage trend eased',
        detail: `Weekly metadata dropped ${Math.abs(delta).toFixed(1)} points since last sample.`,
      })
    }
  }

  if (alerts.length === 0) {
    alerts.push({
      id: 'all-clear',
      severity: 'info',
      title: 'No limit alerts',
      detail: 'Current metadata is below the configured warning thresholds.',
    })
  }

  return alerts
}

function shouldAlertWithHysteresis(
  current: number,
  previous: number | null,
  enterThreshold: number,
  clearThreshold: number,
): boolean {
  if (current >= enterThreshold) {
    return true
  }
  if (previous === null) {
    return false
  }
  return previous >= enterThreshold && current >= clearThreshold
}

function downgradeSeverity(
  severity: GaugeAlert['severity'],
): GaugeAlert['severity'] {
  if (severity === 'info') {
    return 'info'
  }
  if (severity === 'warning') {
    return 'info'
  }
  return 'warning'
}

async function recordHistory(
  dataDir: string,
  summary: UsageSummary,
  now: number,
): Promise<UsageSummary['history']> {
  await mkdir(dataDir, { recursive: true })
  const history = await readHistory(dataDir, now)
  const point = toHistoryPoint(summary)
  const latest = history.latest
  const sameMinute =
    latest &&
    Math.floor(Date.parse(latest.timestamp) / 60_000) ===
      Math.floor(now / 60_000)

  if (!sameMinute) {
    await appendFile(
      path.join(dataDir, HISTORY_FILE),
      `${JSON.stringify(point)}\n`,
      'utf8',
    )
    return {
      samples: [...history.samples, point].slice(-HISTORY_KEEP_DAYS * 24 * 60),
      latest: point,
      previous: history.latest,
    }
  }

  return history
}

async function readHistory(
  dataDir: string,
  now: number,
): Promise<UsageSummary['history']> {
  const historyPath = path.join(dataDir, HISTORY_FILE)
  const cutoff = now - HISTORY_KEEP_DAYS * 24 * 60 * 60 * 1000

  try {
    const text = await readFile(historyPath, 'utf8')
    const samples = text
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as HistoryPoint
          return Date.parse(value.timestamp) >= cutoff ? [value] : []
        } catch {
          return []
        }
      })

    return {
      samples,
      latest: samples.at(-1) ?? null,
      previous: samples.at(-2) ?? null,
    }
  } catch {
    return { samples: [], latest: null, previous: null }
  }
}

function toHistoryPoint(summary: UsageSummary): HistoryPoint {
  return {
    timestamp: summary.source.generatedAt,
    weeklyUsedPercent: summary.limits.secondary.usedPercent,
    primaryUsedPercent: summary.limits.primary.usedPercent,
    lastHourTotalTokens: summary.windows.lastHour.totalTokens,
    lastHourActiveTokens: summary.windows.lastHour.activeTokens,
    lastFiveHourTotalTokens: summary.windows.lastFiveHours.totalTokens,
    observedAllTotalTokens: summary.windows.observedAll.totalTokens,
    eventCount: summary.source.eventsFound,
    sessionCount: summary.source.sessionsFound,
  }
}

function normalizeBucket(value: unknown): TokenBucket {
  if (!value || typeof value !== 'object') {
    return {}
  }

  const bucket = value as Record<string, unknown>
  return {
    input_tokens: numberOrUndefined(bucket.input_tokens),
    cached_input_tokens: numberOrUndefined(bucket.cached_input_tokens),
    output_tokens: numberOrUndefined(bucket.output_tokens),
    reasoning_output_tokens: numberOrUndefined(
      bucket.reasoning_output_tokens,
    ),
    total_tokens: numberOrUndefined(bucket.total_tokens),
  }
}

function parseTotals(
  payloadInfo: unknown,
): { totals: TokenBucket; source: 'total' | 'last' } | null {
  if (!payloadInfo || typeof payloadInfo !== 'object') {
    return null
  }

  const info = payloadInfo as Record<string, unknown>
  const totalTotals = normalizeBucket(info.total_token_usage)
  if (hasAnyTotals(totalTotals)) {
    return { totals: totalTotals, source: 'total' }
  }

  const lastTotals = normalizeBucket(info.last_token_usage)
  if (hasAnyTotals(lastTotals)) {
    return { totals: lastTotals, source: 'last' }
  }

  return null
}

function hasAnyTotals(bucket: TokenBucket): boolean {
  return (
    bucket.input_tokens !== undefined ||
    bucket.cached_input_tokens !== undefined ||
    bucket.output_tokens !== undefined ||
    bucket.reasoning_output_tokens !== undefined ||
    bucket.total_tokens !== undefined
  )
}

function normalizeWindow(value: unknown): RateWindow | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const window = value as Record<string, unknown>
  return {
    used_percent: numberOrUndefined(window.used_percent),
    window_minutes: numberOrUndefined(window.window_minutes),
    resets_at: numberOrUndefined(window.resets_at),
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function toTotals(bucket: TokenBucket | undefined): TokenTotals {
  const inputTokens = bucket?.input_tokens ?? 0
  const cachedInputTokens = bucket?.cached_input_tokens ?? 0
  const outputTokens = bucket?.output_tokens ?? 0
  const reasoningOutputTokens = bucket?.reasoning_output_tokens ?? 0
  const totalTokens = bucket?.total_tokens ?? 0

  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  }
}

function toLimit(window: RateWindow | null | undefined) {
  return {
    usedPercent: window?.used_percent ?? null,
    windowMinutes: window?.window_minutes ?? null,
    resetsAt:
      typeof window?.resets_at === 'number'
        ? new Date(window.resets_at * 1000).toISOString()
        : null,
  }
}

function eventsSince<T extends { timestampMs: number }>(
  events: T[],
  cutoffMs: number,
): T[] {
  return events.filter((event) => event.timestampMs >= cutoffMs)
}

function buildHourlyTimeline(events: UsageEvent[], now: number): HourBucket[] {
  const buckets = Array.from({ length: 24 }, (_, index) => {
    const hourStart = new Date(now - (23 - index) * 60 * 60 * 1000)
    hourStart.setMinutes(0, 0, 0)

    return {
      hourStart,
      totalTokens: 0,
      activeTokens: 0,
      eventCount: 0,
    }
  })

  const indexByHour = new Map(
    buckets.map((bucket, index) => [bucket.hourStart.getTime(), index]),
  )

  events.forEach((event) => {
    const hour = new Date(event.timestampMs)
    hour.setMinutes(0, 0, 0)
    const index = indexByHour.get(hour.getTime())
    if (index === undefined) {
      return
    }

    buckets[index].totalTokens += event.delta.totalTokens
    buckets[index].activeTokens += activeTokens(event.delta)
    buckets[index].eventCount += 1
  })

  return buckets.map((bucket) => ({
    hourStart: bucket.hourStart.toISOString(),
    label: bucket.hourStart.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
    totalTokens: bucket.totalTokens,
    activeTokens: bucket.activeTokens,
    eventCount: bucket.eventCount,
  }))
}

function summarizeWindow(
  events: UsageEvent[],
  windowStartMs: number,
  windowEndMs: number,
): WindowSummary {
  const totals = events.reduce(
    (sum, event) => addTotals(sum, event.delta),
    emptyTotals(),
  )

  if (events.length === 0) {
    return {
      ...totals,
      activeTokens: activeTokens(totals),
      eventCount: 0,
      observedMinutes: 0,
      coveragePercent: 0,
      confidence: {
        level: 'low',
        score: 0.12,
        reason: `No events observed in this ${Math.round((windowEndMs - windowStartMs) / 60000)}m window.`,
      },
    }
  }

  const firstEventTime = events.at(0)?.timestampMs ?? windowEndMs
  const lastEventTime = events.at(-1)?.timestampMs ?? windowEndMs
  const spanMinutes = Math.max(1, (windowEndMs - windowStartMs) / 60000)
  const observedSpan = Math.max(
    0,
    (lastEventTime - firstEventTime) / 60000,
  )
  const observedMinutes = Math.min(spanMinutes, observedSpan)
  const coveragePercent = (observedMinutes / spanMinutes) * 100
  const latestEventAgeMinutes = Math.max(0, (windowEndMs - lastEventTime) / 60000)
  const confidence = assessRateConfidence({
    observedMinutes: Math.min(spanMinutes, observedSpan),
    spanMinutes,
    eventCount: events.length,
    latestEventAgeMinutes,
  })

  return {
    ...totals,
    activeTokens: activeTokens(totals),
    eventCount: events.length,
    observedMinutes: Math.max(0, observedMinutes),
    coveragePercent,
    confidence,
  }
}

function perWindowRates(window: WindowSummary): {
  totalTokensPerHour: number
  activeTokensPerHour: number
} {
  const elapsedHours = Math.max(window.observedMinutes / 60, 0)
  if (window.eventCount <= 1 && window.observedMinutes <= 5) {
    return { totalTokensPerHour: 0, activeTokensPerHour: 0 }
  }
  if (window.observedMinutes <= 2) {
    return { totalTokensPerHour: 0, activeTokensPerHour: 0 }
  }

  return {
    totalTokensPerHour: window.totalTokens / elapsedHours,
    activeTokensPerHour: window.activeTokens / elapsedHours,
  }
}

function assessRateConfidence(params: {
  observedMinutes: number
  spanMinutes: number
  eventCount: number
  latestEventAgeMinutes: number
}): DataConfidence {
  if (params.observedMinutes <= 0 || params.eventCount === 0) {
    return {
      level: 'low',
      score: 0.11,
      reason: 'No observed usage samples in this window.',
    }
  }

  const coverage = params.observedMinutes / Math.max(1, params.spanMinutes)
  const eventDensity = params.eventCount / Math.max(0.25, params.observedMinutes / 60)
  if (coverage >= 0.75 && eventDensity >= 2 && params.latestEventAgeMinutes <= 45) {
    return {
      level: 'high',
      score: 0.84,
      reason: 'Good event density with recent samples and strong window coverage.',
    }
  }

  if (coverage >= 0.35 && eventDensity >= 1 && params.latestEventAgeMinutes <= 120) {
    return {
      level: 'medium',
      score: 0.57,
      reason: 'Moderate event coverage; burn estimate is less precise.',
    }
  }

  return {
    level: 'low',
    score: 0.22,
    reason: 'Sparse samples or stale events reduce rate confidence.',
  }
}

function buildSessionSummaries(events: UsageEvent[]): SessionSummary[] {
  const bySession = new Map<string, SessionSummary>()

  events.forEach((event) => {
    const current =
      bySession.get(event.sessionId) ??
      ({
        sessionId: event.sessionId,
        ...emptyTotals(),
        activeTokens: 0,
        eventCount: 0,
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
      } satisfies SessionSummary)

    const nextTotals = addTotals(current, event.delta)
    bySession.set(event.sessionId, {
      ...current,
      ...nextTotals,
      activeTokens: activeTokens(nextTotals),
      eventCount: current.eventCount + 1,
      firstSeen:
        Date.parse(current.firstSeen) < event.timestampMs
          ? current.firstSeen
          : event.timestamp,
      lastSeen:
        Date.parse(current.lastSeen) > event.timestampMs
          ? current.lastSeen
          : event.timestamp,
    })
  })

  return [...bySession.values()].sort((a, b) => b.totalTokens - a.totalTokens)
}

function projectPercent(events: TokenEvent[], now: number): PercentProjection {
  const percentEvents = events
    .filter((event) => typeof event.secondary?.used_percent === 'number')
    .filter((event) => event.timestampMs >= now - 24 * 60 * 60 * 1000)
    .map((event) => ({
      x: event.timestampMs,
      y: event.secondary?.used_percent ?? 0,
    }))
    .sort((a, b) => a.x - b.x)

  if (percentEvents.length < 3) {
    return {
      percentPerHour: null,
      projectedExhaustAt: null,
      basisHours: null,
      confidence: {
        level: 'low',
        score: 0.2,
        reason: 'Too few weekly-percent samples in the last 24h for trend.',
      },
    }
  }

  const alpha = 0.45
  const smoothed: { x: number; y: number }[] = []
  for (const point of percentEvents) {
    const previous = smoothed.at(-1)
    smoothed.push({
      x: point.x,
      y:
        previous === undefined
          ? point.y
          : point.y * alpha + previous.y * (1 - alpha),
    })
  }

  const basisMs = smoothed.at(-1)!.x - smoothed[0].x
  const basisHours = basisMs / 3_600_000
  if (!Number.isFinite(basisHours) || basisHours <= 0) {
    return {
      percentPerHour: null,
      projectedExhaustAt: null,
      basisHours: null,
      confidence: {
        level: 'low',
        score: 0.13,
        reason: 'Weekly-percent sample window duration was invalid.',
      },
    }
  }

  const xMean = smoothed.reduce((sum, point) => sum + point.x, 0) / smoothed.length
  const yMean =
    smoothed.reduce((sum, point) => sum + point.y, 0) / smoothed.length

  const { numerator, denominator } = smoothed.reduce(
    (agg, point) => {
      const xDelta = point.x - xMean
      const yDelta = point.y - yMean
      return {
        numerator: agg.numerator + xDelta * yDelta,
        denominator: agg.denominator + xDelta * xDelta,
      }
    },
    { numerator: 0, denominator: 0 },
  )

  if (denominator <= 0) {
    return {
      percentPerHour: null,
      projectedExhaustAt: null,
      basisHours,
      confidence: {
        level: 'low',
        score: 0.1,
        reason: 'Cannot compute a reliable linear trend from weekly-percent samples.',
      },
    }
  }

  const msPerHour = 3_600_000
  const trendPerMs = numerator / denominator
  const percentPerHour = trendPerMs * msPerHour
  const residuals = smoothed.map((point) => {
    const expected =
      yMean + trendPerMs * (point.x - xMean)
    return Math.abs(expected - point.y)
  })
  const averageResidual = residuals.reduce((sum, value) => sum + value, 0) / residuals.length

  const finalWindow = smoothed.at(-1)!
  const finalValue = finalWindow.y

  const confidence =
    smoothed.length >= 8 && averageResidual <= 2.4 && percentPerHour > 0
      ? {
          level: 'high' as const,
          score: 0.88,
          reason:
            'Strong short-history linear trend across recent percent samples.',
        }
      : smoothed.length >= 5 && averageResidual <= 4.5
        ? {
            level: 'medium' as const,
            score: 0.64,
            reason: 'Moderate trend confidence; estimate is directional.',
          }
        : {
            level: 'low' as const,
            score: 0.24,
            reason: 'Trend residuals are noisy; no reliable percent trend.',
          }

  if (percentPerHour <= 0) {
    return {
      percentPerHour: 0,
      projectedExhaustAt: null,
      basisHours,
      confidence,
    }
  }

  if (confidence.level === 'low') {
    return {
      percentPerHour: null,
      projectedExhaustAt: null,
      basisHours,
      confidence,
    }
  }

  const remaining = Math.max(0, 100 - finalValue)
  const projectedMs = finalWindow.x + (remaining / percentPerHour) * msPerHour

  return {
    percentPerHour,
    projectedExhaustAt: new Date(projectedMs).toISOString(),
    basisHours,
    confidence,
  }
}

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  }
}

function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

function subtractPositive(
  current: TokenTotals,
  previous: TokenTotals,
): TokenTotals {
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(
      0,
      current.cachedInputTokens - previous.cachedInputTokens,
    ),
    uncachedInputTokens: Math.max(
      0,
      current.uncachedInputTokens - previous.uncachedInputTokens,
    ),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(
      0,
      current.reasoningOutputTokens - previous.reasoningOutputTokens,
    ),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
  }
}

function formatCompact(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(0)}k`
  }
  return `${Math.round(value)}`
}
