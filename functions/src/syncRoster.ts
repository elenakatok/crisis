import { onCall, type CallableRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { makeSyncRoster, extractInstructorGameId } from '@mygames/game-server'
import { crisisGameDef } from './gameDefinition'

// ═══════════════════════════════════════════════════════════════════════════════
// Crisis syncRoster — the shared roster sync (participants) PLUS denormalizing the
// course owner's email onto the instance doc (instructor-email auto-populate).
//
// getCourseRoster now returns `instructor_email` (the course owner, resolved classroom-side).
// The shared makeSyncRoster destructures only `{ participants }` and ignores it, so we wrap it:
//   1. delegate the participant sync to the shared handler UNCHANGED (`.run` invokes it in-process),
//   2. read the owner email with one more lightweight roster fetch and store it on the instance doc.
// The flag mailto (flagGroup) reads it with precedence: synced instance value → the Settings
// override → blank To:. Step 2 is best-effort — it NEVER fails the roster sync.
// ═══════════════════════════════════════════════════════════════════════════════

const classroomCallbackSecret = defineSecret('CLASSROOM_CALLBACK_SECRET')
const sharedSyncRoster = makeSyncRoster(crisisGameDef)
const isEmu = () => process.env.FUNCTIONS_EMULATOR === 'true'

export const syncRoster = onCall(
  { cors: crisisGameDef.corsOrigins, secrets: [classroomCallbackSecret] },
  async (request: CallableRequest) => {
    // 1. Participants — the shared handler, unchanged (same secret, same roster URL, same merge rules).
    const result = await sharedSyncRoster.run(request)

    // 2. Instructor email — denormalize the course owner's address onto the instance doc. A failure
    //    here must NEVER fail the sync (participants already committed), so it is fully guarded.
    try {
      const data = request.data as Record<string, unknown>
      const authHeader = request.rawRequest.headers.authorization as string | undefined
      const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeader)
      const devData = isEmu() && data['_dev'] != null ? (data['_dev'] as Record<string, unknown>) : null
      const rosterUrl = String(devData?.['roster_url'] ?? process.env.CLASSROOM_ROSTER_URL ?? '')
      const secret = String(devData?.['callback_secret'] ?? process.env.CLASSROOM_CALLBACK_SECRET ?? '')
      if (rosterUrl && secret) {
        const res = await fetch(rosterUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
          body: JSON.stringify({ game_instance_id: gameInstanceId }),
        })
        if (res.ok) {
          const body = (await res.json()) as { instructor_email?: string }
          const email = (body.instructor_email ?? '').trim()
          // Only WRITE when the owner resolved. Never clear a stored value with a blank — an
          // instructor keeps a previously-synced address even if a later lookup momentarily fails.
          if (email) {
            await admin.firestore().collection('game_instances').doc(gameInstanceId)
              .set({ instructor_email: email }, { merge: true })
          }
        }
      }
    } catch (err) {
      console.error('[crisis syncRoster] instructor_email denormalize failed (non-fatal):', err instanceof Error ? err.message : err)
    }

    return result
  },
)
