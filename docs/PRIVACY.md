# Tokometer Privacy

Tokometer is local-first. It reads Codex metadata from your computer and does not
send logs or diagnostics to OpenAI, GitHub, or any external service.

## What Tokometer Reads

- Codex JSONL session files under the detected Codex home directory.
- `token_count` events inside those JSONL files.
- Rate-limit metadata attached to those events, when present.
- Tokometer local settings stored in browser localStorage.
- Tokometer history snapshots stored in the local app data folder.

## What Tokometer Ignores

- Non-token JSONL lines, including normal conversation and tool event records.
- Prompt text, assistant replies, and tool outputs.
- Raw session content that is not needed to calculate token counters.
- Any file outside the detected Codex session folders unless you explicitly point
  Tokometer at another Codex home path.

## What Diagnostics Export

The diagnostics bundle is redacted and previewed before download. It includes:

- App version and local runtime metadata.
- Redacted Codex and history paths.
- Scan timing, file counts, parser cache metrics, and scan warnings.
- Parser health totals, with per-file names replaced by `file-1.jsonl`,
  `file-2.jsonl`, and so on.
- Window totals, rate confidence, freshness, and alert metadata.
- System Check results.
- Calibration sample summaries and drift confidence.

## What Diagnostics Never Export

- Raw JSONL log lines.
- Conversation text, prompts, assistant replies, or tool outputs.
- Full session identifiers.
- API keys, auth tokens, environment variables, or payment details.
- Network requests to OpenAI or any other external API.

## Filing Issues Safely

Start with the Support Bundle Preview in the app. If you need to share a report,
attach the downloaded diagnostics JSON instead of raw Codex logs. For meter
mismatch reports, include your visible 5h and weekly percentages and the time you
recorded them.
