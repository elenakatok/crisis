// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS bot runner — the TRIGGERS around runBotActions (the idempotent core in
// crisisRound.ts). Two triggers, one core (SAA / Spectrum pattern):
//   • runBotActionsTask — the Cloud Task handler (~12–25s after a stage opens), with
//     retryConfig so a transient failure is retried; the core's idempotency makes a retry
//     safe (a bot that already acted this stage is a no-op).
//   • runBotActionsForTest — emulator-ONLY HTTP trigger, so the harness drives bot turns
//     deterministically (the emulator has no Cloud Tasks) and can simulate a duplicate
//     delivery by calling it twice.
// The resolve-on-read backstop lives in the view callables (crisisRound.ts).
// ═══════════════════════════════════════════════════════════════════════════════

import { onTaskDispatched } from 'firebase-functions/v2/tasks'
import { onRequest } from 'firebase-functions/v2/https'
import { runBotActions } from './crisisRound'

// PRIMARY: Cloud Task → the idempotent core. Retries on failure (core makes it safe).
export const runBotActionsTask = onTaskDispatched(
  { retryConfig: { maxAttempts: 5, minBackoffSeconds: 5 }, rateLimits: { maxConcurrentDispatches: 6 } },
  async (req) => {
    const { game_instance_id, group_id } = (req.data ?? {}) as { game_instance_id?: string; group_id?: string }
    if (!game_instance_id || !group_id) return
    try {
      await runBotActions(game_instance_id, group_id)
    } catch (err) {
      console.error('[runBotActionsTask] error:', err)
      throw err // let Cloud Tasks retry — the core is idempotent
    }
  },
)

// EMULATOR-ONLY: drive a bot pass on demand (harness). Locked to the emulator like the seed
// functions — returns 404 in production so it is never a live action vector.
export const runBotActionsForTest = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') { res.status(404).json({ error: 'Not found' }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = (req.body?.data ?? req.body) as { game_instance_id?: unknown; group_id?: unknown }
  if (typeof body.game_instance_id !== 'string' || typeof body.group_id !== 'string') {
    res.status(400).json({ error: 'game_instance_id and group_id required' }); return
  }
  const summary = await runBotActions(body.game_instance_id, body.group_id)
  res.json({ data: { ok: true, ...summary } })
})
