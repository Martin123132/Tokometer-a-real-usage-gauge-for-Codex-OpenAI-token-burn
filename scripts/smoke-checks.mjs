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

async function runScenario(name, lines, nowIso, validator) {
  const { codexHome, dataDir, cleanup } = await createFixture(lines)
  try {
    const summary = await getUsageSummary({
      codexHome,
      dataDir,
      now: Date.parse(nowIso),
      writeHistory: false,
      useCache: false,
    })

    validator(summary)
    printSummary(name, true, `latest event ${summary.freshness.latestEventAgeMinutes}m ago`)
  } catch (error) {
    printSummary(name, false, error.message)
  } finally {
    await cleanup()
  }
}

async function run() {
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
}

run().catch((error) => {
  console.error(`Smoke checks failed: ${error.message}`)
  process.exit(1)
})
