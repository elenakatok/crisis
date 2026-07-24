import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import { crisisGameDef } from './gameDefinition'
import type { CrisisState, RoundRecord } from './round/machine'

// ═══════════════════════════════════════════════════════════════════════════════
// getCrisisReport (instructor) — the READ-ONLY data behind the three debrief reports.
// Reads the FROZEN finished round state (Slice 6). Everything is computed server-side so
// the reports page just renders. BOTS ARE EXCLUDED ENTIRELY (Elena's call): any group with
// a bot seat is OMITTED from ALL reports (selector, class aggregates, per-student table).
// A bot-filled group's outcomes are driven by bot play and its allocations chart would need
// the bot seat to sum to 100 — so a partial view would be MISLEADING; omitting it keeps
// every reported figure purely human-vs-human, which is the game's lesson (§5.4). The
// omitted count is returned so the UI can say so (not silent).
//
// Fixing rate denominator is crises FACED (a seller with >0 units in a crisis round), never
// rounds played — a no-crisis round never enters the denominator.
// ═══════════════════════════════════════════════════════════════════════════════

interface StoredDoc {
  state: CrisisState
  pid_by_seat: Record<string, string>
  bot_seats?: number[]
}

export type ChartPoint = { period: number; s1Units: number; s2Units: number; s1Price: number; s2Price: number }

export type StudentRow = {
  participantId: string
  name: string
  groupNumber: number
  role: 'Buyer' | 'Seller 1' | 'Seller 2'
  /** Seller: own average bid. Buyer: allocation-weighted average price PAID. */
  averageBid: number
  /** Seller: own fixing rate. Buyer: proportion their sellers fixed (across both). */
  proportionFixed: number | null
  /** Seller: average units received. Buyer: null (blank). */
  averageAllocation: number | null
  profit: number
  /** Stages this student timed out on across the game (0 when they never did). */
  timeouts: number
  /** True if this student played in a bot-filled group (their own facts are still real). */
  botGroup: boolean
}

export type GroupReport = {
  groupId: string
  groupNumber: number
  names: { buyer: string; seller1: string; seller2: string }
  /** Which seats in THIS group were bots (Report 2 labels them; bot-filled groups now charted). */
  bots: { buyer: boolean; seller1: boolean; seller2: boolean }
  chart: ChartPoint[]
  table: { buyerProfit: number; seller1Profit: number; seller2Profit: number; seller1FixPct: number | null; seller2FixPct: number | null }
}

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0)
const mean = (ns: number[]) => (ns.length ? sum(ns) / ns.length : 0)

/** Fixing rate for one seller: fixed / faced, faced = crisis rounds where they had units. */
function fixPct(history: RoundRecord[], side: 's1' | 's2'): number | null {
  let faced = 0, fixed = 0
  for (const h of history) {
    const units = side === 's1' ? h.allocation.a1 : h.allocation.a2
    if (h.crisisOccurred && units > 0) { faced++; if (h.fixed[side]) fixed++ }
  }
  return faced === 0 ? null : fixed / faced
}

export const getCrisisReport = onCall({ cors: crisisGameDef.corsOrigins }, async (request: CallableRequest) => {
  const data = request.data as Record<string, unknown>
  const isEmu = process.env.FUNCTIONS_EMULATOR === 'true'
  const iid = await extractInstructorGameId(data, isEmu, request.rawRequest.headers.authorization as string | undefined)
  const instanceRef = admin.firestore().collection('game_instances').doc(iid)

  try {
    const [roundsSnap, participantsSnap] = await Promise.all([
      instanceRef.collection('crisis_round').get(),
      instanceRef.collection('participants').get(),
    ])

    const meta = new Map<string, { name: string; isBot: boolean }>()
    for (const p of participantsSnap.docs) {
      const d = p.data() as Record<string, unknown>
      const name = (((d['display_name'] ?? d['name'] ?? '') as string).trim()) || `${p.id.slice(0, 6)}…`
      meta.set(p.id, { name, isBot: d['is_bot'] === true })
    }

    // Every group with history gets a stable number (sorted). Report 2's selector + the
    // class SUMS include ONLY all-human groups; but a bot-group HUMAN still appears in
    // Report 3 (their own facts are real) with a marker + their group number.
    const sorted = roundsSnap.docs.slice().sort((a, b) => a.id.localeCompare(b.id))
    let omittedBotGroups = 0
    const groups: GroupReport[] = []
    const humanGroupIds = new Set<string>()   // all-human groups → class sums + class chart
    const students: StudentRow[] = []

    let groupNumber = 0
    for (const doc of sorted) {
      const stored = doc.data() as StoredDoc
      const st = stored.state
      const history = st.history ?? []
      if (history.length === 0) continue

      const botSeatSet = new Set(stored.bot_seats ?? [])
      const isBotSeat = (seat: number) => botSeatSet.has(seat) || meta.get(stored.pid_by_seat[String(seat)])?.isBot === true
      const hasBot = [0, 1, 2].some(isBotSeat)
      groupNumber++
      const gn = groupNumber

      const nameOf = (seat: number) => meta.get(stored.pid_by_seat[String(seat)])?.name ?? '—'
      const buyerName = nameOf(st.buyerSeat), s1Name = nameOf(st.seller1Seat), s2Name = nameOf(st.seller2Seat)

      const buyerProfit = sum(history.map((h) => h.profits.buyer))
      const s1Profit = sum(history.map((h) => h.profits.seller1))
      const s2Profit = sum(history.map((h) => h.profits.seller2))
      const s1Fix = fixPct(history, 's1'), s2Fix = fixPct(history, 's2')

      // Report 2 selector: EVERY group with history is charted — a bot-filled remainder is
      // the NORMAL case (class sizes rarely divide by 3). Bots submit bids and receive
      // allocations like any seat, so the chart works; the table labels the bot seats. Only
      // the CLASS aggregates (Report 1 sums + class chart) stay all-human, tracked separately.
      const chart: ChartPoint[] = history.map((h) => ({
        period: h.round, s1Units: h.allocation.a1, s2Units: h.allocation.a2, s1Price: h.bids.s1, s2Price: h.bids.s2,
      }))
      groups.push({
        groupId: doc.id, groupNumber: gn,
        names: { buyer: buyerName, seller1: s1Name, seller2: s2Name },
        bots: { buyer: isBotSeat(st.buyerSeat), seller1: isBotSeat(st.seller1Seat), seller2: isBotSeat(st.seller2Seat) },
        chart,
        table: { buyerProfit, seller1Profit: s1Profit, seller2Profit: s2Profit, seller1FixPct: s1Fix, seller2FixPct: s2Fix },
      })
      if (hasBot) omittedBotGroups++
      else humanGroupIds.add(doc.id)

      // ── Report 3: per-student rows for every HUMAN seat, even in a bot-filled group —
      // a remainder group with a bot seat is the NORMAL case; that student did the
      // assignment and their OWN facts are real. Bot seats are skipped; humans marked.
      // Buyer: allocation-weighted average price PAID = Σ(a1·b1 + a2·b2) / Σ(a1+a2).
      const paid = sum(history.map((h) => h.allocation.a1 * h.bids.s1 + h.allocation.a2 * h.bids.s2))
      const units = sum(history.map((h) => h.allocation.a1 + h.allocation.a2))
      let bFaced = 0, bFixed = 0
      for (const h of history) {
        if (!h.crisisOccurred) continue
        if (h.allocation.a1 > 0) { bFaced++; if (h.fixed.s1) bFixed++ }
        if (h.allocation.a2 > 0) { bFaced++; if (h.fixed.s2) bFixed++ }
      }
      // Per-seat timeout count is already in the frozen state (Slice 2: st.timeouts[seat] is
      // the seat's [{round, stage}] log) — just count it. No rewiring needed.
      const seatTimeouts = (seat: number) => (st.timeouts?.[seat] ?? []).length
      if (!isBotSeat(st.buyerSeat)) students.push({
        participantId: stored.pid_by_seat[String(st.buyerSeat)], name: buyerName, groupNumber: gn, role: 'Buyer', botGroup: hasBot,
        averageBid: units > 0 ? paid / units : 0,
        proportionFixed: bFaced === 0 ? null : bFixed / bFaced,
        averageAllocation: null, profit: buyerProfit, timeouts: seatTimeouts(st.buyerSeat),
      })
      if (!isBotSeat(st.seller1Seat)) students.push({
        participantId: stored.pid_by_seat[String(st.seller1Seat)], name: s1Name, groupNumber: gn, role: 'Seller 1', botGroup: hasBot,
        averageBid: mean(history.map((h) => h.bids.s1)), proportionFixed: s1Fix,
        averageAllocation: mean(history.map((h) => h.allocation.a1)), profit: s1Profit, timeouts: seatTimeouts(st.seller1Seat),
      })
      if (!isBotSeat(st.seller2Seat)) students.push({
        participantId: stored.pid_by_seat[String(st.seller2Seat)], name: s2Name, groupNumber: gn, role: 'Seller 2', botGroup: hasBot,
        averageBid: mean(history.map((h) => h.bids.s2)), proportionFixed: s2Fix,
        averageAllocation: mean(history.map((h) => h.allocation.a2)), profit: s2Profit, timeouts: seatTimeouts(st.seller2Seat),
      })
    }

    // ── class aggregates — SUMS across the ALL-HUMAN groups only (bot-filled groups are
    // charted in Report 2 but excluded from the class sums/means/chart, hence omittedBotGroups) ──
    const included = groups.filter((g) => humanGroupIds.has(g.groupId))
    const totalBuyerProfit = sum(included.map((g) => g.table.buyerProfit))
    const totalSellerProfit = sum(included.map((g) => g.table.seller1Profit + g.table.seller2Profit))
    // grand means / class fixing over every included group's chart points
    const allBids: number[] = []
    const allAllocs: number[] = []
    let classFaced = 0, classFixed = 0
    // Re-walk the all-human groups' histories: the per-group pcts lose the denominator, so
    // recompute faced/fixed (and bids/allocs for the means) here from the raw docs again:
    for (const doc of sorted) {
      if (!humanGroupIds.has(doc.id)) continue
      const stored = doc.data() as StoredDoc
      const history = stored.state.history ?? []
      for (const h of history) {
        allBids.push(h.bids.s1, h.bids.s2)
        allAllocs.push(h.allocation.a1, h.allocation.a2)
        if (h.crisisOccurred) {
          if (h.allocation.a1 > 0) { classFaced++; if (h.fixed.s1) classFixed++ }
          if (h.allocation.a2 > 0) { classFaced++; if (h.fixed.s2) classFixed++ }
        }
      }
    }

    // class allocations chart — per-period average across included groups.
    const byPeriod = new Map<number, { s1u: number[]; s2u: number[]; s1p: number[]; s2p: number[] }>()
    for (const g of included) for (const c of g.chart) {
      const e = byPeriod.get(c.period) ?? { s1u: [], s2u: [], s1p: [], s2p: [] }
      e.s1u.push(c.s1Units); e.s2u.push(c.s2Units); e.s1p.push(c.s1Price); e.s2p.push(c.s2Price)
      byPeriod.set(c.period, e)
    }
    const classChart: ChartPoint[] = [...byPeriod.entries()].sort((a, b) => a[0] - b[0]).map(([period, e]) => ({
      period, s1Units: mean(e.s1u), s2Units: mean(e.s2u), s1Price: mean(e.s1p), s2Price: mean(e.s2p),
    }))

    const classSummary = {
      totalBuyerProfit,
      totalSellerProfit,
      averageBid: mean(allBids),
      averageAllocation: mean(allAllocs), // plain grand mean (the deck's sanity check, ~50)
      pctCrisesFixed: classFaced === 0 ? null : classFixed / classFaced,
    }

    return {
      ok: true as const,
      classSummary,
      classChart,
      groups,
      students,
      omittedBotGroups,
      includedGroups: included.length,
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[getCrisisReport] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})
