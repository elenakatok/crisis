import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from './firebase'
import type { OutcomeSchema } from './gameConfig'

// ── Helper ────────────────────────────────────────────────────────────────────
// Single wrapper: the Firebase SDK auto-attaches the ID token Bearer when
// auth.currentUser exists, and sends nothing when there is no session —
// covering both bootstrap (getInstructorSession, assignRole) and authed calls.

async function callFn<T>(name: string, data: object = {}): Promise<T> {
  const fn = httpsCallable<object, T>(functions, name)
  const result = await fn(data)
  return result.data
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type TestArgs   = { _test: { participant_id: string; game_instance_id: string } }
export type TokenArgs  = { token: string }
export type BearerArgs = Record<string, never>   // empty — auth is in Authorization header
export type CallArgs   = TestArgs | TokenArgs | BearerArgs

export type OutcomeFields = Record<string, unknown>

export type AssignRoleResult = {
  ok:               boolean
  role:             string
  customToken:      string
  participant_id:   string
  game_instance_id: string
}

export const CLASSROOM_URL = import.meta.env.DEV
  ? 'http://localhost:5173'
  : 'https://classroom.mygames.live'

// onCall auth errors arrive as FirebaseError with code 'functions/permission-denied'
// or 'functions/unauthenticated' — not HTTP status strings.
export function isAuthError(err: unknown): boolean {
  if (!(err instanceof FirebaseError)) return false
  return (
    err.code === 'functions/permission-denied' ||
    err.code === 'functions/unauthenticated'
  )
}

// ── Student API ─────────────────────────────────────────────────────────────────

/** Bootstrap — no session yet; classroom JWT or _test bypass travels in data. */
export const assignRole = (args: CallArgs) =>
  callFn<AssignRoleResult>('assignRole', args)

export const completePrep = (args: CallArgs = {} as BearerArgs) =>
  callFn<{ ok: boolean }>('completePrep', args)

export const confirmReady = (args: CallArgs) =>
  callFn<{ ok: boolean }>('confirmReady', args)

export const verifyAttendanceCode = (args: CallArgs, code: string) =>
  callFn<{ ok: boolean }>('verifyAttendanceCode', { ...args, code })

// ── Student content callables ─────────────────────────────────────────────────
// The shared @mygames/game-ui components (InfoPage/KnowledgeCheck/PrepQuestions, via
// getInfoUrls) usually invoke these directly through httpsCallable; they are exposed +
// typed here so the game's full callable surface is discoverable.

export type InfoPageLink = { key: string; label: string; url: string }
export type GetInfoUrlsResult = {
  ok:         boolean
  roleLabel:  string
  links:      InfoPageLink[]
  publicLink: { label: string; url: string } | null
}

export const getInfoUrls = () =>
  callFn<GetInfoUrlsResult>('getInfoUrls', {})

export const getStudentPrepQuestions = () =>
  callFn<{ ok: boolean; questions: unknown[] }>('getStudentPrepQuestions', {})

export const getDebriefQuestions = () =>
  callFn<{ ok: boolean; questions: unknown[] }>('getDebriefQuestions', {})

export const submitKnowledgeCheck = (data: object = {}) =>
  callFn<{ ok: boolean }>('submitKnowledgeCheck', data)

export const submitStaticKnowledgeCheckQuestion = (data: object = {}) =>
  callFn<{ ok: boolean; correct?: boolean }>('submitStaticKnowledgeCheckQuestion', data)

// ── Instructor API ────────────────────────────────────────────────────────────

export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

export type RosterParticipant = {
  participant_id: string
  display_name:   string
  role:           string | null
  role_label:     string | null
  group_id:       string | null
  is_lead:        boolean | null
  attended:       boolean
  finalized:      boolean
}

export type RosterGroup = {
  group_id:             string
  status:               string
  lead_participant_id:  string
  participants_by_role: Record<string, string[]>
  agreement_reached:    boolean | null
  outcome:              Record<string, unknown> | null
}

export type PushSummary = {
  total:     number
  succeeded: number
  failed:    { participant_id: string; reason: string }[]
}

/** Bootstrap — no session yet; JWT travels in data; SDK attaches nothing. */
export const getInstructorSession = (args: InstructorSessionArgs) =>
  callFn<{ ok: boolean; customToken: string }>('getInstructorSession', args)

/** Remaining instructor calls: SDK auto-attaches Firebase Bearer when session exists. */
export const syncRoster = () =>
  callFn<{ ok: boolean; synced: number; skipped: number }>('syncRoster', {})

export const generateAttendanceCode = () =>
  callFn<{ ok: boolean; code: string }>('generateAttendanceCode', {})

export const getRoster = () =>
  callFn<{ ok: boolean; participants: RosterParticipant[]; groups: RosterGroup[] }>('getRoster', {})

// Standard classroom matcher (spec §6) — human-only groups of 3. Bot-fill of the
// remainder arrives with Slice 5 (same 'triggerMatching' callable, extended).
export const triggerMatching = () =>
  callFn<{ ok: boolean; groups: unknown[]; alreadyMatched?: boolean }>('triggerMatching', {})

export const submitInstructorOutcome = (groupId: string, outcome: OutcomeFields | null) =>
  callFn<{ ok: boolean }>('submitInstructorOutcome', { group_id: groupId, outcome })

// Type re-export so pages can annotate outcome payloads without a second import.
export type { OutcomeSchema }
