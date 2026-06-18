import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

type AnomalyPolicy = 'strict' | 'normal' | 'relaxed'

type AnomalyPolicyRecommendation = {
  policy: AnomalyPolicy
  reason: string
  ignoredRatio: number
  parseIssueRatio: number
}

type SystemCheckStatus = 'pass' | 'warn' | 'fail'

type SystemCheck = {
  id: string
  label: string
  status: SystemCheckStatus
  detail: string
}

type CalibrationEntry = {
  id: string
  timestamp: string
  meter: 'primary' | 'weekly'
  visiblePercent: number
  metadataPercent: number | null
  deltaPoints: number | null
  generatedAt: string | null
}

type CalibrationConfidence = 'none' | 'low' | 'medium' | 'high'

type CalibrationInsight = {
  meter: 'primary' | 'weekly'
  sampleCount: number
  meanDeltaPoints: number | null
  latestDeltaPoints: number | null
  confidence: CalibrationConfidence
  summary: string
}

type TokenTotals = {
  inputTokens: number
  cachedInputTokens: number
  uncachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

type ConfidenceLevel = 'high' | 'medium' | 'low'

type DataConfidence = {
  level: ConfidenceLevel
  score: number
  reason: string
}

type ParseFileHealth = {
  file: string
  parsedLines: number
  nonTokenLines: number
  malformedLines: number
  parseFailures: number
  tokenRecords: number
  usedEvents: number
  fallbackTokenSourceUsed: number
}

type ParseDiagnostics = {
  parsedLines: number
  nonTokenLines: number
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

type WindowSummary = TokenTotals & {
  activeTokens: number
  eventCount: number
  observedMinutes: number
  coveragePercent: number
  confidence: DataConfidence
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
    scanDurationMs: number
    filesParsed: number
    filesFromCache: number
    largestFileLines: number
    warnings: string[]
    eventsFound: number
    sessionsFound: number
    rawTokenRecords: number
    ignoredEvents: number
    parseDiagnostics: ParseDiagnostics
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
    weeklyPercent: {
      percentPerHour: number | null
      projectedExhaustAt: string | null
      basisHours: number | null
      confidence: DataConfidence
    }
  }
  freshness: {
    latestEventAt: string | null
    latestEventAgeMinutes: number | null
    stale: boolean
    staleMinutes: number | null
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

type ViewMode = 'dashboard' | 'settings'

type AppSettings = {
  refreshSeconds: number
  dangerThreshold: number
  mismatchThreshold: number
  activeBurnScale: number
  anomalyPolicy: AnomalyPolicy
}

const defaultSettings: AppSettings = {
  refreshSeconds: 60,
  dangerThreshold: 82,
  mismatchThreshold: 8,
  activeBurnScale: 240_000,
  anomalyPolicy: 'normal',
}

const anomalyPolicyChoices: { value: AnomalyPolicy; label: string }[] = [
  { value: 'strict', label: 'Strict (filter more spikes)' },
  { value: 'normal', label: 'Normal (balanced)' },
  { value: 'relaxed', label: 'Relaxed (keep large surges)' },
]

const settingsStorageKey = 'tokometer-settings-v1'
const primaryMeterStorageKey = 'tokometer-primary-meter'
const legacyPrimaryMeterStorageKey = 'token-gauge-primary-meter'
const weeklyMeterStorageKey = 'tokometer-weekly-meter'
const legacyWeeklyMeterStorageKey = 'token-gauge-meter'
const calibrationHistoryStorageKey = 'tokometer-calibration-history-v1'
const onboardingDismissedStorageKey = 'tokometer-onboarding-dismissed-v1'
const calibrationHistoryLimit = 80
const appVersion = '0.1.0'
const releaseChannel = 'local-first'
const diagnosticsSchema = 'tokometer-diagnostics-v1'

function App() {
  const [data, setData] = useState<UsageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('dashboard')
  const [settings, setSettings] = useState(loadSettings)
  const [supportPreviewOpen, setSupportPreviewOpen] = useState(false)
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    return window.localStorage.getItem(onboardingDismissedStorageKey) === 'true'
  })
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
  const [calibrationHistory, setCalibrationHistory] = useState(loadCalibrationHistory)
  const calibrationInsights = useMemo(
    () => buildCalibrationInsights(calibrationHistory),
    [calibrationHistory],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const query = new URLSearchParams()
      query.set('anomalyPolicy', settings.anomalyPolicy)
      const response = await fetch(`/api/usage?${query.toString()}`)
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
  }, [settings.anomalyPolicy])

  useEffect(() => {
    const firstRun = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(
      () => void refresh(),
      settings.refreshSeconds * 1000,
    )
    return () => {
      window.clearTimeout(firstRun)
      window.clearInterval(timer)
    }
  }, [settings.refreshSeconds, settings.anomalyPolicy, refresh])

  useEffect(() => {
    window.localStorage.setItem(settingsStorageKey, JSON.stringify(settings))
  }, [settings])

  const weeklyPercent = data?.limits.secondary.usedPercent ?? 0
  const visibleMeter = resolveVisibleMeter(meterOverride, weeklyPercent)
  const primaryPercent = data?.limits.primary.usedPercent ?? 0
  const visiblePrimaryMeter = resolveVisibleMeter(
    primaryMeterOverride,
    primaryPercent,
  )
  const activeBurnHour = data?.windows.lastHour.activeTokens ?? 0
  const burnScore = useMemo(() => {
    return Math.min(100, Math.round((activeBurnHour / settings.activeBurnScale) * 100))
  }, [activeBurnHour, settings.activeBurnScale])
  const alerts = useMemo(
    () => buildClientAlerts(data, visibleMeter, visiblePrimaryMeter, settings),
    [data, visibleMeter, visiblePrimaryMeter, settings],
  )
  const staleAgeMinutes = data?.freshness.staleMinutes ?? null
  const projectionConfidence = data?.rates.weeklyPercent.confidence ?? null
  const hasLowConfidenceProjection =
    projectionConfidence !== null && projectionConfidence.level === 'low'
  const parseDiagnostics = data?.source.parseDiagnostics
  const parseWarningRate =
    (parseDiagnostics?.malformedLines ?? 0) + (parseDiagnostics?.parseFailures ?? 0)
  const staleRefreshWindowMinutes = Math.max(5, (settings.refreshSeconds * 3) / 60)
  const staleByRefreshWindow =
    staleAgeMinutes !== null && staleAgeMinutes > staleRefreshWindowMinutes
  const hasSampleWarning =
    (data?.freshness.stale ?? false) || staleByRefreshWindow || hasLowConfidenceProjection
  const anomalyPolicyRecommendation = useMemo(
    () => recommendAnomalyPolicy(data),
    [data],
  )
  const systemChecks = useMemo(
    () =>
      buildSystemChecks(
        data,
        settings,
        primaryMeterOverride,
        meterOverride,
      ),
    [data, settings, primaryMeterOverride, meterOverride],
  )
  const systemHealth = summarizeSystemChecks(systemChecks)
  const hasSystemFailures = systemChecks.some((check) => check.status === 'fail')
  const showFirstRun =
    viewMode === 'dashboard' && hasSystemFailures && !onboardingDismissed

  const qualityNotes = (() => {
    const items: string[] = []
    if (staleAgeMinutes !== null && staleByRefreshWindow) {
      items.push(
        `No fresh token events in the last ${Math.round(staleAgeMinutes)}m (refresh window ~${Math.round(staleRefreshWindowMinutes)}m).`,
      )
    }
    if (staleAgeMinutes !== null && staleAgeMinutes > 180) {
      items.push(`Local token log is stale (${Math.round(staleAgeMinutes)} min since last event).`)
    }
    if (parseWarningRate > 0) {
      items.push('Some token log lines were skipped while parsing; confidence is reduced.')
    }
    if (parseDiagnostics?.ignoredEvents && parseDiagnostics.ignoredEvents > 0) {
      items.push(`Ignored ${parseDiagnostics.ignoredEvents} noisy/reset token samples.`)
    }
    if (data?.source.scanDurationMs !== undefined && data.source.scanDurationMs > 3_000) {
      items.push(
        `Last scan took ${(data.source.scanDurationMs / 1000).toFixed(1)}s; parser cache should improve the next refresh.`,
      )
    }
    data?.source.warnings?.forEach((warning) => items.push(warning))
    if (hasLowConfidenceProjection) {
      items.push(`Projection confidence: ${projectionConfidence.level} - ${projectionConfidence.reason}`)
    }
    return items
  })()

  const setPrimaryMeterValue = (nextValue: string) => {
    setPrimaryMeterOverride(nextValue)
    if (nextValue === '') {
      window.localStorage.removeItem(primaryMeterStorageKey)
      window.localStorage.removeItem(legacyPrimaryMeterStorageKey)
    } else {
      window.localStorage.setItem(primaryMeterStorageKey, nextValue)
      window.localStorage.removeItem(legacyPrimaryMeterStorageKey)
      recordCalibrationSample('primary', nextValue)
    }
  }

  const setWeeklyMeterValue = (nextValue: string) => {
    setMeterOverride(nextValue)
    if (nextValue === '') {
      window.localStorage.removeItem(weeklyMeterStorageKey)
      window.localStorage.removeItem(legacyWeeklyMeterStorageKey)
    } else {
      window.localStorage.setItem(weeklyMeterStorageKey, nextValue)
      window.localStorage.removeItem(legacyWeeklyMeterStorageKey)
      recordCalibrationSample('weekly', nextValue)
    }
  }

  const resetMeterOverrides = () => {
    setPrimaryMeterValue('')
    setWeeklyMeterValue('')
  }

  const clearCalibrationHistory = () => {
    setCalibrationHistory([])
    window.localStorage.removeItem(calibrationHistoryStorageKey)
  }

  const dismissOnboarding = () => {
    setOnboardingDismissed(true)
    window.localStorage.setItem(onboardingDismissedStorageKey, 'true')
  }

  const resetSettings = () => {
    setSettings(defaultSettings)
  }

  const recordCalibrationSample = (meter: CalibrationEntry['meter'], value: string) => {
    const visiblePercent = Number(value)
    if (!Number.isFinite(visiblePercent)) {
      return
    }

    const metadataPercent =
      meter === 'primary'
        ? data?.limits.primary.usedPercent ?? null
        : data?.limits.secondary.usedPercent ?? null
    const deltaPoints =
      metadataPercent === null ? null : clamp(visiblePercent) - metadataPercent
    const entry: CalibrationEntry = {
      id: `${meter}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      meter,
      visiblePercent: clamp(visiblePercent),
      metadataPercent,
      deltaPoints,
      generatedAt: data?.source.generatedAt ?? null,
    }

    setCalibrationHistory((previous) => {
      const next = [entry, ...previous].slice(0, calibrationHistoryLimit)
      window.localStorage.setItem(
        calibrationHistoryStorageKey,
        JSON.stringify(next),
      )
      return next
    })
  }

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
        <RailIcon
          label="Dashboard"
          active={viewMode === 'dashboard'}
          path="M12 5a7 7 0 0 1 7 7v2h-3v-2a4 4 0 0 0-8 0v2H5v-2a7 7 0 0 1 7-7Zm-1 9h2v5h-2v-5Z"
          onClick={() => setViewMode('dashboard')}
        />
        <RailIcon
          label="Settings"
          active={viewMode === 'settings'}
          path="M12 8.6a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8Zm7.1 2.7 1.7 1.3-1.6 2.8-2.1-.8a6 6 0 0 1-1.4.8l-.3 2.2h-3.2l-.3-2.2a6 6 0 0 1-1.4-.8l-2.1.8-1.6-2.8 1.7-1.3a6 6 0 0 1 0-1.6L6.8 8.4l1.6-2.8 2.1.8a6 6 0 0 1 1.4-.8l.3-2.2h3.2l.3 2.2a6 6 0 0 1 1.4.8l2.1-.8 1.6 2.8-1.7 1.3a6 6 0 0 1 0 1.6Z"
          onClick={() => setViewMode('settings')}
        />
      </aside>

      <main className="dashboard">
        <header className="topbar">
          <div>
            <h1>Tokometer</h1>
        <div className="meta-row">
              <StatusPill tone="known" label="Known Metadata" />
              <StatusPill
                tone={systemHealth.tone}
                label={systemHealth.label}
              />
              {hasSampleWarning ? (
                <StatusPill tone="warning" label="Sample Warning" />
              ) : null}
              <span>v{appVersion}</span>
              <span>Token Gauge</span>
              <span>{formatPlan(data?.latest.planType)}</span>
              <span>{data?.source.eventsFound.toLocaleString()} events</span>
              <span>{data?.source.sessionsFound} sessions</span>
              <span>{data?.source.scanDurationMs ?? 0}ms scan</span>
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
            <button
              type="button"
              onClick={() => setSupportPreviewOpen(true)}
            >
              Diagnostics
            </button>
          </div>
        </header>

        {supportPreviewOpen ? (
          <SupportBundlePreview
            data={data}
            settings={settings}
            primaryMeterOverride={primaryMeterOverride}
            weeklyMeterOverride={meterOverride}
            systemChecks={systemChecks}
            calibrationHistory={calibrationHistory}
            calibrationInsights={calibrationInsights}
            onClose={() => setSupportPreviewOpen(false)}
            onDownload={() => {
              exportDiagnosticsBundle(
                data,
                settings,
                primaryMeterOverride,
                meterOverride,
                systemChecks,
                calibrationHistory,
                calibrationInsights,
              )
              setSupportPreviewOpen(false)
            }}
          />
        ) : null}

        {qualityNotes.length > 0 ? (
          <section className="sample-warning-strip">
            {qualityNotes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </section>
        ) : null}

        {error ? <div className="inline-error">{error}</div> : null}

        {viewMode === 'settings' ? (
      <SettingsView
            data={data}
            settings={settings}
            onSettingsChange={setSettings}
            anomalyPolicyRecommendation={anomalyPolicyRecommendation}
            onApplyRecommendedPolicy={(policy) =>
              setSettings((previous) => ({ ...previous, anomalyPolicy: policy }))
            }
            systemChecks={systemChecks}
            calibrationHistory={calibrationHistory}
            calibrationInsights={calibrationInsights}
            primaryMeterOverride={primaryMeterOverride}
            weeklyMeterOverride={meterOverride}
            onPrimaryMeterChange={setPrimaryMeterValue}
            onWeeklyMeterChange={setWeeklyMeterValue}
            onResetMeters={resetMeterOverrides}
            onResetSettings={resetSettings}
            onClearCalibrationHistory={clearCalibrationHistory}
          />
        ) : (
          <>
        {showFirstRun ? (
          <FirstRunPanel
            data={data}
            checks={systemChecks}
            onOpenSettings={() => setViewMode('settings')}
            onDiagnostics={() => setSupportPreviewOpen(true)}
            onDismiss={dismissOnboarding}
          />
        ) : null}

        <section className="cluster-grid">
          <section className="instrument-panel main-cluster">
            <Gauge
              label="Weekly Usage"
              value={visibleMeter}
              valueLabel={`${Math.round(visibleMeter)}%`}
              sublabel={`Resets ${formatDate(data?.limits.secondary.resetsAt)}`}
              tone={visibleMeter >= settings.dangerThreshold ? 'danger' : 'cyan'}
            />
            <Gauge
              label="Burn Rate"
              value={burnScore}
              valueLabel={`${formatTokens(activeBurnHour)}/hr`}
              sublabel={`${formatTokens(data?.windows.lastHour.totalTokens ?? 0)} total incl. cached`}
              tone={burnScore >= settings.dangerThreshold ? 'danger' : 'amber'}
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
              onChange={setPrimaryMeterValue}
            />
            <MeterReconcile
              id="visible-weekly-meter"
              label="Weekly App Meter"
              shortLabel="weekly app"
              metadataPercent={weeklyPercent}
              value={meterOverride}
              visibleMeter={visibleMeter}
              onChange={setWeeklyMeterValue}
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
          <SystemCheckPanel checks={systemChecks} compact />
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
          </>
        )}
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

function FirstRunPanel({
  data,
  checks,
  onOpenSettings,
  onDiagnostics,
  onDismiss,
}: {
  data: UsageData | null
  checks: SystemCheck[]
  onOpenSettings: () => void
  onDiagnostics: () => void
  onDismiss: () => void
}) {
  const checkById = new Map(checks.map((check) => [check.id, check]))
  const rows = [
    {
      label: 'Codex path detected',
      status: checkById.get('codex-log-path')?.status ?? 'fail',
      detail:
        data?.source.codexHome ??
        checkById.get('codex-log-path')?.detail ??
        'Waiting for local Codex path.',
    },
    {
      label: 'Logs found',
      status: checkById.get('token-events')?.status ?? 'fail',
      detail:
        data && data.source.filesScanned > 0
          ? `${data.source.filesScanned} files, ${data.source.rawTokenRecords} token records.`
          : checkById.get('token-events')?.detail ?? 'No token records found yet.',
    },
    {
      label: 'History writable',
      status: checkById.get('history-store')?.status ?? 'warn',
      detail: checkById.get('history-store')?.detail ?? 'No history sample yet.',
    },
    {
      label: 'Calibration optional',
      status: checkById.get('visible-meter-calibration')?.status ?? 'warn',
      detail: checkById.get('visible-meter-calibration')?.detail ?? 'Visible app meter comparison is optional.',
    },
    {
      label: 'Diagnostics ready',
      status: 'pass' as const,
      detail: 'Support bundle preview is available before export.',
    },
  ]

  return (
    <section className="instrument-panel first-run-panel">
      <div className="first-run-copy">
        <StatusPill tone="danger" label="Setup Needed" />
        <h2>First Run Check</h2>
        <p>
          Tokometer can still open, but one or more local checks need attention before the gauge is trustworthy.
        </p>
      </div>
      <div className="first-run-steps">
        {rows.map((row) => (
          <div className={`first-run-step ${row.status}`} key={row.label}>
            <strong>{row.label}</strong>
            <span>{row.detail}</span>
          </div>
        ))}
      </div>
      <div className="first-run-actions">
        <button type="button" onClick={onOpenSettings}>
          Open Settings
        </button>
        <button type="button" onClick={onDiagnostics}>
          Preview Support Bundle
        </button>
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </section>
  )
}

function SupportBundlePreview({
  data,
  settings,
  primaryMeterOverride,
  weeklyMeterOverride,
  systemChecks,
  calibrationHistory,
  calibrationInsights,
  onClose,
  onDownload,
}: {
  data: UsageData | null
  settings: AppSettings
  primaryMeterOverride: string
  weeklyMeterOverride: string
  systemChecks: SystemCheck[]
  calibrationHistory: CalibrationEntry[]
  calibrationInsights: CalibrationInsight[]
  onClose: () => void
  onDownload: () => void
}) {
  const included = [
    `App metadata: Tokometer v${appVersion}, release channel, browser runtime.`,
    `Redacted paths: Codex home and history store with username removed.`,
    `Scan metrics: ${data?.source.scanDurationMs ?? 0}ms, ${data?.source.filesScanned ?? 0} files, ${data?.source.filesFromCache ?? 0} from cache.`,
    `Parser health: line counts, skipped non-token lines, malformed candidates, reset/anomaly counts.`,
    `Window summaries: token totals, observed minutes, rate confidence, freshness.`,
    `System checks: ${systemChecks.length} local readiness checks.`,
    `Calibration: ${calibrationHistory.length} samples plus drift confidence summaries.`,
    `Settings and meter overrides: refresh, thresholds, anomaly policy, visible meter values.`,
  ]
  const excluded = [
    'Raw JSONL log lines.',
    'Conversation text, prompts, model replies, and tool outputs.',
    'Full session identifiers and full local usernames in paths.',
    'Environment variables, API keys, auth tokens, and payment details.',
    'Network calls to OpenAI or any external service.',
  ]
  const preview = data
    ? createDiagnosticsBundle(
        data,
        settings,
        primaryMeterOverride,
        weeklyMeterOverride,
        systemChecks,
        calibrationHistory,
        calibrationInsights,
      )
    : null

  return (
    <section className="support-preview-backdrop" role="dialog" aria-modal="true">
      <div className="instrument-panel support-preview">
        <div className="panel-heading">
          <h2>Support Bundle Preview</h2>
          <StatusPill tone="known" label="Redacted" />
        </div>
        <div className="support-preview-grid">
          <div>
            <h3>Included</h3>
            <ul>
              {included.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3>Never Exported</h3>
            <ul>
              {excluded.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
        <pre className="support-preview-json">
          {JSON.stringify(
            {
              schema: preview?.schema ?? diagnosticsSchema,
              app: preview?.app ?? {
                name: 'Tokometer',
                version: appVersion,
                releaseChannel,
              },
              source: preview?.source ?? null,
              parseDiagnostics: preview
                ? {
                    parsedLines: preview.parseDiagnostics.parsedLines,
                    nonTokenLines: preview.parseDiagnostics.nonTokenLines,
                    files: preview.parseDiagnostics.files.length,
                  }
                : null,
              calibrationInsights: preview?.calibrationInsights ?? calibrationInsights,
            },
            null,
            2,
          )}
        </pre>
        <div className="support-preview-actions">
          <button type="button" onClick={onDownload} disabled={!data}>
            Download Diagnostics
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </section>
  )
}

function RailIcon({
  label,
  path,
  onClick,
  active = false,
}: {
  label: string
  path: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      className={active ? 'rail-button active' : 'rail-button'}
      title={label}
      type="button"
      aria-pressed={active}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={path} />
      </svg>
    </button>
  )
}

function SettingsView({
  data,
  settings,
  onSettingsChange,
  anomalyPolicyRecommendation,
  onApplyRecommendedPolicy,
  systemChecks,
  calibrationHistory,
  calibrationInsights,
  primaryMeterOverride,
  weeklyMeterOverride,
  onPrimaryMeterChange,
  onWeeklyMeterChange,
  onResetMeters,
  onResetSettings,
  onClearCalibrationHistory,
}: {
  data: UsageData | null
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
  anomalyPolicyRecommendation: AnomalyPolicyRecommendation | null
  onApplyRecommendedPolicy: (policy: AnomalyPolicy) => void
  systemChecks: SystemCheck[]
  calibrationHistory: CalibrationEntry[]
  calibrationInsights: CalibrationInsight[]
  primaryMeterOverride: string
  weeklyMeterOverride: string
  onPrimaryMeterChange: (value: string) => void
  onWeeklyMeterChange: (value: string) => void
  onResetMeters: () => void
  onResetSettings: () => void
  onClearCalibrationHistory: () => void
}) {
  const primaryPercent = data?.limits.primary.usedPercent ?? 0
  const weeklyPercent = data?.limits.secondary.usedPercent ?? 0
  const visiblePrimaryMeter = resolveVisibleMeter(primaryMeterOverride, primaryPercent)
  const visibleWeeklyMeter = resolveVisibleMeter(weeklyMeterOverride, weeklyPercent)
  const codexHome = data?.source.codexHome ?? '~/.codex'
  const dataDir = data?.source.dataDir ?? 'System app data folder'
  const updateSetting = (patch: Partial<AppSettings>) => {
    onSettingsChange({ ...settings, ...patch })
  }

  return (
    <section className="settings-grid">
      <section className="instrument-panel settings-panel settings-wide">
        <div className="panel-heading">
          <h2>Settings</h2>
          <span>Local preferences</span>
        </div>
        <div className="settings-controls">
          <SettingSelectField
            id="anomaly-policy"
            label="Anomaly policy"
            value={settings.anomalyPolicy}
            options={anomalyPolicyChoices}
            onChange={(value) => updateSetting({ anomalyPolicy: value })}
          />
          <SettingCalibrationField
            recommendation={anomalyPolicyRecommendation}
            currentPolicy={settings.anomalyPolicy}
            onApply={(nextPolicy) => onApplyRecommendedPolicy(nextPolicy)}
          />
          <SettingNumberField
            id="refresh-seconds"
            label="Refresh"
            suffix="sec"
            min={15}
            max={600}
            step={15}
            value={settings.refreshSeconds}
            onChange={(value) => updateSetting({ refreshSeconds: value })}
          />
          <SettingNumberField
            id="danger-threshold"
            label="Danger"
            suffix="%"
            min={50}
            max={100}
            step={1}
            value={settings.dangerThreshold}
            onChange={(value) => updateSetting({ dangerThreshold: value })}
          />
          <SettingNumberField
            id="mismatch-threshold"
            label="Mismatch"
            suffix="pts"
            min={1}
            max={50}
            step={1}
            value={settings.mismatchThreshold}
            onChange={(value) => updateSetting({ mismatchThreshold: value })}
          />
          <SettingNumberField
            id="active-burn-scale"
            label="Burn Scale"
            suffix="tokens/hr"
            min={10_000}
            max={10_000_000}
            step={10_000}
            value={settings.activeBurnScale}
            onChange={(value) => updateSetting({ activeBurnScale: value })}
          />
        </div>
        <div className="settings-actions">
          <button type="button" onClick={onResetSettings}>
            Restore Defaults
          </button>
        </div>
      </section>

      <SystemCheckPanel checks={systemChecks} />

      <section className="instrument-panel settings-panel meter-settings-panel">
        <div className="panel-heading">
          <h2>App Meters</h2>
          <span>Visible vs local</span>
        </div>
        <MeterReconcile
          id="settings-primary-meter"
          label="5h App Meter"
          shortLabel="5h app"
          metadataPercent={primaryPercent}
          value={primaryMeterOverride}
          visibleMeter={visiblePrimaryMeter}
          onChange={onPrimaryMeterChange}
        />
        <MeterReconcile
          id="settings-weekly-meter"
          label="Weekly App Meter"
          shortLabel="weekly app"
          metadataPercent={weeklyPercent}
          value={weeklyMeterOverride}
          visibleMeter={visibleWeeklyMeter}
          onChange={onWeeklyMeterChange}
        />
        <div className="settings-actions">
          <button type="button" onClick={onResetMeters}>
            Clear App Meters
          </button>
        </div>
      </section>

      <CalibrationHistoryPanel
        entries={calibrationHistory}
        insights={calibrationInsights}
        onClear={onClearCalibrationHistory}
      />

      <section className="instrument-panel settings-panel settings-wide">
        <div className="panel-heading">
          <h2>Runtime Paths</h2>
          <span>Restart-time overrides</span>
        </div>
        <div className="path-stack">
          <PathLine label="Codex home" value={codexHome} />
          <PathLine label="History store" value={dataDir} />
          <CommandLine label="Codex env" value={`TOKEN_GAUGE_CODEX_HOME=${quoteShellValue(codexHome)}`} />
          <CommandLine label="History env" value={`TOKEN_GAUGE_DATA_DIR=${quoteShellValue(dataDir)}`} />
        </div>
      </section>

      <section className="instrument-panel settings-panel">
        <div className="panel-heading">
          <h2>Package</h2>
          <span>Desktop build</span>
        </div>
        <div className="release-list">
          <ReleaseLine label="Version" value={`v${appVersion}`} />
          <ReleaseLine label="Channel" value={releaseChannel} />
          <ReleaseLine label="Dev shell" value="npm run desktop" />
          <ReleaseLine label="Prod shell" value="npm run desktop:prod" />
          <ReleaseLine label="Installer" value="npm run dist" />
        </div>
      </section>
    </section>
  )
}

function SettingCalibrationField({
  recommendation,
  currentPolicy,
  onApply,
}: {
  recommendation: AnomalyPolicyRecommendation | null
  currentPolicy: AnomalyPolicy
  onApply: (policy: AnomalyPolicy) => void
}) {
  if (!recommendation) {
    return null
  }

  const suggestionPolicy = recommendation.policy
  const actionLabel =
    currentPolicy === suggestionPolicy
      ? 'Already active'
      : `Apply ${policyLabel(suggestionPolicy)}`

  return (
    <div className="settings-field">
      <span>Policy calibration</span>
      <div className="calibration-control">
        <div>
          <strong>{policyLabel(suggestionPolicy)} recommended</strong>
          <p>
            {recommendation.reason}
            {` (${Math.round(recommendation.ignoredRatio * 100)}% ignored, ${Math.round(
              recommendation.parseIssueRatio * 100,
            )}% parse issues)`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onApply(suggestionPolicy)}
          disabled={currentPolicy === suggestionPolicy}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  )
}

function SettingNumberField({
  id,
  label,
  suffix,
  min,
  max,
  step,
  value,
  onChange,
}: {
  id: string
  label: string
  suffix: string
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="settings-field" htmlFor={id}>
      <span>{label}</span>
      <div>
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => {
            onChange(boundNumber(Number(event.currentTarget.value), min, max, value))
          }}
        />
        <em>{suffix}</em>
      </div>
    </label>
  )
}

function SettingSelectField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: AnomalyPolicy
  options: { value: AnomalyPolicy; label: string }[]
  onChange: (value: AnomalyPolicy) => void
}) {
  return (
    <label className="settings-field" htmlFor={id}>
      <span>{label}</span>
      <div>
        <select
          id={id}
          value={value}
          onChange={(event) => {
            const nextValue = event.currentTarget.value
            if (
              nextValue === 'strict' ||
              nextValue === 'normal' ||
              nextValue === 'relaxed'
            ) {
              onChange(nextValue)
            }
          }}
        >
          {options.map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </label>
  )
}

function PathLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="path-line">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  )
}

function CommandLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="command-line">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  )
}

function ReleaseLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="release-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function SystemCheckPanel({
  checks,
  compact = false,
}: {
  checks: SystemCheck[]
  compact?: boolean
}) {
  const visibleChecks = compact ? checks.slice(0, 5) : checks
  const summary = summarizeSystemChecks(checks)

  return (
    <section className="instrument-panel settings-panel system-check-panel">
      <div className="panel-heading">
        <h2>System Check</h2>
        <StatusPill tone={summary.tone} label={summary.label} />
      </div>
      <div className="check-stack">
        {visibleChecks.map((check) => (
          <div className={`check-row ${check.status}`} key={check.id}>
            <strong>{check.label}</strong>
            <span>{check.detail}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function CalibrationHistoryPanel({
  entries,
  insights,
  onClear,
}: {
  entries: CalibrationEntry[]
  insights: CalibrationInsight[]
  onClear: () => void
}) {
  const recentEntries = entries.slice(0, 8)

  return (
    <section className="instrument-panel settings-panel calibration-history-panel">
      <div className="panel-heading">
        <h2>Calibration Logbook</h2>
        <span>{entries.length} samples</span>
      </div>
      <div className="calibration-insight-grid">
        {insights.map((insight) => (
          <div className={`calibration-insight ${insight.confidence}`} key={insight.meter}>
            <span>{insight.meter === 'primary' ? '5h drift' : 'Weekly drift'}</span>
            <strong>
              {insight.meanDeltaPoints === null
                ? 'No baseline'
                : `${insight.meanDeltaPoints >= 0 ? '+' : ''}${insight.meanDeltaPoints.toFixed(1)} pts`}
            </strong>
            <em>{insight.summary}</em>
          </div>
        ))}
      </div>
      {recentEntries.length > 0 ? (
        <div className="calibration-history-list">
          {recentEntries.map((entry) => (
            <div className="calibration-history-row" key={entry.id}>
              <strong>{entry.meter === 'primary' ? '5h' : 'Weekly'}</strong>
              <span>{formatDateTime(entry.timestamp)}</span>
              <em>
                Visible {Math.round(entry.visiblePercent)}%
                {entry.metadataPercent === null
                  ? ' / metadata unknown'
                  : ` / metadata ${Math.round(entry.metadataPercent)}%`}
              </em>
              <b>
                {entry.deltaPoints === null
                  ? 'No delta'
                  : `${entry.deltaPoints >= 0 ? '+' : ''}${entry.deltaPoints.toFixed(0)} pts`}
              </b>
            </div>
          ))}
        </div>
      ) : (
        <p className="empty-note">
          Enter a visible 5h or weekly app meter value to start calibration history.
        </p>
      )}
      <div className="settings-actions">
        <button
          type="button"
          onClick={onClear}
          disabled={entries.length === 0}
        >
          Clear Logbook
        </button>
      </div>
    </section>
  )
}

function StatusPill({
  label,
  tone,
}: {
  label: string
  tone: 'known' | 'estimated' | 'warning' | 'danger'
}) {
  return <span className={`status-pill ${tone}`}>{label}</span>
}

function ConfidenceTile({
  label,
  value,
  detail,
  footer,
}: {
  label: string
  value: string | number
  detail: string
  footer?: string
}) {
  return (
    <div className="confidence-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
      {footer ? <small>{footer}</small> : null}
    </div>
  )
}

function formatConfidenceText(confidence?: DataConfidence | null): string {
  if (!confidence) {
    return 'No confidence metadata'
  }
  return `${confidence.level} (${Math.round(confidence.score * 100)}%)`
}

function buildCalibrationInsights(entries: CalibrationEntry[]): CalibrationInsight[] {
  return (['primary', 'weekly'] as const).map((meter) => {
    const samples = entries.filter(
      (entry) =>
        entry.meter === meter &&
        typeof entry.deltaPoints === 'number' &&
        Number.isFinite(entry.deltaPoints),
    )
    const sampleCount = samples.length
    const latestDeltaPoints = samples.at(0)?.deltaPoints ?? null

    if (sampleCount < 3) {
      return {
        meter,
        sampleCount,
        meanDeltaPoints: sampleCount === 0
          ? null
          : samples.reduce((sum, sample) => sum + (sample.deltaPoints ?? 0), 0) /
            sampleCount,
        latestDeltaPoints,
        confidence: sampleCount === 0 ? 'none' : 'low',
        summary:
          sampleCount === 0
            ? 'No visible app samples yet.'
            : `Need ${3 - sampleCount} more sample${sampleCount === 2 ? '' : 's'} before drift is meaningful.`,
      }
    }

    const meanDeltaPoints =
      samples.reduce((sum, sample) => sum + (sample.deltaPoints ?? 0), 0) /
      sampleCount
    const variance =
      samples.reduce(
        (sum, sample) => sum + ((sample.deltaPoints ?? 0) - meanDeltaPoints) ** 2,
        0,
      ) / sampleCount
    const standardDeviation = Math.sqrt(variance)
    const confidence: CalibrationConfidence =
      sampleCount >= 10 && standardDeviation <= 6
        ? 'high'
        : sampleCount >= 6 && standardDeviation <= 8
          ? 'medium'
          : 'low'
    const direction =
      Math.abs(meanDeltaPoints) < 1
        ? 'roughly aligned with'
        : meanDeltaPoints > 0
          ? 'usually above'
          : 'usually below'

    return {
      meter,
      sampleCount,
      meanDeltaPoints,
      latestDeltaPoints,
      confidence,
      summary: `Visible app is ${direction} local metadata (${sampleCount} samples, latest ${formatSignedPoints(latestDeltaPoints)}). Auto-correction remains off.`,
    }
  })
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
  const freshness = data?.freshness
  const parseDiagnostics = data?.source.parseDiagnostics
  const lastHourConfidence = data?.windows.lastHour.confidence
  const lastFiveConfidence = data?.windows.lastFiveHours.confidence
  const lastDayConfidence = data?.windows.lastDay.confidence
  const projectedConfidence = data?.rates.weeklyPercent.confidence
  const parseFiles = data?.source.parseDiagnostics.files ?? []

  return (
    <section className="instrument-panel accuracy-panel">
      <div className="panel-heading">
        <h2>Known vs Estimated</h2>
        <span>Portable parser</span>
      </div>
      <div className="sample-confidence">
        <div className="sample-confidence-header">
          <h3>Sample confidence</h3>
          <StatusPill
            tone={freshness?.stale ? 'warning' : 'known'}
            label={freshness?.stale ? 'Stale Data' : 'Live Enough'}
          />
        </div>
        <div className="sample-confidence-grid">
          <ConfidenceTile
            label="Latest event"
            value={
              freshness?.latestEventAgeMinutes === null || freshness?.latestEventAgeMinutes === undefined
                ? 'never'
                : `${Math.round(freshness?.latestEventAgeMinutes ?? 0)}m ago`
            }
            detail={
              freshness?.latestEventAt
                ? `At ${new Date(freshness.latestEventAt).toLocaleTimeString()}`
                : 'No valid events'
            }
          />
          <ConfidenceTile
            label="Last hour coverage"
            value={Math.round(data?.windows.lastHour.coveragePercent ?? 0)}
            detail={`${Math.round(data?.windows.lastHour.observedMinutes ?? 0)}m observed`}
            footer={formatConfidenceText(lastHourConfidence)}
          />
          <ConfidenceTile
            label="5h coverage"
            value={Math.round(data?.windows.lastFiveHours.coveragePercent ?? 0)}
            detail={`${Math.round(data?.windows.lastFiveHours.observedMinutes ?? 0)}m observed`}
            footer={formatConfidenceText(lastFiveConfidence)}
          />
          <ConfidenceTile
            label="24h coverage"
            value={Math.round(data?.windows.lastDay.coveragePercent ?? 0)}
            detail={`${Math.round(data?.windows.lastDay.observedMinutes ?? 0)}m observed`}
            footer={formatConfidenceText(lastDayConfidence)}
          />
          <ConfidenceTile
            label="Projection"
            value={projectedConfidence?.level ?? 'unknown'}
            detail={
              projectedConfidence?.reason ??
              'Waiting for enough weekly usage samples'
            }
          />
          <ConfidenceTile
            label="Parse quality"
            value={`${parseDiagnostics?.parsedLines?.toLocaleString() ?? 0} lines`}
            detail={`${parseDiagnostics?.usedEvents?.toLocaleString() ?? 0} events kept, ${parseDiagnostics?.nonTokenLines?.toLocaleString() ?? 0} non-token lines ignored`}
            footer={`Fallback totals: ${parseDiagnostics?.fallbackTokenSourceUsed?.toLocaleString() ?? 0}`}
          />
          <ConfidenceTile
            label="Scan time"
            value={`${data?.source.scanDurationMs ?? 0}ms`}
            detail={`${data?.source.filesParsed ?? 0} parsed, ${data?.source.filesFromCache ?? 0} cached`}
            footer={`Largest file: ${(data?.source.largestFileLines ?? 0).toLocaleString()} lines`}
          />
          <ConfidenceTile
            label="Scan warnings"
            value={data?.source.warnings.length ?? 0}
            detail={
              data?.source.warnings.length
                ? data.source.warnings[0]
                : 'No scan performance warnings'
            }
          />
        </div>
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
      <DetailsList
        title="Parse Files"
        items={parseFiles.map(formatParseFileSummary)}
      />
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
  settings: AppSettings,
): GaugeAlert[] {
  if (!data) {
    return []
  }

  const alerts = [...data.alerts]
  const primaryMetadataPercent = data.limits.primary.usedPercent ?? 0
  const primaryDelta = visiblePrimaryMeter - primaryMetadataPercent
  const weeklyMetadataPercent = data.limits.secondary.usedPercent ?? 0
  const weeklyDelta = visibleMeter - weeklyMetadataPercent
  const projectionConfidence = data.rates.weeklyPercent.confidence

  if (data.freshness.stale && Number.isFinite(data.freshness.latestEventAgeMinutes)) {
    const staleMinutes = data.freshness.staleMinutes ?? 0
    alerts.unshift({
      id: 'ui-stale-data',
      severity: staleMinutes >= 240 ? 'danger' : 'warning',
      title: 'Stale local samples',
      detail: `No token event in ${Math.round(staleMinutes)} minutes.`,
    })
  }

  if (projectionConfidence.level === 'low' && projectionConfidence.reason) {
    alerts.unshift({
      id: 'ui-projection-noise',
      severity: 'warning',
      title: 'Projection confidence low',
      detail: projectionConfidence.reason,
    })
  }

  if (data.source.scanDurationMs > 3_000 || data.source.warnings.length > 0) {
    alerts.unshift({
      id: 'ui-scan-warning',
      severity: data.source.scanDurationMs > 10_000 ? 'danger' : 'warning',
      title: 'Parser scan warning',
      detail:
        data.source.warnings[0] ??
        `Last usage scan took ${(data.source.scanDurationMs / 1000).toFixed(1)} seconds.`,
    })
  }

  if (Number.isFinite(weeklyDelta) && Math.abs(weeklyDelta) >= settings.mismatchThreshold) {
    alerts.unshift({
      id: 'weekly-meter-mismatch',
      severity: 'warning',
      title: 'Weekly app meter mismatch',
      detail: `Visible weekly meter differs from local metadata by ${weeklyDelta >= 0 ? '+' : ''}${weeklyDelta.toFixed(0)} points.`,
    })
  }

  if (Number.isFinite(primaryDelta) && Math.abs(primaryDelta) >= settings.mismatchThreshold) {
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

function exportDiagnosticsBundle(
  data: UsageData | null,
  settings: AppSettings,
  primaryMeterOverride: string,
  weeklyMeterOverride: string,
  systemChecks: SystemCheck[],
  calibrationHistory: CalibrationEntry[],
  calibrationInsights: CalibrationInsight[],
) {
  if (!data) {
    return
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  downloadFile(
    `tokometer-diagnostics-${timestamp}.json`,
    JSON.stringify(
      createDiagnosticsBundle(
        data,
        settings,
        primaryMeterOverride,
        weeklyMeterOverride,
        systemChecks,
        calibrationHistory,
        calibrationInsights,
      ),
      null,
      2,
    ),
    'application/json',
  )
}

function createDiagnosticsBundle(
  data: UsageData,
  settings: AppSettings,
  primaryMeterOverride: string,
  weeklyMeterOverride: string,
  systemChecks: SystemCheck[],
  calibrationHistory: CalibrationEntry[],
  calibrationInsights: CalibrationInsight[],
) {
  return {
    schema: diagnosticsSchema,
    exportedAt: new Date().toISOString(),
    privacy:
      'This bundle excludes raw JSONL log lines and full session identifiers.',
    app: {
      name: 'Tokometer',
      version: appVersion,
      releaseChannel,
      mode: import.meta.env.MODE,
      userAgent: window.navigator.userAgent,
    },
    settings,
    meterOverrides: {
      primary:
        primaryMeterOverride === '' ? null : clamp(Number(primaryMeterOverride)),
      weekly:
        weeklyMeterOverride === '' ? null : clamp(Number(weeklyMeterOverride)),
    },
    source: {
      codexHome: redactPath(data.source.codexHome),
      dataDir: redactPath(data.source.dataDir),
      filesScanned: data.source.filesScanned,
      scanDurationMs: data.source.scanDurationMs,
      filesParsed: data.source.filesParsed,
      filesFromCache: data.source.filesFromCache,
      largestFileLines: data.source.largestFileLines,
      warnings: data.source.warnings,
      eventsFound: data.source.eventsFound,
      sessionsFound: data.source.sessionsFound,
      rawTokenRecords: data.source.rawTokenRecords,
      ignoredEvents: data.source.ignoredEvents,
      generatedAt: data.source.generatedAt,
    },
    limits: data.limits,
    windows: {
      lastHour: summarizeWindowForDiagnostics(data.windows.lastHour),
      lastFiveHours: summarizeWindowForDiagnostics(data.windows.lastFiveHours),
      lastDay: summarizeWindowForDiagnostics(data.windows.lastDay),
      observedAll: summarizeWindowForDiagnostics(data.windows.observedAll),
    },
    rates: data.rates,
    freshness: data.freshness,
    parseDiagnostics: {
      ...data.source.parseDiagnostics,
      files: data.source.parseDiagnostics.files.map((file, index) => ({
        file: `file-${index + 1}.jsonl`,
        parsedLines: file.parsedLines,
        nonTokenLines: file.nonTokenLines,
        malformedLines: file.malformedLines,
        parseFailures: file.parseFailures,
        tokenRecords: file.tokenRecords,
        usedEvents: file.usedEvents,
        fallbackTokenSourceUsed: file.fallbackTokenSourceUsed,
      })),
    },
    systemChecks,
    calibrationHistory: calibrationHistory.slice(0, 30),
    calibrationInsights,
    alerts: data.alerts,
    accuracy: data.accuracy,
  }
}

function summarizeWindowForDiagnostics(window: WindowSummary) {
  return {
    totalTokens: window.totalTokens,
    activeTokens: window.activeTokens,
    eventCount: window.eventCount,
    observedMinutes: window.observedMinutes,
    coveragePercent: window.coveragePercent,
    confidence: window.confidence,
  }
}

function createMarkdownReport(data: UsageData) {
  const fileSummaries = data.source.parseDiagnostics.files.map(formatParseFileSummary)
  return [
    '# Tokometer Report',
    '',
    `Version: v${appVersion} (${releaseChannel})`,
    `Generated: ${data.source.generatedAt}`,
    `Codex home: ${data.source.codexHome}`,
    `History store: ${data.source.dataDir}`,
    `Scan: ${data.source.scanDurationMs}ms; ${data.source.filesParsed} files parsed, ${data.source.filesFromCache} from cache, largest file ${data.source.largestFileLines} lines`,
    '',
    '## Limits',
    '',
    `- 5h window: ${formatPercent(data.limits.primary.usedPercent)}; resets ${formatDate(data.limits.primary.resetsAt)}`,
    `- Weekly window: ${formatPercent(data.limits.secondary.usedPercent)}; resets ${formatDate(data.limits.secondary.resetsAt)}`,
    `- Projection: ${formatProjection(data)}`,
    `- Weekly trend confidence: ${data.rates.weeklyPercent.confidence.level} (${(data.rates.weeklyPercent.confidence.score * 100).toFixed(0)}%) - ${data.rates.weeklyPercent.confidence.reason}`,
    `- Latest sample age: ${data.freshness.latestEventAgeMinutes ?? 0}m`,
    `- Parse lines: ${data.source.parseDiagnostics.parsedLines} parsed, ${data.source.parseDiagnostics.nonTokenLines} non-token, ${data.source.parseDiagnostics.malformedLines} malformed, ${data.source.parseDiagnostics.parseFailures} parse failures`,
    `- Ignored samples: ${data.source.parseDiagnostics.ignoredEvents} (${data.source.parseDiagnostics.resetEvents} resets, ${data.source.parseDiagnostics.anomalousDeltas} anomalies)`,
    `- Scan warnings: ${data.source.warnings.length ? data.source.warnings.join(' ') : 'None'}`,
    '',
    '## Parse File Summary',
    ...fileSummaries.map((item) => `- ${item}`),
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

function formatSignedPoints(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'unknown'
  }
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} pts`
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

function formatDateTime(value?: string | null) {
  if (!value) {
    return 'Never'
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
    return `No trend (${projection?.confidence.level ?? 'unknown'} confidence)`
  }
  if (projection.percentPerHour === 0) {
    return `Stable (${projection.confidence.level} confidence)`
  }
  return projection.projectedExhaustAt
    ? `${formatDate(projection.projectedExhaustAt)} (${projection.confidence.level} confidence)`
    : `${projection.percentPerHour.toFixed(2)}%/hr (${projection.confidence.level} confidence)`
}

function policyLabel(policy: AnomalyPolicy): string {
  return policy === 'strict'
    ? 'Strict'
    : policy === 'relaxed'
      ? 'Relaxed'
      : 'Normal'
}

function recommendAnomalyPolicy(
  data: UsageData | null,
): AnomalyPolicyRecommendation | null {
  if (!data) {
    return null
  }

  if (data.freshness.staleMinutes !== null && data.freshness.staleMinutes >= 180) {
    return null
  }

  const diagnostics = data.source.parseDiagnostics
  const sampleCount = data.source.ignoredEvents + data.source.eventsFound
  const tokenCandidateLines = Math.max(
    1,
    diagnostics.tokenRecords +
      diagnostics.malformedLines +
      diagnostics.parseFailures,
  )
  const parseIssueRatio = Math.min(
    1,
    (diagnostics.malformedLines + diagnostics.parseFailures) /
      tokenCandidateLines,
  )
  const ignoredRatio = Math.min(
    1,
    diagnostics.ignoredEvents / Math.max(1, sampleCount),
  )

  if (
    sampleCount < 10 ||
    diagnostics.tokenRecords < 10 ||
    data.windows.lastHour.eventCount + data.windows.lastFiveHours.eventCount < 5
  ) {
    return null
  }

  const lastHourCoverage = data.windows.lastHour.coveragePercent
  const fiveHourCoverage = data.windows.lastFiveHours.coveragePercent
  const dayCoverage = data.windows.lastDay.coveragePercent
  const isCoverageSparse =
    lastHourCoverage < 20 || fiveHourCoverage < 30 || dayCoverage < 20
  const isSignalWeak =
    data.rates.lastHourRateConfidence.level === 'low' ||
    data.rates.lastFiveHoursRateConfidence.level === 'low' ||
    data.rates.lastDayRateConfidence.level === 'low'
  const isFreshEnough = (data.freshness.latestEventAgeMinutes ?? 0) <= 90

  if (ignoredRatio >= 0.22 || parseIssueRatio >= 0.18 || isSignalWeak || isCoverageSparse) {
    return {
      policy: 'strict',
      reason: 'Recent samples contain noisy drops or malformed data, so filtering should be stricter.',
      ignoredRatio,
      parseIssueRatio,
    }
  }

  if (
    ignoredRatio <= 0.05 &&
    parseIssueRatio <= 0.02 &&
    data.source.ignoredEvents === 0 &&
    isFreshEnough &&
    lastHourCoverage >= 85 &&
    fiveHourCoverage >= 60 &&
    dayCoverage >= 40 &&
    data.rates.lastHourRateConfidence.level === 'high' &&
    data.rates.lastFiveHoursRateConfidence.level === 'high'
  ) {
    return {
      policy: 'relaxed',
      reason:
        'Your stream is clean and stable with high local burn confidence, so strict filtering may be unnecessary.',
      ignoredRatio,
      parseIssueRatio,
    }
  }

  return {
    policy: 'normal',
    reason:
      'Current signal quality is mostly steady; the balanced anomaly policy is a good middle ground.',
    ignoredRatio,
    parseIssueRatio,
  }
}

function buildSystemChecks(
  data: UsageData | null,
  settings: AppSettings,
  primaryMeterOverride: string,
  weeklyMeterOverride: string,
): SystemCheck[] {
  if (!data) {
    return [
      {
        id: 'usage-payload',
        label: 'Usage API',
        status: 'fail',
        detail: 'No usage payload has loaded yet.',
      },
    ]
  }

  const parseDiagnostics = data.source.parseDiagnostics
  const tokenCandidateLines = Math.max(
    1,
    parseDiagnostics.tokenRecords +
      parseDiagnostics.malformedLines +
      parseDiagnostics.parseFailures,
  )
  const parseIssueRatio =
    (parseDiagnostics.malformedLines + parseDiagnostics.parseFailures) /
    tokenCandidateLines
  const ignoredRatio =
    data.source.ignoredEvents /
    Math.max(1, data.source.eventsFound + data.source.ignoredEvents)
  const latestAge = data.freshness.latestEventAgeMinutes
  const hasBothOverrides =
    primaryMeterOverride.trim() !== '' && weeklyMeterOverride.trim() !== ''

  return [
    {
      id: 'codex-log-path',
      label: 'Codex log path',
      status: data.source.filesScanned > 0 ? 'pass' : 'fail',
      detail:
        data.source.filesScanned > 0
          ? `${data.source.filesScanned} JSONL files scanned.`
          : `No JSONL files found under ${data.source.codexHome}.`,
    },
    {
      id: 'token-events',
      label: 'Token events',
      status:
        data.source.eventsFound > 0
          ? 'pass'
          : data.source.rawTokenRecords > 0
            ? 'warn'
            : 'fail',
      detail:
        data.source.eventsFound > 0
          ? `${data.source.eventsFound.toLocaleString()} usable local deltas from ${data.source.rawTokenRecords.toLocaleString()} token records.`
          : 'No usable token deltas are available yet.',
    },
    {
      id: 'history-store',
      label: 'History store',
      status: data.history.latest ? 'pass' : 'warn',
      detail: data.history.latest
        ? `${data.history.samples.length.toLocaleString()} local snapshots retained.`
        : `No history sample written yet in ${data.source.dataDir}.`,
    },
    {
      id: 'parser-quality',
      label: 'Parser quality',
      status:
        parseIssueRatio >= 0.15 || ignoredRatio >= 0.25
          ? 'fail'
          : parseIssueRatio >= 0.04 || ignoredRatio >= 0.12
            ? 'warn'
            : 'pass',
      detail: `${Math.round(parseIssueRatio * 100)}% parse issues, ${Math.round(
        ignoredRatio * 100,
      )}% ignored/reset/anomaly samples.`,
    },
    {
      id: 'scan-performance',
      label: 'Scan performance',
      status:
        data.source.scanDurationMs > 10_000
          ? 'fail'
          : data.source.scanDurationMs > 3_000 || data.source.warnings.length > 0
            ? 'warn'
            : 'pass',
      detail: `${data.source.scanDurationMs}ms scan; ${data.source.filesFromCache}/${data.source.filesScanned} files reused from cache, largest file ${data.source.largestFileLines.toLocaleString()} lines.`,
    },
    {
      id: 'freshness',
      label: 'Freshness',
      status:
        latestAge === null
          ? 'fail'
          : latestAge > 240
            ? 'fail'
            : latestAge > Math.max(120, settings.refreshSeconds * 3 / 60)
              ? 'warn'
              : 'pass',
      detail:
        latestAge === null
          ? 'No token event timestamp found.'
          : `Latest token event was ${Math.round(latestAge)} minutes ago.`,
    },
    {
      id: 'rate-confidence',
      label: 'Rate confidence',
      status:
        data.rates.lastHourRateConfidence.level === 'low' &&
        data.rates.lastFiveHoursRateConfidence.level === 'low'
          ? 'warn'
          : 'pass',
      detail: `Last hour ${data.rates.lastHourRateConfidence.level}; 5h ${data.rates.lastFiveHoursRateConfidence.level}.`,
    },
    {
      id: 'visible-meter-calibration',
      label: 'App meter calibration',
      status: hasBothOverrides ? 'pass' : 'warn',
      detail: hasBothOverrides
        ? 'Both visible app meter overrides are set for mismatch tracking.'
        : 'Set visible 5h and weekly app meters to track local-vs-app drift.',
    },
  ]
}

function summarizeSystemChecks(checks: SystemCheck[]): {
  label: string
  tone: 'known' | 'warning' | 'danger'
} {
  if (checks.some((check) => check.status === 'fail')) {
    return { label: 'Needs Setup', tone: 'danger' }
  }
  if (checks.some((check) => check.status === 'warn')) {
    return { label: 'Needs Review', tone: 'warning' }
  }
  return { label: 'Ready', tone: 'known' }
}

function shortSession(sessionId: string) {
  const parts = sessionId.split('-')
  if (parts.length < 5) {
    return sessionId.slice(0, 18)
  }
  return `${parts[0]} ${parts.at(-1)?.slice(0, 8)}`
}

function shortParsePath(filePath: string) {
  const normalized = filePath.trim().replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 2) {
    return filePath
  }

  return `${parts.at(-2)}/${parts.at(-1)}`
}

function redactPath(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/')
  const homeLike = normalized.match(/^([A-Z]:)?\/Users\/([^/]+)/i)
  if (homeLike) {
    return normalized.replace(homeLike[0], `${homeLike[1] ?? ''}/Users/<user>`)
  }
  return normalized.replace(/^\/home\/[^/]+/i, '/home/<user>')
}

function formatParseFileSummary(file: ParseFileHealth) {
  const ignored = file.tokenRecords - file.usedEvents
  const malformed = file.malformedLines
  const parseFailures = file.parseFailures
  const quality = Math.round(
    (file.usedEvents / Math.max(1, file.tokenRecords)) * 100,
  )

  return `${shortParsePath(file.file)}: parsed ${file.parsedLines.toLocaleString()} lines, non-token ${file.nonTokenLines.toLocaleString()}, token records ${file.tokenRecords.toLocaleString()} (${quality}% kept), kept ${file.usedEvents.toLocaleString()}, ignored ${ignored.toLocaleString()}, fallback ${file.fallbackTokenSourceUsed.toLocaleString()}, malformed ${malformed.toLocaleString()}, parse failures ${parseFailures.toLocaleString()}`
}

function clamp(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(100, value))
}

function boundNumber(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.max(min, Math.min(max, value))
}

function resolveVisibleMeter(override: string, metadataPercent: number) {
  if (override === '') {
    return metadataPercent
  }

  const parsed = Number(override)
  return Number.isFinite(parsed) ? clamp(parsed) : metadataPercent
}

function loadSettings(): AppSettings {
  const storedSettings = window.localStorage.getItem(settingsStorageKey)
  if (!storedSettings) {
    return defaultSettings
  }

  try {
    const parsed = JSON.parse(storedSettings) as Partial<AppSettings>
    return {
      refreshSeconds: boundNumber(
        Number(parsed.refreshSeconds),
        15,
        600,
        defaultSettings.refreshSeconds,
      ),
      dangerThreshold: boundNumber(
        Number(parsed.dangerThreshold),
        50,
        100,
        defaultSettings.dangerThreshold,
      ),
      mismatchThreshold: boundNumber(
        Number(parsed.mismatchThreshold),
        1,
        50,
        defaultSettings.mismatchThreshold,
      ),
      activeBurnScale: boundNumber(
        Number(parsed.activeBurnScale),
        10_000,
        10_000_000,
        defaultSettings.activeBurnScale,
      ),
      anomalyPolicy:
        parsed.anomalyPolicy === 'strict' ||
        parsed.anomalyPolicy === 'normal' ||
        parsed.anomalyPolicy === 'relaxed'
          ? parsed.anomalyPolicy
          : defaultSettings.anomalyPolicy,
    }
  } catch {
    return defaultSettings
  }
}

function loadCalibrationHistory(): CalibrationEntry[] {
  const storedHistory = window.localStorage.getItem(calibrationHistoryStorageKey)
  if (!storedHistory) {
    return []
  }

  try {
    const parsed = JSON.parse(storedHistory)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed
      .flatMap((entry): CalibrationEntry[] => {
        if (!entry || typeof entry !== 'object') {
          return []
        }

        const candidate = entry as Partial<CalibrationEntry>
        if (
          typeof candidate.id !== 'string' ||
          typeof candidate.timestamp !== 'string' ||
          (candidate.meter !== 'primary' && candidate.meter !== 'weekly') ||
          typeof candidate.visiblePercent !== 'number'
        ) {
          return []
        }

        return [
          {
            id: candidate.id,
            timestamp: candidate.timestamp,
            meter: candidate.meter,
            visiblePercent: clamp(candidate.visiblePercent),
            metadataPercent:
              typeof candidate.metadataPercent === 'number'
                ? candidate.metadataPercent
                : null,
            deltaPoints:
              typeof candidate.deltaPoints === 'number'
                ? candidate.deltaPoints
                : null,
            generatedAt:
              typeof candidate.generatedAt === 'string'
                ? candidate.generatedAt
                : null,
          },
        ]
      })
      .slice(0, calibrationHistoryLimit)
  } catch {
    return []
  }
}

function quoteShellValue(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`
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
