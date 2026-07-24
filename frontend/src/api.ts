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

// ── Online mode (Slice O1) ──────────────────────────────────────────────────────
// recordLogin: stamps last_login_at server-side AND returns clock_mode so the UI can
// pick online vs classroom routing (config is server-only-readable; the client cannot
// read the setting directly). Called once on session establishment, both modes.
export const recordLogin = (args: CallArgs = {} as BearerArgs) =>
  callFn<{ ok: boolean; clock_mode: string }>('recordLogin', args)

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

// ── Round-loop API (Slice 2 callables — the SAME names the Slice-3 UI invokes) ──

export type Stage = 'bidding' | 'allocation' | 'fixing'
export type Role = 'buyer' | 'seller1' | 'seller2'

/** One completed round — the shared history table row (everyone sees it, §1.1). */
export type RoundRecord = {
  round: number
  buyerSeat: number
  seller1Seat: number
  seller2Seat: number
  bids: { s1: number; s2: number }
  allocation: { a1: number; a2: number }
  crisisOccurred: boolean
  fixed: { s1: boolean; s2: boolean }
  profits: { seller1: number; seller2: number; buyer: number }
  defaulted: { s1: boolean; s2: boolean; buyer: boolean }
}

/** The per-seat view getRoundView returns — this is ALSO the exact object exposed to the
 *  page for the Slice-5 robot driver (window.__crisisState). */
export type SeatView = {
  ok: boolean
  seat: number
  role: Role
  status: 'in_progress' | 'finished'
  round: number
  numRounds: number
  stage: Stage
  owes: 'bid' | 'allocation' | 'fix' | null
  currentBids: { s1: number; s2: number } | null
  currentAllocation: { a1: number; a2: number } | null
  crisisOccurred: boolean | null
  history: RoundRecord[]
  pendingCount: number
  clockEnabled: boolean
  /** ms epoch of the current stage deadline, or null when the clock is off (online play). */
  stageDeadlineMs: number | null
}

export const getRoundView = (groupId: string) =>
  callFn<SeatView>('getRoundView', { group_id: groupId })

export const submitBid = (groupId: string, bid: number) =>
  callFn<{ ok: boolean; reason?: string }>('submitBid', { group_id: groupId, bid })

export const submitAllocation = (groupId: string, a1: number, a2: number) =>
  callFn<{ ok: boolean; reason?: string }>('submitAllocation', { group_id: groupId, a1, a2 })

export const submitFix = (groupId: string, fixed: boolean) =>
  callFn<{ ok: boolean; reason?: string }>('submitFix', { group_id: groupId, fixed })

export const checkRoundClock = (groupId: string) =>
  callFn<{ ok: boolean; closed?: boolean }>('checkRoundClock', { group_id: groupId })

// ── Instructor round-loop API (Slice 4 dashboard) ──────────────────────────────

/** One seat on the live dashboard — BOTS are already filtered out server-side (§5.3). */
export type DashboardSeat = {
  seat: number
  role: Role | null
  participantId: string | null
  name: string | null
  isBot: boolean
  timeoutCount: number
  timeouts: { round: number; stage: Stage }[]
  waiting: boolean
}

export type DashboardGroup = {
  groupId: string
  groupNumber: number | null
  status: 'not_started' | 'in_progress' | 'finished'
  startable: boolean
  round: number | null
  numRounds: number | null
  stage: Stage | null
  crisisOccurred: boolean | null
  clockEnabled: boolean | null
  stageDeadlineMs: number | null
  seats: DashboardSeat[]
  /** The pending HUMAN seats — "who is holding it up" (§4A). */
  waitingOn: { role: Role | null; name: string | null }[]
}

/** The §4A live window over every group. Read-only — no controls. `clock_mode` lets the
 *  Live view hide "Start game" online (auto-open handles round 1). */
export const getCrisisDashboard = () =>
  callFn<{ ok: boolean; clock_mode?: string; groups: DashboardGroup[] }>('getCrisisDashboard', {})

/** Launcher action (instructor is "a launcher and a finalizer"): start the round loop for a group. */
export const openRound = (groupId: string) =>
  callFn<{ ok: boolean; round: number; stage: Stage; clockEnabled: boolean }>('openRound', { group_id: groupId })

// ── Reports (Slice 7) — read-only, from the frozen finished state; bots excluded ──

export type ChartPoint = { period: number; s1Units: number; s2Units: number; s1Price: number; s2Price: number }

export type ReportStudentRow = {
  participantId: string
  name: string
  groupNumber: number
  role: 'Buyer' | 'Seller 1' | 'Seller 2'
  averageBid: number
  proportionFixed: number | null
  averageAllocation: number | null
  profit: number
  timeouts: number
  botGroup: boolean
}

export type ReportGroup = {
  groupId: string
  groupNumber: number
  names: { buyer: string; seller1: string; seller2: string }
  bots: { buyer: boolean; seller1: boolean; seller2: boolean }
  chart: ChartPoint[]
  table: { buyerProfit: number; seller1Profit: number; seller2Profit: number; seller1FixPct: number | null; seller2FixPct: number | null }
}

export type CrisisReport = {
  ok: boolean
  classSummary: {
    totalBuyerProfit: number
    totalSellerProfit: number
    averageBid: number
    averageAllocation: number
    pctCrisesFixed: number | null
  }
  classChart: ChartPoint[]
  groups: ReportGroup[]
  students: ReportStudentRow[]
  omittedBotGroups: number
  includedGroups: number
}

export const getCrisisReport = () => callFn<CrisisReport>('getCrisisReport', {})

// ── Clock-mode control (per-instance setting; instructor sets before starting) ──
export type GameConfig = { ok: boolean; clock_mode?: string; round_seconds?: number; num_rounds?: number }
export const getGameConfig = () => callFn<GameConfig>('getGameConfig', {})
export const setClockMode = (mode: 'on' | 'off') => callFn<GameConfig>('updateGameConfig', { clock_mode: mode })

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

// ── Online-mode instructor grouping (Slice O1) ──────────────────────────────────
export type OnlineMember = { participant_id: string; display_name: string; email: string | null }
export type OnlineGroup  = { group_id: string; members: OnlineMember[]; size: number; locked: boolean }

/** Pre-form random groups of 3 from the roster (online mode; re-runnable until first lock). */
export const groupParticipantsOnline = () =>
  callFn<{ ok: boolean; groups: number; full_groups: number; short_group_size: number | null; total_humans: number }>(
    'groupParticipantsOnline', {})

/** clock_mode + the online groups (with members) for the grouping panel. */
export const getOnlineGroups = () =>
  callFn<{ ok: boolean; clock_mode: string; groups: OnlineGroup[] }>('getOnlineGroups', {})

/** Move a human into another group with a free seat (online; rejected once a group locks). */
export const moveSeat = (participantId: string, targetGroupId: string) =>
  callFn<{ ok: boolean; moved: boolean }>('moveSeat', { participant_id: participantId, target_group_id: targetGroupId })

/** Fill a group's empty seats with bot seat-fillers so a short group can play (online). */
export const topUpGroupWithBots = (groupId: string) =>
  callFn<{ ok: boolean; added: number }>('topUpGroupWithBots', { group_id: groupId })

// Type re-export so pages can annotate outcome payloads without a second import.
export type { OutcomeSchema }
