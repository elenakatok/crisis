// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS bot scheduling — Cloud Tasks enqueue helper (Crisis-LOCAL copy of SAA's
// botTasks pattern). Leaf module: imports only firebase-admin, so both crisisRound.ts
// (stage-close re-enqueue) and botRunner.ts can use it with no import cycle.
//
// Crisis is CONSUMER #2 of 3 (Bot_Harness_Plan_v2 §5) — shared extraction waits until
// Info Sharing exists. Keep this Crisis-local; do NOT extract.
// ═══════════════════════════════════════════════════════════════════════════════

import { getFunctions } from 'firebase-admin/functions'

/** Randomized think-time window (§5.1 — a bot answering instantly reads as a machine). */
export const BOT_DELAY_MIN_MS = 12_000
export const BOT_DELAY_MAX_MS = 25_000

/** A randomized bot delay in [12s, 25s] — comfortably under the 120s stage clock. */
export function botDelayMs(): number {
  return BOT_DELAY_MIN_MS + Math.floor(Math.random() * (BOT_DELAY_MAX_MS - BOT_DELAY_MIN_MS))
}

/** Firestore doc ids are unrestricted, but Cloud Tasks names must be [A-Za-z0-9_-]. */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '')
}

/**
 * Enqueue one bot-action pass for (gameInstanceId, groupId), scheduled ~12–25s out.
 * Best-effort: a missing/unavailable task queue (e.g. the emulator, which has no Cloud
 * Tasks) must NOT fail the caller — the resolve-on-read backstop + the emulator test
 * trigger cover it. A deterministic task id per (group, round, stage) dedupes repeat
 * enqueues for the same stage to a single task.
 */
export async function enqueueBotTask(
  gameInstanceId: string,
  groupId: string,
  round: number,
  stage: string,
  delayMs: number = botDelayMs(),
): Promise<void> {
  try {
    const queue = getFunctions().taskQueue('runBotActionsTask')
    await queue.enqueue(
      { game_instance_id: gameInstanceId, group_id: groupId },
      {
        scheduleTime: new Date(Date.now() + delayMs),
        id: sanitize(`bots_${gameInstanceId}_${groupId}_r${round}_${stage}`),
      },
    )
  } catch (err) {
    console.warn('[enqueueBotTask] skipped:', err instanceof Error ? err.message : err)
  }
}
