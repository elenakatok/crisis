import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import {
  makeGetInstructorSession,
  makeAssignRole,
  makeCompletePrep,
  makeConfirmReady,
  makeGenerateAttendanceCode,
  makeVerifyAttendanceCode,
  makeGetRoster,
  makeSyncRoster,
  makeTriggerMatching,
  makeStartNegotiation,
  makeSubmitLeadOutcome,
  makeSubmitConfirmation,
  makeSubmitInstructorOutcome,
  makeFinalizeInstance,
  makePushResultsToClassroom,
  makeGetGameConfig,
  makeUpdateGameConfig,
  makeGetStudentPrepQuestions,
  makeGetDebriefQuestions,
  makeSubmitKnowledgeCheck,
  makeSubmitStaticKnowledgeCheckQuestion,
  makeGetInfoUrls,
} from '@mygames/game-server'
import { crisisGameDef } from './gameDefinition'

admin.initializeApp()

// CRISIS Slice 0 (SCAFFOLD). Stands up the generic platform skeleton on Crisis's real
// identity — single undifferentiated `player` matching role (group of 3), participation-
// only grading, and the approved KC (1 gate + 8 graded). The gate is the NEW late-
// assignment pattern (spec §7): correct answer = the single role key `player`.
//
// The round resolver (Slice 1), round loop + clock (Slice 2), student UI (Slice 3),
// instructor dashboard (Slice 4), and bots (Slice 5) are deliberately NOT wired here.
// triggerMatching is the STANDARD classroom matcher (spec §6) — human-only groups of 3;
// bot-fill of the remainder arrives with Slice 5.

// ── Game endpoints (onCall, via game-server factories + Crisis definition) ──────

export const getInstructorSession  = makeGetInstructorSession(crisisGameDef)
export const assignRole             = makeAssignRole(crisisGameDef)
export const completePrep           = makeCompletePrep(crisisGameDef)
export const confirmReady           = makeConfirmReady(crisisGameDef)
export const generateAttendanceCode = makeGenerateAttendanceCode(crisisGameDef)
export const verifyAttendanceCode   = makeVerifyAttendanceCode(crisisGameDef)
export const getRoster              = makeGetRoster(crisisGameDef)
export const syncRoster             = makeSyncRoster(crisisGameDef)
export const triggerMatching        = makeTriggerMatching(crisisGameDef)
export const startNegotiation           = makeStartNegotiation(crisisGameDef)
export const submitLeadOutcome          = makeSubmitLeadOutcome(crisisGameDef)
export const submitConfirmation         = makeSubmitConfirmation(crisisGameDef)
export const submitInstructorOutcome    = makeSubmitInstructorOutcome(crisisGameDef)
export const finalizeInstance       = makeFinalizeInstance(crisisGameDef)
export const pushResultsToClassroom = makePushResultsToClassroom(crisisGameDef)
export const getGameConfig          = makeGetGameConfig(crisisGameDef)
export const updateGameConfig       = makeUpdateGameConfig(crisisGameDef)
export const getStudentPrepQuestions            = makeGetStudentPrepQuestions(crisisGameDef)
export const getDebriefQuestions                = makeGetDebriefQuestions(crisisGameDef)
export const submitKnowledgeCheck               = makeSubmitKnowledgeCheck(crisisGameDef)
export const submitStaticKnowledgeCheckQuestion = makeSubmitStaticKnowledgeCheckQuestion(crisisGameDef)
export const getInfoUrls                        = makeGetInfoUrls(crisisGameDef)
export { getReportData } from './getReportData'
export { scoreAndRecord } from './scoreAndRecord'

// ── Slice 2: the round loop + clock (server-authoritative Firestore shell over the
// pure Slice-1 machine). The SAME callable names the Slice-3 student UI will invoke.
export {
  openRound,
  submitBid,
  submitAllocation,
  submitFix,
  checkRoundClock,
  getRoundView,
  getInstructorRoundView,
} from './crisisRound'

// ── Non-game onRequest endpoints ────────────────────────────────────────────────

const CORS_ORIGINS = new Set(['https://crisis.mygames.live'])

export const health = onRequest((req, res) => {
  const origin = req.headers.origin ?? ''
  if (CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.set('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') { res.status(204).send(''); return }
  res.json({ ok: true, game: 'crisis' })
})

// Emulator-only dev seed (LOCKED — 404 unless FUNCTIONS_EMULATOR==='true').
export { seedGroupForTest } from './seedFunctions'
