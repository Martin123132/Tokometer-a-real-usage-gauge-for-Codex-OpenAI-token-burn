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
    lastFiveHoursTokensPerHour: number
    lastDayTokensPerHour: number
    weeklyPercent: PercentProjection
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
const fileCache = new Map<
  string,
  { mtimeMs: number; size: number; events: TokenEvent[] }
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
  const events = eventGroups
    .flat()
    .filter((event) => Number.isFinite(event.timestampMs))
    .sort((a, b) => a.timestampMs - b.timestampMs)

  let summary = buildSummary(codexHome, dataDir, files.length, events, now, [])
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
): Promise<TokenEvent[]> {
  const fileStat = await stat(filePath)
  const cached = fileCache.get(filePath)

  if (
    cached &&
    cached.mtimeMs === fileStat.mtimeMs &&
    cached.size === fileStat.size
  ) {
    return cached.events
  }

  const sessionId = path.basename(filePath, '.jsonl').replace(/^rollout-/, '')
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  const events: TokenEvent[] = []

  for await (const line of reader) {
    if (!line.includes('"token_count"')) {
      continue
    }

    try {
      const record = JSON.parse(line)
      if (
        record?.type !== 'event_msg' ||
        record?.payload?.type !== 'token_count'
      ) {
        continue
      }

      const info = record.payload.info ?? {}
      const rateLimits = record.payload.rate_limits ?? {}
      const timestamp = String(record.timestamp ?? '')
      const timestampMs = Date.parse(timestamp)

      events.push({
        timestamp,
        timestampMs,
        sessionId,
        source,
        totals: normalizeBucket(info.total_token_usage),
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
      })
    } catch {
      // Session files are append-only logs; a partially written final line is safe to skip.
    }
  }

  fileCache.set(filePath, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    events,
  })

  return events
}

function buildSummary(
  codexHome: string,
  dataDir: string,
  filesScanned: number,
  events: TokenEvent[],
  now: number,
  samples: HistoryPoint[],
): UsageSummary {
  const latest = events.at(-1)
  const usageEvents = buildUsageEvents(events)
  const sessionIds = new Set(events.map((event) => event.sessionId))
  const lastHourEvents = eventsSince(usageEvents, now - 60 * 60 * 1000)
  const lastFiveHourEvents = eventsSince(
    usageEvents,
    now - 5 * 60 * 60 * 1000,
  )
  const lastDayEvents = eventsSince(usageEvents, now - 24 * 60 * 60 * 1000)
  const lastHour = summarizeEvents(lastHourEvents)
  const lastFiveHours = summarizeEvents(lastFiveHourEvents)
  const lastDay = summarizeEvents(lastDayEvents)
  const observedAll = summarizeEvents(usageEvents)

  return {
    source: {
      codexHome,
      dataDir,
      filesScanned,
      eventsFound: usageEvents.length,
      sessionsFound: sessionIds.size,
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
      lastHourTokensPerHour: lastHour.totalTokens,
      lastHourActiveTokensPerHour: lastHour.activeTokens,
      lastFiveHoursTokensPerHour: lastFiveHours.totalTokens / 5,
      lastDayTokensPerHour: lastDay.totalTokens / 24,
      weeklyPercent: projectPercent(events, now),
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
        'Uses cumulative total_token_usage deltas per session to avoid counting repeated UI refresh events.',
        'Uses Codex-provided rate limit percentages and reset timestamps when present.',
      ],
      estimated: [
        'Burn rate is a rolling local observation, not a server-side billing or quota statement.',
        'Active burn separates uncached input, output, and reasoning tokens from cached input when metadata includes cache counts.',
        'Projection assumes the recent weekly percent trend continues until reset.',
      ],
      caveats: [
        'ChatGPT plan usage may include activity outside local Codex logs.',
        'Codex app meter and local metadata can disagree if they are updated on different cadences or include different products.',
        'Archived or moved session files are included only when they exist under the detected Codex home.',
      ],
    },
  }
}

function buildUsageEvents(events: TokenEvent[]): UsageEvent[] {
  const bySession = new Map<string, TokenEvent[]>()

  events.forEach((event) => {
    const session = bySession.get(event.sessionId) ?? []
    session.push(event)
    bySession.set(event.sessionId, session)
  })

  const usageEvents: UsageEvent[] = []

  bySession.forEach((sessionEvents) => {
    sessionEvents.sort((a, b) => a.timestampMs - b.timestampMs)
    let previous = emptyTotals()

    sessionEvents.forEach((event) => {
      const current = toTotals(event.totals)
      const delta = subtractPositive(current, previous)
      previous = current

      if (delta.totalTokens > 0) {
        usageEvents.push({ ...event, delta })
      }
    })
  })

  return usageEvents.sort((a, b) => a.timestampMs - b.timestampMs)
}

function buildAlerts(
  summary: UsageSummary,
  history: UsageSummary['history'],
): GaugeAlert[] {
  const alerts: GaugeAlert[] = []
  const weekly = summary.limits.secondary.usedPercent
  const primary = summary.limits.primary.usedPercent

  if (weekly !== null && weekly >= 95) {
    alerts.push({
      id: 'weekly-critical',
      severity: 'danger',
      title: 'Weekly limit almost gone',
      detail: `Codex metadata reports ${weekly.toFixed(0)}% of the weekly window used.`,
    })
  } else if (weekly !== null && weekly >= 85) {
    alerts.push({
      id: 'weekly-warning',
      severity: 'warning',
      title: 'Weekly limit getting tight',
      detail: `Codex metadata reports ${weekly.toFixed(0)}% of the weekly window used.`,
    })
  } else if (weekly !== null && weekly >= 70) {
    alerts.push({
      id: 'weekly-watch',
      severity: 'info',
      title: 'Weekly limit watch',
      detail: `Codex metadata reports ${weekly.toFixed(0)}% of the weekly window used.`,
    })
  }

  if (primary !== null && primary >= 80) {
    alerts.push({
      id: 'short-window',
      severity: primary >= 95 ? 'danger' : 'warning',
      title: 'Short window running hot',
      detail: `The short rolling window is at ${primary.toFixed(0)}%.`,
    })
  }

  if (summary.rates.lastHourActiveTokensPerHour >= 1_000_000) {
    alerts.push({
      id: 'active-burn-rate',
      severity: 'warning',
      title: 'High active burn rate',
      detail: `${formatCompact(summary.rates.lastHourActiveTokensPerHour)} active tokens observed in the last hour.`,
    })
  }

  const projection = summary.rates.weeklyPercent.projectedExhaustAt
  const reset = summary.limits.secondary.resetsAt
  if (projection && reset && Date.parse(projection) < Date.parse(reset)) {
    alerts.push({
      id: 'projection-before-reset',
      severity: 'danger',
      title: 'Projected to hit 100% before reset',
      detail: `Recent trend projects exhaustion around ${new Date(projection).toLocaleString()}.`,
    })
  }

  const latest = history.latest
  const previous = history.previous
  if (latest && previous) {
    const delta = latest.weeklyUsedPercent !== null && previous.weeklyUsedPercent !== null
      ? latest.weeklyUsedPercent - previous.weeklyUsedPercent
      : 0
    if (delta >= 5) {
      alerts.push({
        id: 'history-jump',
        severity: 'warning',
        title: 'Usage jumped since last sample',
        detail: `Weekly metadata rose ${delta.toFixed(1)} points between history samples.`,
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
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
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

function summarizeEvents(events: UsageEvent[]): WindowSummary {
  const totals = events.reduce(
    (sum, event) => addTotals(sum, event.delta),
    emptyTotals(),
  )

  return {
    ...totals,
    activeTokens: activeTokens(totals),
    eventCount: events.length,
  }
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

  if (percentEvents.length < 2) {
    return { percentPerHour: null, projectedExhaustAt: null, basisHours: null }
  }

  const first = percentEvents[0]
  const last = percentEvents.at(-1)!
  const hours = (last.timestampMs - first.timestampMs) / 3_600_000
  const delta =
    (last.secondary?.used_percent ?? 0) - (first.secondary?.used_percent ?? 0)

  if (hours <= 0 || delta <= 0) {
    return { percentPerHour: 0, projectedExhaustAt: null, basisHours: hours }
  }

  const percentPerHour = delta / hours
  const remaining = Math.max(0, 100 - (last.secondary?.used_percent ?? 0))
  const projectedMs = last.timestampMs + (remaining / percentPerHour) * 3_600_000

  return {
    percentPerHour,
    projectedExhaustAt: new Date(projectedMs).toISOString(),
    basisHours: hours,
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
