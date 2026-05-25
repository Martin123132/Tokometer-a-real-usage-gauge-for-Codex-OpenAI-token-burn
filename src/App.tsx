import { useEffect, useMemo, useState } from 'react'
import './App.css'

type TokenTotals = {
  inputTokens: number
  cachedInputTokens: number
  uncachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

type WindowSummary = TokenTotals & {
  activeTokens: number
  eventCount: number
}

type GaugeAlert = {
  id: string
  severity: 'info' | 'warning' | 'danger'
  title: string
  detail: string
}

type HistoryPoint = {
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

type UsageData = {
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
    weeklyPercent: {
      percentPerHour: number | null
      projectedExhaustAt: string | null
      basisHours: number | null
    }
  }
  timeline: {
    hourStart: string
    label: string
    totalTokens: number
    activeTokens: number
    eventCount: number
  }[]
  topSessions: Array<
    TokenTotals & {
      activeTokens: number
      sessionId: string
      eventCount: number
      firstSeen: string
      lastSeen: string
    }
  >
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

const dangerZone = 82
const primaryMeterStorageKey = 'tokometer-primary-meter'
const legacyPrimaryMeterStorageKey = 'token-gauge-primary-meter'
const weeklyMeterStorageKey = 'tokometer-weekly-meter'
const legacyWeeklyMeterStorageKey = 'token-gauge-meter'

function App() {
  const [data, setData] = useState<UsageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [meterOverride, setMeterOverride] = useState(() => {
    return (
      window.localStorage.getItem(weeklyMeterStorageKey) ??
      window.localStorage.getItem(legacyWeeklyMeterStorageKey) ??
      ''
    )
  })
  const [primaryMeterOverride, setPrimaryMeterOverride] = useState(() => {
    return (
      window.localStorage.getItem(primaryMeterStorageKey) ??
      window.localStorage.getItem(legacyPrimaryMeterStorageKey) ??
      ''
    )
  })

  const refresh = async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/usage')
      if (!response.ok) {
        throw new Error(`Usage API returned ${response.status}`)
      }
      const payload = (await response.json()) as UsageData
      setData(payload)
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : 'Could not load token metadata',
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const firstRun = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => {
      window.clearTimeout(firstRun)
      window.clearInterval(timer)
    }
  }, [])

  const weeklyPercent = data?.limits.secondary.usedPercent ?? 0
  const visibleMeter = resolveVisibleMeter(meterOverride, weeklyPercent)
  const primaryPercent = data?.limits.primary.usedPercent ?? 0
  const visiblePrimaryMeter = resolveVisibleMeter(
    primaryMeterOverride,
    primaryPercent,
  )
  const activeBurnHour = data?.windows.lastHour.activeTokens ?? 0
  const burnScore = useMemo(() => {
    return Math.min(100, Math.round((activeBurnHour / 240_000) * 100))
  }, [activeBurnHour])
  const alerts = useMemo(
    () => buildClientAlerts(data, visibleMeter, visiblePrimaryMeter),
    [data, visibleMeter, visiblePrimaryMeter],
  )

  if (!data && loading) {
    return <LoadingPanel />
  }

  if (!data && error) {
    return (
      <main className="fallback-state">
        <div className="brand-mark">TK</div>
        <h1>Tokometer</h1>
        <p>{error}</p>
        <button type="button" onClick={() => void refresh()}>
          Retry
        </button>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <aside className="rail" aria-label="Token gauge sections">
        <div className="brand-mark">TK</div>
        <RailIcon label="Gauges" active path="M12 5a7 7 0 0 1 7 7v2h-3v-2a4 4 0 0 0-8 0v2H5v-2a7 7 0 0 1 7-7Zm-1 9h2v5h-2v-5Z" />
        <RailIcon label="Timeline" path="M4 17h16v2H4v-2Zm1-6h4v4H5v-4Zm5-6h4v10h-4V5Zm5 3h4v7h-4V8Z" />
        <RailIcon label="Sessions" path="M5 5h14v3H5V5Zm0 5h14v3H5v-3Zm0 5h14v4H5v-4Z" />
      </aside>

      <main className="dashboard">
        <header className="topbar">
          <div>
            <h1>Tokometer</h1>
            <div className="meta-row">
              <StatusPill tone="known" label="Known Metadata" />
              <span>Token Gauge</span>
              <span>{formatPlan(data?.latest.planType)}</span>
              <span>{data?.source.eventsFound.toLocaleString()} events</span>
              <span>{data?.source.sessionsFound} sessions</span>
            </div>
          </div>
          <div className="topbar-actions">
            <div className="updated">
              <span>Updated</span>
              <strong>{formatTime(data?.source.generatedAt)}</strong>
            </div>
            <button type="button" onClick={() => void refresh()}>
              Refresh
            </button>
            <button type="button" onClick={() => exportData(data, 'json')}>
              JSON
            </button>
            <button type="button" onClick={() => exportData(data, 'md')}>
              Report
            </button>
          </div>
        </header>

        {error ? <div className="inline-error">{error}</div> : null}

        <section className="cluster-grid">
          <section className="instrument-panel main-cluster">
            <Gauge
              label="Weekly Usage"
              value={visibleMeter}
              valueLabel={`${Math.round(visibleMeter)}%`}
              sublabel={`Resets ${formatDate(data?.limits.secondary.resetsAt)}`}
              tone={visibleMeter >= dangerZone ? 'danger' : 'cyan'}
            />
            <Gauge
              label="Burn Rate"
              value={burnScore}
              valueLabel={`${formatTokens(activeBurnHour)}/hr`}
              sublabel={`${formatTokens(data?.windows.lastHour.totalTokens ?? 0)} total incl. cached`}
              tone={burnScore >= dangerZone ? 'danger' : 'amber'}
            />
          </section>

          <section className="instrument-panel compact-limits">
            <LimitDial
              label="5h Window"
              value={visiblePrimaryMeter}
              reset={data?.limits.primary.resetsAt}
              metadataValue={primaryPercent}
            />
            <LimitDial
              label="Weekly Window"
              value={visibleMeter}
              reset={data?.limits.secondary.resetsAt}
              metadataValue={weeklyPercent}
            />
            <MeterReconcile
              id="visible-primary-meter"
              label="5h App Meter"
              shortLabel="5h app"
              metadataPercent={primaryPercent}
              value={primaryMeterOverride}
              visibleMeter={visiblePrimaryMeter}
              onChange={(nextValue) => {
                setPrimaryMeterOverride(nextValue)
                if (nextValue === '') {
                  window.localStorage.removeItem(primaryMeterStorageKey)
                  window.localStorage.removeItem(legacyPrimaryMeterStorageKey)
                } else {
                  window.localStorage.setItem(primaryMeterStorageKey, nextValue)
                  window.localStorage.removeItem(legacyPrimaryMeterStorageKey)
                }
              }}
            />
            <MeterReconcile
              id="visible-weekly-meter"
              label="Weekly App Meter"
              shortLabel="weekly app"
              metadataPercent={weeklyPercent}
              value={meterOverride}
              visibleMeter={visibleMeter}
              onChange={(nextValue) => {
                setMeterOverride(nextValue)
                if (nextValue === '') {
                  window.localStorage.removeItem(weeklyMeterStorageKey)
                  window.localStorage.removeItem(legacyWeeklyMeterStorageKey)
                } else {
                  window.localStorage.setItem(weeklyMeterStorageKey, nextValue)
                  window.localStorage.removeItem(legacyWeeklyMeterStorageKey)
                }
              }}
            />
            <div className="projection">
              <span>Projected</span>
              <strong>{formatProjection(data)}</strong>
            </div>
          </section>

          <section className="instrument-panel detail-panel">
            <div className="panel-heading">
              <h2>Latest Turn</h2>
              <StatusPill tone="estimated" label="Estimated" />
            </div>
            <MetricGrid totals={data?.latest.last ?? emptyTotals} />
            <div className="context-line">
              <span>Context Window</span>
              <strong>{formatTokens(data?.latest.contextWindow ?? 0)}</strong>
            </div>
          </section>
        </section>

        <section className="lower-grid">
          <section className="instrument-panel timeline-panel">
            <div className="panel-heading">
              <h2>24h Burn Timeline</h2>
              <span>{formatTokens(data?.windows.lastDay.totalTokens ?? 0)} observed</span>
            </div>
            <Timeline data={data?.timeline ?? []} />
          </section>

          <section className="instrument-panel totals-panel">
            <div className="panel-heading">
              <h2>Observed Totals</h2>
              <span>Local sessions</span>
            </div>
            <div className="totals-stack">
              <TotalRow label="Last hour" value={data?.windows.lastHour.totalTokens ?? 0} events={data?.windows.lastHour.eventCount ?? 0} />
              <TotalRow label="Last 5h" value={data?.windows.lastFiveHours.totalTokens ?? 0} events={data?.windows.lastFiveHours.eventCount ?? 0} />
              <TotalRow label="Last 24h" value={data?.windows.lastDay.totalTokens ?? 0} events={data?.windows.lastDay.eventCount ?? 0} />
              <TotalRow label="All local" value={data?.windows.observedAll.totalTokens ?? 0} events={data?.windows.observedAll.eventCount ?? 0} />
            </div>
          </section>
        </section>

        <section className="insight-grid">
          <AlertsPanel alerts={alerts} />
          <HistoryPanel samples={data?.history.samples ?? []} />
          <AccuracyPanel
            data={data}
            visibleMeter={visibleMeter}
            visiblePrimaryMeter={visiblePrimaryMeter}
            meterOverride={meterOverride}
            primaryMeterOverride={primaryMeterOverride}
          />
        </section>

        <section className="instrument-panel sessions-panel">
          <div className="panel-heading">
            <h2>Heaviest Sessions</h2>
            <span>By cumulative local deltas</span>
          </div>
          <SessionTable sessions={data?.topSessions ?? []} />
        </section>
      </main>
    </div>
  )
}

function LoadingPanel() {
  return (
    <main className="fallback-state">
      <div className="brand-mark">TK</div>
      <h1>Tokometer</h1>
      <p>Scanning Codex token metadata</p>
    </main>
  )
}

function RailIcon({
  label,
  path,
  active = false,
}: {
  label: string
  path: string
  active?: boolean
}) {
  return (
    <button className={active ? 'rail-button active' : 'rail-button'} title={label}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={path} />
      </svg>
    </button>
  )
}

function StatusPill({
  label,
  tone,
}: {
  label: string
  tone: 'known' | 'estimated'
}) {
  return <span className={`status-pill ${tone}`}>{label}</span>
}

function Gauge({
  label,
  value,
  valueLabel,
  sublabel,
  tone,
}: {
  label: string
  value: number
  valueLabel: string
  sublabel: string
  tone: 'cyan' | 'amber' | 'danger'
}) {
  const clamped = clamp(value)
  const progressPath = describeArc(120, 126, 96, 180, 180 + clamped * 1.8)
  const needle = polarToCartesian(120, 126, 72, 180 + clamped * 1.8)

  return (
    <div className={`gauge gauge-${tone}`}>
      <svg viewBox="0 0 240 150" role="img" aria-label={`${label} ${valueLabel}`}>
        <path className="gauge-track" d={describeArc(120, 126, 96, 180, 360)} />
        <path className="gauge-progress" d={progressPath} />
        <path className="danger-arc" d={describeArc(120, 126, 96, 326, 360)} />
        {Array.from({ length: 9 }, (_, index) => {
          const angle = 180 + index * 22.5
          const outer = polarToCartesian(120, 126, 102, angle)
          const inner = polarToCartesian(120, 126, index % 2 === 0 ? 86 : 91, angle)
          return (
            <line
              key={angle}
              className="gauge-tick"
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
            />
          )
        })}
        <line
          className="gauge-needle"
          x1="120"
          y1="126"
          x2={needle.x}
          y2={needle.y}
        />
        <circle className="gauge-hub" cx="120" cy="126" r="7" />
      </svg>
      <div className="gauge-readout">
        <span>{label}</span>
        <strong>{valueLabel}</strong>
        <em>{sublabel}</em>
      </div>
    </div>
  )
}

function LimitDial({
  label,
  value,
  reset,
  metadataValue,
}: {
  label: string
  value: number
  reset?: string | null
  metadataValue: number
}) {
  const clamped = clamp(value)

  return (
    <div className="limit-dial">
      <div
        className="dial-face"
        style={{ '--dial-value': `${clamped}%` } as React.CSSProperties}
      >
        <span>{Math.round(clamped)}%</span>
      </div>
      <div>
        <strong>{label}</strong>
        <span>Meta {Math.round(metadataValue)}% / {formatDate(reset)}</span>
      </div>
    </div>
  )
}

function MeterReconcile({
  id,
  label,
  shortLabel,
  metadataPercent,
  value,
  visibleMeter,
  onChange,
}: {
  id: string
  label: string
  shortLabel: string
  metadataPercent: number
  value: string
  visibleMeter: number
  onChange: (value: string) => void
}) {
  const delta = Number.isFinite(visibleMeter)
    ? visibleMeter - metadataPercent
    : 0

  return (
    <div className="meter-reconcile">
      <label htmlFor={id}>{label}</label>
      <div className="meter-input-row">
        <input
          id={id}
          type="number"
          min="0"
          max="100"
          inputMode="decimal"
          placeholder={`${Math.round(metadataPercent)}`}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <span>%</span>
        <strong title={`Visible ${shortLabel} versus local metadata`}>
          {delta >= 0 ? '+' : ''}{delta.toFixed(0)} pts
        </strong>
      </div>
    </div>
  )
}

function MetricGrid({ totals }: { totals: TokenTotals }) {
  return (
    <div className="metric-grid">
      <Metric label="Input" value={totals.inputTokens} />
      <Metric label="Cached" value={totals.cachedInputTokens} />
      <Metric label="Uncached" value={totals.uncachedInputTokens} />
      <Metric label="Output" value={totals.outputTokens} />
      <Metric label="Reasoning" value={totals.reasoningOutputTokens} />
      <Metric label="Total" value={totals.totalTokens} strong />
    </div>
  )
}

function Metric({
  label,
  value,
  strong = false,
}: {
  label: string
  value: number
  strong?: boolean
}) {
  return (
    <div className={strong ? 'metric strong' : 'metric'}>
      <span>{label}</span>
      <strong>{formatTokens(value)}</strong>
    </div>
  )
}

function Timeline({
  data,
}: {
  data: UsageData['timeline']
}) {
  const max = Math.max(1, ...data.map((bucket) => bucket.totalTokens))

  return (
    <div className="timeline">
      {data.map((bucket, index) => {
        const height = Math.max(4, (bucket.totalTokens / max) * 100)
        const hot = bucket.totalTokens / max > 0.7
        return (
          <div className="timeline-column" key={`${bucket.hourStart}-${index}`}>
            <div className="bar-track">
              <div
                className={hot ? 'bar hot' : 'bar'}
                style={{ height: `${height}%` }}
                title={`${bucket.label}: ${formatTokens(bucket.totalTokens)}`}
              />
            </div>
            {index % 6 === 0 ? <span>{bucket.label}</span> : null}
          </div>
        )
      })}
    </div>
  )
}

function TotalRow({
  label,
  value,
  events,
}: {
  label: string
  value: number
  events: number
}) {
  return (
    <div className="total-row">
      <span>{label}</span>
      <strong>{formatTokens(value)}</strong>
      <em>{events} events</em>
    </div>
  )
}

function AlertsPanel({ alerts }: { alerts: GaugeAlert[] }) {
  return (
    <section className="instrument-panel alerts-panel">
      <div className="panel-heading">
        <h2>Alerts</h2>
        <span>{alerts.length} active</span>
      </div>
      <div className="alert-stack">
        {alerts.map((alert) => (
          <div className={`alert-row ${alert.severity}`} key={alert.id}>
            <strong>{alert.title}</strong>
            <span>{alert.detail}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function HistoryPanel({ samples }: { samples: HistoryPoint[] }) {
  const recent = samples.slice(-24)
  const max = Math.max(1, ...recent.map((sample) => sample.lastHourActiveTokens))

  return (
    <section className="instrument-panel history-panel">
      <div className="panel-heading">
        <h2>History</h2>
        <span>{samples.length} samples</span>
      </div>
      <div className="history-bars">
        {recent.map((sample) => {
          const height = Math.max(4, (sample.lastHourActiveTokens / max) * 100)
          return (
            <div className="history-bar" key={sample.timestamp}>
              <div style={{ height: `${height}%` }} />
            </div>
          )
        })}
      </div>
      <div className="history-footer">
        <span>Persistent one-minute snapshots</span>
        <strong>{formatTokens(recent.at(-1)?.lastHourActiveTokens ?? 0)} active/hr</strong>
      </div>
    </section>
  )
}

function AccuracyPanel({
  data,
  visibleMeter,
  visiblePrimaryMeter,
  meterOverride,
  primaryMeterOverride,
}: {
  data: UsageData | null
  visibleMeter: number
  visiblePrimaryMeter: number
  meterOverride: string
  primaryMeterOverride: string
}) {
  const primaryMetadataPercent = data?.limits.primary.usedPercent ?? 0
  const weeklyMetadataPercent = data?.limits.secondary.usedPercent ?? 0

  return (
    <section className="instrument-panel accuracy-panel">
      <div className="panel-heading">
        <h2>Known vs Estimated</h2>
        <span>Portable parser</span>
      </div>
      <div className="accuracy-meter">
        <MeterComparisonRow
          label="5h"
          metadataPercent={primaryMetadataPercent}
          visibleMeter={visiblePrimaryMeter}
          override={primaryMeterOverride}
        />
        <MeterComparisonRow
          label="Weekly"
          metadataPercent={weeklyMetadataPercent}
          visibleMeter={visibleMeter}
          override={meterOverride}
        />
      </div>
      <DetailsList title="Known" items={data?.accuracy.known ?? []} />
      <DetailsList title="Estimated" items={data?.accuracy.estimated ?? []} />
      <DetailsList title="Caveats" items={data?.accuracy.caveats ?? []} />
      <div className="path-note">
        <span>Codex home</span>
        <code>{data?.source.codexHome}</code>
      </div>
      <div className="path-note">
        <span>History store</span>
        <code>{data?.source.dataDir}</code>
      </div>
    </section>
  )
}

function MeterComparisonRow({
  label,
  metadataPercent,
  visibleMeter,
  override,
}: {
  label: string
  metadataPercent: number
  visibleMeter: number
  override: string
}) {
  const delta = override === '' ? 0 : visibleMeter - metadataPercent

  return (
    <div className="accuracy-meter-row">
      <strong className="accuracy-window">{label}</strong>
      <div>
        <span>Metadata</span>
        <strong>{Math.round(metadataPercent)}%</strong>
      </div>
      <div>
        <span>Visible app</span>
        <strong>{override === '' ? 'Unset' : `${Math.round(visibleMeter)}%`}</strong>
      </div>
      <div>
        <span>Delta</span>
        <strong>{delta >= 0 ? '+' : ''}{delta.toFixed(0)} pts</strong>
      </div>
    </div>
  )
}

function DetailsList({ title, items }: { title: string; items: string[] }) {
  return (
    <details>
      <summary>{title}</summary>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </details>
  )
}

function SessionTable({ sessions }: { sessions: UsageData['topSessions'] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Total</th>
            <th>Input</th>
            <th>Active</th>
            <th>Output</th>
            <th>Events</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.sessionId}>
              <td>{shortSession(session.sessionId)}</td>
              <td>{formatTokens(session.totalTokens)}</td>
              <td>{formatTokens(session.inputTokens)}</td>
              <td>{formatTokens(session.activeTokens)}</td>
              <td>{formatTokens(session.outputTokens)}</td>
              <td>{session.eventCount.toLocaleString()}</td>
              <td>{formatTime(session.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function buildClientAlerts(
  data: UsageData | null,
  visibleMeter: number,
  visiblePrimaryMeter: number,
): GaugeAlert[] {
  if (!data) {
    return []
  }

  const alerts = [...data.alerts]
  const primaryMetadataPercent = data.limits.primary.usedPercent ?? 0
  const primaryDelta = visiblePrimaryMeter - primaryMetadataPercent
  const weeklyMetadataPercent = data.limits.secondary.usedPercent ?? 0
  const weeklyDelta = visibleMeter - weeklyMetadataPercent

  if (Number.isFinite(weeklyDelta) && Math.abs(weeklyDelta) >= 8) {
    alerts.unshift({
      id: 'weekly-meter-mismatch',
      severity: 'warning',
      title: 'Weekly app meter mismatch',
      detail: `Visible weekly meter differs from local metadata by ${weeklyDelta >= 0 ? '+' : ''}${weeklyDelta.toFixed(0)} points.`,
    })
  }

  if (Number.isFinite(primaryDelta) && Math.abs(primaryDelta) >= 8) {
    alerts.unshift({
      id: 'primary-meter-mismatch',
      severity: 'warning',
      title: '5h app meter mismatch',
      detail: `Visible 5h meter differs from local metadata by ${primaryDelta >= 0 ? '+' : ''}${primaryDelta.toFixed(0)} points.`,
    })
  }

  return alerts
}

function exportData(data: UsageData | null, format: 'json' | 'md') {
  if (!data) {
    return
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  if (format === 'json') {
    downloadFile(
      `tokometer-${timestamp}.json`,
      JSON.stringify(data, null, 2),
      'application/json',
    )
    return
  }

  downloadFile(
    `tokometer-report-${timestamp}.md`,
    createMarkdownReport(data),
    'text/markdown',
  )
}

function createMarkdownReport(data: UsageData) {
  return [
    '# Tokometer Report',
    '',
    `Generated: ${data.source.generatedAt}`,
    `Codex home: ${data.source.codexHome}`,
    `History store: ${data.source.dataDir}`,
    '',
    '## Limits',
    '',
    `- 5h window: ${formatPercent(data.limits.primary.usedPercent)}; resets ${formatDate(data.limits.primary.resetsAt)}`,
    `- Weekly window: ${formatPercent(data.limits.secondary.usedPercent)}; resets ${formatDate(data.limits.secondary.resetsAt)}`,
    `- Projection: ${formatProjection(data)}`,
    '',
    '## Burn',
    '',
    `- Last hour total: ${formatTokens(data.windows.lastHour.totalTokens)}`,
    `- Last hour active: ${formatTokens(data.windows.lastHour.activeTokens)}`,
    `- Last 5h total: ${formatTokens(data.windows.lastFiveHours.totalTokens)}`,
    `- Last 24h total: ${formatTokens(data.windows.lastDay.totalTokens)}`,
    '',
    '## Alerts',
    '',
    ...data.alerts.map((alert) => `- ${alert.severity.toUpperCase()}: ${alert.title} - ${alert.detail}`),
    '',
    '## Caveats',
    '',
    ...data.accuracy.caveats.map((item) => `- ${item}`),
    '',
  ].join('\n')
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function formatTokens(value: number) {
  if (!Number.isFinite(value)) {
    return '0'
  }

  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`
  }
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (abs >= 10_000) {
    return `${Math.round(value / 1_000)}k`
  }
  return Math.round(value).toLocaleString()
}

function formatPercent(value?: number | null) {
  return typeof value === 'number' ? `${value.toFixed(0)}%` : 'Unknown'
}

function formatDate(value?: string | null) {
  if (!value) {
    return 'No reset'
  }

  return new Intl.DateTimeFormat([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatTime(value?: string | null) {
  if (!value) {
    return 'Never'
  }

  return new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function formatPlan(value?: string | null) {
  if (!value) {
    return 'Local plan metadata'
  }

  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

function formatProjection(data: UsageData | null) {
  const projection = data?.rates.weeklyPercent
  if (!projection || projection.percentPerHour === null) {
    return 'No trend'
  }
  if (projection.percentPerHour === 0) {
    return 'Stable'
  }
  return projection.projectedExhaustAt
    ? formatDate(projection.projectedExhaustAt)
    : `${projection.percentPerHour.toFixed(2)}%/hr`
}

function shortSession(sessionId: string) {
  const parts = sessionId.split('-')
  if (parts.length < 5) {
    return sessionId.slice(0, 18)
  }
  return `${parts[0]} ${parts.at(-1)?.slice(0, 8)}`
}

function clamp(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(100, value))
}

function resolveVisibleMeter(override: string, metadataPercent: number) {
  if (override === '') {
    return metadataPercent
  }

  const parsed = Number(override)
  return Number.isFinite(parsed) ? clamp(parsed) : metadataPercent
}

function polarToCartesian(cx: number, cy: number, radius: number, angle: number) {
  const radians = (angle * Math.PI) / 180
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  }
}

function describeArc(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
) {
  const start = polarToCartesian(cx, cy, radius, startAngle)
  const end = polarToCartesian(cx, cy, radius, endAngle)
  const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1
  return [
    'M',
    start.x,
    start.y,
    'A',
    radius,
    radius,
    0,
    largeArcFlag,
    1,
    end.x,
    end.y,
  ].join(' ')
}

const emptyTotals: TokenTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
}

export default App
