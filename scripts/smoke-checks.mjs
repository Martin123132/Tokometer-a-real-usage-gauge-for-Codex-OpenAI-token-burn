import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { getUsageSummary } from '../server/usage.ts'

const mismatchThreshold = 8

function tokenLine(timestamp, buckets, primaryUsed, secondaryUsed) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model_context_window: 258400,
        total_token_usage: buckets.total,
        last_token_usage: buckets.last,
      },
      rate_limits: {
        primary: {
          used_percent: primaryUsed,
          window_minutes: 300,
          resets_at: 1780000000,
        },
        secondary: {
          used_percent: secondaryUsed,
          window_minutes: 10080,
          resets_at: 1780175065,
        },
        plan_type: 'prolite',
      },
    },
  })
}

function bucket(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens = undefined) {
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
  }
}

async function createFixture(lines) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tokometer-smoke-'))
  const codexHome = path.join(root, '.codex')
  const dataDir = path.join(root, 'data')
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '25')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(path.join(sessionDir, 'rollout-smoke-session.jsonl'), `${lines.join('\n')}\n`)

  return {
    codexHome,
    dataDir,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function printSummary(name, pass, detail) {
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}: ${detail}`)
}

async function runScenario(name, lines, nowIso, validator, options = {}) {
  const { codexHome, dataDir, cleanup } = await createFixture(lines)
  try {
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse(nowIso),
      writeHistory: false,
      useCache: false,
      ...options,
    })

    validator(summary)
    printSummary(name, true, `latest event ${summary.freshness.latestEventAgeMinutes}m ago`)
  } catch (error) {
    printSummary(name, false, error.message)
  } finally {
    await cleanup()
  }
}

async function runEmptyCodexScenario() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tokometer-smoke-empty-'))
  const codexHome = path.join(root, '.codex')
  const dataDir = path.join(root, 'data')

  try {
    await mkdir(codexHome, { recursive: true })
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse('2026-05-25T10:30:00.000Z'),
      writeHistory: false,
      useCache: false,
    })

    assert(summary.source.filesScanned === 0, 'expected no discovered JSONL files')
    assert(summary.source.eventsFound === 0, 'expected no usage events')
    assert(summary.freshness.latestEventAt === null, 'expected no latest event')
    assert(
      summary.source.warnings.some((warning) => warning.includes('No Codex JSONL')),
      'expected no-log scan warning',
    )
    printSummary(
      'first-run empty Codex home',
      true,
      'UI check: this payload should show First Run Check with setup failures',
    )
  } catch (error) {
    printSummary('first-run empty Codex home', false, error.message)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function run() {
  await runEmptyCodexScenario()

  await runScenario(
    'stale log file',
    [
      tokenLine(
        '2026-05-25T09:00:00.000Z',
        {
          total: bucket(120, 30, 20, 10, 180),
          last: bucket(120, 30, 20, 10, 180),
        },
        40,
        80,
      ),
    ],
    '2026-05-25T13:30:00.000Z',
    (summary) => {
      assert(summary.freshness.stale === true, 'expected stale=true')
      assert(summary.freshness.staleMinutes >= 240, 'expected stale window >= 240m')
      assert(
        summary.alerts.some((alert) => alert.id === 'local-stale-critical'),
        'expected local-stale-critical alert',
      )
    },
  )

  await runScenario(
    'policy variance in burst handling',
    [
      tokenLine(
        '2026-05-25T10:00:00.000Z',
        {
          total: bucket(1_000, 200, 50, 10, 1_260),
          last: bucket(1_000, 200, 50, 10, 1_260),
        },
        30,
        47,
      ),
      tokenLine(
        '2026-05-25T10:01:00.000Z',
        {
          total: bucket(301_000, 200, 50, 10, 301_260),
          last: bucket(301_000, 200, 50, 10, 301_260),
        },
        32,
        48,
      ),
      tokenLine(
        '2026-05-25T10:02:00.000Z',
        {
          total: bucket(301_250, 200, 70, 10, 301_320),
          last: bucket(301_250, 200, 70, 10, 301_320),
        },
        33,
        48,
      ),
    ],
    '2026-05-25T10:10:00.000Z',
    (summary) => {
      assert(summary.source.parseDiagnostics.anomalousDeltas >= 1, 'expected strict-like anomaly suppression by default policy')
      assert(summary.source.ignoredEvents >= 1, 'expected at least one ignored burst sample')
      assert(summary.windows.lastHour.totalTokens > 0, 'expected observed post-burst delta')
    },
    { anomalyPolicy: 'normal' },
  )

  await runScenario(
    'policy relaxed keeps burst sample',
    [
      tokenLine(
        '2026-05-25T10:00:00.000Z',
        {
          total: bucket(1_000, 200, 50, 10, 1_260),
          last: bucket(1_000, 200, 50, 10, 1_260),
        },
        30,
        47,
      ),
      tokenLine(
        '2026-05-25T10:01:00.000Z',
        {
          total: bucket(301_000, 200, 50, 10, 301_260),
          last: bucket(301_000, 200, 50, 10, 301_260),
        },
        32,
        48,
      ),
      tokenLine(
        '2026-05-25T10:02:00.000Z',
        {
          total: bucket(301_250, 200, 70, 10, 301_320),
          last: bucket(301_250, 200, 70, 10, 301_320),
        },
        33,
        48,
      ),
    ],
    '2026-05-25T10:10:00.000Z',
    (summary) => {
      assert(summary.source.parseDiagnostics.anomalousDeltas === 0, 'expected relaxed policy to keep burst sample')
      assert(summary.source.parseDiagnostics.resetEvents === 0, 'expected no reset classification in relaxed mode')
      assert(summary.source.ignoredEvents === 0, 'expected full burst visibility with relaxed policy')
      assert(summary.windows.lastHour.totalTokens > 150_000, 'expected large retained burst delta')
    },
    { anomalyPolicy: 'relaxed' },
  )

  await runScenario(
    'rapid burst',
    [
      tokenLine(
        '2026-05-25T10:00:00.000Z',
        {
          total: bucket(1_000, 500, 200, 20, 1_720),
          last: bucket(1_000, 500, 200, 20, 1_720),
        },
        35,
        65,
      ),
      tokenLine(
        '2026-05-25T10:00:30.000Z',
        {
          total: bucket(1_150_000, 500, 200, 20, 1_150_720),
          last: bucket(1_150_000, 500, 200, 20, 1_150_720),
        },
        36,
        66,
      ),
      tokenLine(
        '2026-05-25T10:01:00.000Z',
        {
          total: bucket(1_080, 500, 230, 20, 1_630),
          last: bucket(1_080, 500, 230, 20, 1_630),
        },
        36,
        66,
      ),
      tokenLine(
        '2026-05-25T10:02:00.000Z',
        {
          total: bucket(1_200, 520, 240, 22, 1_782),
          last: bucket(1_200, 520, 240, 22, 1_782),
        },
        37,
        67,
      ),
    ],
    '2026-05-25T10:10:00.000Z',
    (summary) => {
      assert(summary.source.parseDiagnostics.anomalousDeltas >= 1, 'expected anomalous spike detection')
      assert(summary.source.parseDiagnostics.resetEvents >= 1, 'expected reset detection after spike')
      assert(summary.source.eventsFound === 1, 'expected one stable event delta after burst window')
      assert(summary.rates.lastHourTokensPerHour < 10_000, 'burst should be damped to realistic rate')
      assert(summary.windows.lastHour.totalTokens === 152, 'expected burst-denoised token delta to be 152')
    },
  )

  await runScenario(
    'cached vs active mix',
    [
      tokenLine(
        '2026-05-25T10:00:00.000Z',
        {
          total: bucket(10_000, 9_300, 180, 20, 10_200),
          last: bucket(10_000, 9_300, 180, 20, 10_200),
        },
        20,
        60,
      ),
      tokenLine(
        '2026-05-25T10:10:00.000Z',
        {
          total: bucket(10_800, 9_940, 190, 22, 11_012),
          last: bucket(10_800, 9_940, 190, 22, 11_012),
        },
        22,
        61,
      ),
      tokenLine(
        '2026-05-25T10:20:00.000Z',
        {
          total: bucket(11_600, 10_580, 200, 24, 11_824),
          last: bucket(11_600, 10_580, 200, 24, 11_824),
        },
        24,
        62,
      ),
      tokenLine(
        '2026-05-25T10:30:00.000Z',
        {
          total: bucket(12_400, 11_220, 210, 26, 12_636),
          last: bucket(12_400, 11_220, 210, 26, 12_636),
        },
        26,
        63,
      ),
      tokenLine(
        '2026-05-25T10:40:00.000Z',
        {
          total: bucket(13_200, 11_860, 220, 28, 13_448),
          last: bucket(13_200, 11_860, 220, 28, 13_448),
        },
        28,
        64,
      ),
      tokenLine(
        '2026-05-25T10:50:00.000Z',
        {
          total: bucket(14_000, 12_500, 230, 30, 14_260),
          last: bucket(14_000, 12_500, 230, 30, 14_260),
        },
        30,
        65,
      ),
    ],
    '2026-05-25T11:00:00.000Z',
    (summary) => {
      assert(summary.windows.lastHour.totalTokens === 4_060, 'expected cached/non-cached delta total to be 4,060')
      assert(summary.windows.lastHour.cachedInputTokens === 3_200, 'expected cached input to dominate')
      assert(summary.windows.lastHour.activeTokens === 860, 'expected active (uncached+out+reason) to stay small')
      assert(summary.rates.lastHourRateConfidence.level === 'medium', 'expected medium confidence with dense minute-level samples')
    },
  )

  await runScenario(
    'manual mismatch math check',
    [
      tokenLine(
        '2026-05-25T10:00:00.000Z',
        {
          total: bucket(5_000, 4_000, 100, 40, 5_140),
          last: bucket(5_000, 4_000, 100, 40, 5_140),
        },
        42,
        81,
      ),
      tokenLine(
        '2026-05-25T10:15:00.000Z',
        {
          total: bucket(6_000, 4_900, 150, 42, 6_192),
          last: bucket(6_000, 4_900, 150, 42, 6_192),
        },
        45,
        84,
      ),
    ],
    '2026-05-25T10:30:00.000Z',
    (summary) => {
      const weeklyOverride = 92
      const primaryOverride = 88
      const weeklyDelta = Math.abs(weeklyOverride - (summary.limits.secondary.usedPercent ?? 0))
      const primaryDelta = Math.abs(primaryOverride - (summary.limits.primary.usedPercent ?? 0))
      assert(
        weeklyDelta >= mismatchThreshold,
        `expected weekly override mismatch >= ${mismatchThreshold}`,
      )
      assert(
        primaryDelta >= mismatchThreshold,
        `expected primary override mismatch >= ${mismatchThreshold}`,
      )
      console.log(
        `   weekly override mismatch: ${weeklyDelta.toFixed(0)} pts, primary mismatch: ${primaryDelta.toFixed(0)} pts`,
      )
      console.log(
        `   UI check: set Weekly App Meter=${weeklyOverride} and 5h App Meter=${primaryOverride} in dashboard to trigger both mismatch alerts.`,
      )
    },
  )

  await runScenario(
    'large non-token-heavy log',
    [
      ...Array.from({ length: 25_000 }, (_, index) =>
        JSON.stringify({
          timestamp: new Date(
            Date.parse('2026-05-25T09:00:00.000Z') + index * 1000,
          ).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            id: `smoke-message-${index}`,
          },
        }),
      ),
      tokenLine(
        '2026-05-25T10:00:00.000Z',
        {
          total: bucket(1_000, 400, 120, 20, 1_140),
          last: bucket(1_000, 400, 120, 20, 1_140),
        },
        35,
        70,
      ),
      tokenLine(
        '2026-05-25T10:10:00.000Z',
        {
          total: bucket(1_900, 820, 150, 24, 2_074),
          last: bucket(1_900, 820, 150, 24, 2_074),
        },
        37,
        72,
      ),
      tokenLine(
        '2026-05-25T10:20:00.000Z',
        {
          total: bucket(2_700, 1_180, 190, 30, 2_920),
          last: bucket(2_700, 1_180, 190, 30, 2_920),
        },
        39,
        74,
      ),
    ],
    '2026-05-25T10:30:00.000Z',
    (summary) => {
      assert(summary.source.parseDiagnostics.nonTokenLines === 25_000, 'expected non-token lines to be skipped cleanly')
      assert(summary.source.parseDiagnostics.malformedLines === 0, 'expected no malformed lines from ordinary non-token JSONL')
      assert(summary.source.largestFileLines === 25_003, 'expected largest file line metric')
      assert(summary.source.filesParsed === 1, 'expected one freshly parsed file')
      assert(summary.source.scanDurationMs >= 0, 'expected scan timing metric')
      assert(
        summary.source.warnings.some((warning) => warning.includes('non-token JSONL lines')),
        'expected large non-token scan warning',
      )
      assert(summary.windows.lastHour.totalTokens === 1_780, 'expected token deltas to survive large non-token scan')
    },
  )

  console.log('UI smoke checklist:')
  console.log('   - First Run Check appears for the empty Codex home payload.')
  console.log('   - Healthy System Check appears after valid token_count fixtures load.')
  console.log('   - Diagnostics opens Support Bundle Preview before downloading.')
  console.log('   - Calibration Logbook shows sample count, mean drift, latest drift, and confidence.')
}

run().catch((error) => {
  console.error(`Smoke checks failed: ${error.message}`)
  process.exit(1)
})
