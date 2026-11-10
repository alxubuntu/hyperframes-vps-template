Status: in-progress
Created: 2026-11-10
Updated: 2026-11-10
Touches: src/lib/server/render-jobs.mjs, src/lib/server/render-jobs.d.mts, src/lib/server/render-jobs.test.ts, src/routes/api/render-status.ts, src/routes/api/render.schema.ts, src/components/RenderControls.tsx, docs/render-api.md
Depends on: —
Supersedes: —

# 0002 — Render progress and diagnostics

## Goal

Expose the current render phase, its percentage when measurable, and the last
observed activity through the existing status API and UI. Do not invent a total
percentage or mistake a quiet process for a failed render.

No new queue, database, streaming endpoint, renderer upgrade, automatic retry,
or inactivity cancellation is included. Keep the existing total render timeout.

## 1. Verify the renderer's signals first

Inspection note: the published `hyperframes@0.4.14` CLI writes CR-delimited
progress to stdout even when piped. Its displayed percentage is an internally
weighted total, so this implementation does not expose it. The `Capturing`,
`Streaming`, and `HDR composite frame N/total` messages use global captured
counts, including parallel workers. CLI output has not yet been verified on the
deployed instance for this change.

Inspect the exact deployed HyperFrames version and its output. The repository
currently pins `hyperframes` to `0.4.14` in `renderer/package.json`.

Determine whether it exposes structured events, frame counts, percentages, or
phase changes; which stream carries them; and whether output differs when piped
or when multiple workers run. Prefer supported structured output when available.
Do not assume that a flag or event from a newer release exists in this version.

Record representative output as sanitized test fixtures. Define a supported
signal-to-phase mapping before implementation. If no reliable percentage exists,
ship phases and activity information with a null percentage instead. Surface
`unknown` when the renderer gives no evidence of its current phase.

Verify against the deployed instance or inspect code and pure modules; do not
start a local server to check this feature. A percentage is conditional on this
investigation, not a promised capability of the pinned renderer.

## 2. Add an explicit, backward-compatible status contract

Keep `queued`, `running`, `completed`, and `failed`. Add these fields to newly
created jobs and normalize missing fields when reading older jobs:

```json
{
  "status": "running",
  "phase": "rendering",
  "phaseProgress": 45,
  "startedAt": "2026-11-10T02:30:44.000Z",
  "lastActivityAt": "2026-11-10T02:30:50.000Z",
  "progressUpdatedAt": "2026-11-10T02:30:49.000Z"
}
```

- `phase`: `queued`, `preparing`, `rendering`, `encoding`, `finalizing`,
  `completed`, or `unknown`. Only report renderer phases proven by its signals;
  the manager can report its own preparation and finalization directly.
- `phaseProgress`: number from 0 to 100 or null, **for the current phase only**.
  Derive it from trustworthy totals and completed work. Do not use elapsed time
  or arbitrary weights to estimate overall completion.
- `startedAt`: execution start, null if unknown or not started. This includes
  preparation and is not a claim about when the existing CLI timeout starts.
- `lastActivityAt`: latest observed renderer output or manager phase transition;
  null if none. Repeated logs may update activity without advancing progress.
- `progressUpdatedAt`: latest confirmed phase transition or numeric progress
  increase, null if none. Do not update it for repeated messages or every poll.

On a phase change, reset its percentage to null unless a new reliable value is
known. Within a phase, reject invalid totals, out-of-range values and regressions.
With multiple workers, use a documented global counter or aggregate identifiable
worker counters without double counting; otherwise leave the percentage null.

Set `phase=completed` and `phaseProgress=100` only after the MP4 has been validated
and moved to its final path. On failure or timeout preserve the last known phase
and percentage alongside `status=failed` and the existing error field. A phase
percentage of 100 by itself never means that the job succeeded.

Return `Cache-Control: no-store` on all status responses, including errors.
Polling stays authenticated through the existing guard. Do not expose raw logs,
asset contents, credentials, or internal filesystem paths as progress data.

## 3. Capture output safely and persist bounded updates

In `runHyperFrames`, consume the relevant stdout and stderr streams and pass
recognized progress events to the job manager through an internal callback.
Extend the injected test renderer with an optional progress callback while
preserving existing two-argument test implementations.

- Parse streams incrementally, handling split chunks, carriage returns, ANSI
  escapes and final unterminated lines as required by the verified format.
- Bound pending parser buffers and retained diagnostic output. Unknown or
  malformed messages must not crash the process or fail an otherwise valid job.
- Keep error diagnostics available on failure without turning raw output into
  public progress messages. Retain the existing timeout and child cleanup logic.
- Update progress in memory promptly. Coalesce progress-only persistence to at
  most once every two seconds per job; do not queue snapshots for every frame.
- Persist job start and terminal states immediately, flush pending progress on
  termination, and cancel scheduled saves so stale updates cannot overwrite a
  terminal state. Make timer callbacks and persistence errors safely handled.
- Restore old jobs using the existing restart policy. Normalize absent progress
  fields to null or an honest known phase; do not synthesize historical times.

`updatedAt` reflects job metadata changes, not polling. Preserve atomic writes
and bounded save scheduling with simultaneous jobs.

## 4. Display progress without overstating it

Update `RenderControls.tsx` to show the current phase, elapsed execution time,
and time since the last activity or real progress signal, when available.

- When `phaseProgress` exists, label the bar with its phase, for example
  "Rendering frames: 45%", not "Video: 45%".
- Otherwise show an indeterminate indicator and the known phase, or "Running"
  for an unknown phase. Finalization remains active until success is confirmed.
- Show "No progress signal for …" as factual information, not a declaration
  that the render is blocked. Activity is not proof of forward progress.
- Poll every two seconds while queued or running, without overlapping requests
  or a fixed attempt count that abandons a valid long-running job.
- Stop polling and cancel outstanding work on terminal status, component
  unmount, or replacement by another job. Ignore stale responses.
- Handle network failures and expired authentication explicitly rather than
  treating them as render failures or polling forever without feedback.
- Remain compatible with an older API that omits the new fields.

No ETA, automatic inactivity failure, webhooks, or SSE is required in this phase.

## 5. Tests and verification

- Pure parser tests based on the pinned renderer's real output: split messages,
  ANSI/carriage returns, unknown lines, oversized buffers, invalid counts,
  duplicate and out-of-order updates, and multi-worker output.
- Manager tests: phase transitions, null percentages, no premature completion,
  callback handling, bounded persistence, terminal-state races, renderer error,
  total timeout, old registries, and restart recovery.
- UI checks: determinate and indeterminate states, polling past the old attempt
  limit, unmount cleanup, stale responses, authentication and network failures.
- Run pure tests without a local server, `npm run typecheck`, and oxlint on
  changed code. If the repository's Vitest setup is blocked, use Node's test
  runner for pure-module coverage and report the remaining test gap.
- Update `docs/render-api.md` and `/api/render/schema` with the field meanings,
  null behavior, phase-scoped percentage and polling guidance.
- After an authorized deployment, validate and render a small text composition,
  observe progress and verify its MP4. Then test the cat-video composition with
  authorization, observing signals without assuming this feature fixes its hang.
  Exercise failure/timeout behavior with controlled tests rather than stopping
  unrelated VPS processes.

## Acceptance

- Every percentage is backed by a verified signal; unavailable percentages are
  null and no overall percentage is invented.
- Activity and forward progress have distinct timestamps.
- The UI and API can distinguish queueing, known phases, unknown running state,
  success and failure without treating 100% of a phase as completion.
- Logs and parser buffers stay bounded; disk writes are coalesced; terminal
  states cannot be overwritten by delayed progress.
- Older jobs and API clients still work, polling has no artificial render-time
  cutoff, and status responses are not cached.
- The existing render timeout remains authoritative. No inactivity cancellation
  is added until real-world progress signals have been validated separately.

## Tasks

- [x] Inspect the pinned renderer package and cover its signal formats in tests.
- [x] Define the phase mapping and implement a bounded parser.
- [x] Wire callbacks, status fields, persistence and restart normalization.
- [x] Update declarations, status cache policy and API schema/docs.
- [x] Update UI progress and polling lifecycle.
- [ ] Complete automated UI, timeout and recovery coverage; Vitest is blocked
  by a local EPERM error. Node pure-module tests, typecheck and oxlint pass.
- [ ] Deploy with authorization and verify real progress and terminal states.
