import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import type { Outcome } from '@mygames/game-engine'
import { extractInstructorGameId } from '@mygames/game-server'
import { computeScoreBreakdown, crisisGameDef } from './gameDefinition'

// Crisis Slice 0 (scaffold) instructor report. GENERIC and read-only: it reports
// participation + KC + the (placeholder) group outcome, straight from the shared
// finalize pipeline. The real per-round Crisis report is Slice 7. Grading is
// participation-only, so the outcome is a displayed GAME result here, never a grade.

export const VALID_ROLES = new Set(crisisGameDef.roles.roles.map(r => r.key))

// Text questions from prepDefaults — read once at module load (none graded here).
export const TEXT_QUESTIONS = (crisisGameDef.prepDefaults ?? [])
  .filter(q => q.format === 'text' && !q.hidden)
  .map(q => ({ field: q.field, prompt: q.prompt, role_target: q.role_target }))

export const TEXT_FIELDS = TEXT_QUESTIONS.map(q => q.field)

export type ReportRow = {
  participant_id: string
  display_name: string
  group_number: number | null
  group_id: string | null
  role: string
  value_or_cost: number | null
  raw_score: number | null
  knowledge_check_score: number | null
  /** Keyed by question field; only present when the student submitted a non-empty answer. */
  text_answers: Record<string, string>
  /** The group's (placeholder) outcome object, or null. Generic — Slice 7 replaces it. */
  outcome: Outcome | null
}

export const getReportData = onCall({ cors: crisisGameDef.corsOrigins }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  try {
    const db = admin.firestore()
    const rtdb = admin.database()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    const [participantsSnap, groupsSnap, configSnap, attendingSnap] = await Promise.all([
      instanceRef.collection('participants').get(),
      instanceRef.collection('groups').get(),
      instanceRef.collection('config').doc('main').get(),
      rtdb.ref(`game_instances/${gameInstanceId}/attendance`).get(),
    ])

    const configData = (configSnap.data() ?? {}) as Record<string, unknown>
    const attending = (attendingSnap.val() ?? {}) as Record<string, { display_name?: string } | null>

    // Stable group numbers by sorted group_id.
    const sortedGroups = groupsSnap.docs.slice().sort((a, b) => a.id.localeCompare(b.id))
    const groupNumberMap = new Map<string, number>(sortedGroups.map((g, i) => [g.id, i + 1]))
    const groupOutcomeMap = new Map<string, Outcome | null>(
      sortedGroups.map(g => [g.id, (g.data()['outcome'] as Outcome | null) ?? null])
    )

    const rows: ReportRow[] = []

    for (const pdoc of participantsSnap.docs) {
      const d = pdoc.data() as Record<string, unknown>

      // Bots are never reported (spec §5.3 — display filter).
      if (d['is_bot'] === true) continue
      // Only finalized, role-bearing participants who were scored.
      if (d['finalized_at'] == null) continue
      const role = d['role'] as string | undefined
      if (!role || !VALID_ROLES.has(role)) continue
      if (d['raw_score'] === null || d['raw_score'] === undefined) continue

      const groupId = d['group_id'] as string | undefined

      const rtdbName = attending[pdoc.id]?.display_name?.trim()
      const fsName   = ((d['display_name'] ?? d['name'] ?? '') as string).trim()
      const display_name = rtdbName || fsName || `${pdoc.id.slice(0, 8)}…`

      const outcome = groupId ? (groupOutcomeMap.get(groupId) ?? null) : null

      let value_or_cost: number | null = null
      if (typeof d['value_or_cost'] === 'number') {
        value_or_cost = d['value_or_cost']
      } else {
        value_or_cost = computeScoreBreakdown(role, outcome, configData).value_or_cost
      }

      const text_answers: Record<string, string> = {}
      for (const field of TEXT_FIELDS) {
        const val = d[field]
        if (typeof val === 'string' && val.trim()) text_answers[field] = val.trim()
      }

      rows.push({
        participant_id: pdoc.id,
        display_name,
        group_number: groupId ? (groupNumberMap.get(groupId) ?? null) : null,
        group_id: groupId ?? null,
        role,
        value_or_cost,
        raw_score: d['raw_score'] as number,
        knowledge_check_score: (d['knowledge_check_score'] ?? null) as number | null,
        text_answers,
        outcome,
      })
    }

    rows.sort((a, b) => {
      const gn = (a.group_number ?? Infinity) - (b.group_number ?? Infinity)
      if (gn !== 0) return gn
      return a.display_name.localeCompare(b.display_name)
    })

    return { ok: true as const, rows, questions: TEXT_QUESTIONS, schema: crisisGameDef.outcomeSchema }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[getReportData] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})
