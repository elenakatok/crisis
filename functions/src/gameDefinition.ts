import type { Outcome, OutcomeSchema, RoleConfig } from '@mygames/game-engine'
import type { GameDefinition, PrepTextQuestion } from '@mygames/game-server'

// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS — a 10-round, 3-player repeated stage game (Crisis_Game_Specification_v1).
//
// SLICE 0 (SCAFFOLD ONLY). This stands up the generic platform skeleton on Crisis's
// real identity — game_id, a fixed group of 3, participation-only grading — plus the
// approved Knowledge Check. Everything game-specific is a LATER SLICE and is
// deliberately NOT here:
//   • Slice 1: the pure round resolver (payoffs, allocation validation, crisis draw,
//     the complete default table). Unit-tested, no UI.
//   • Slice 2: the round loop + clock (3 seats, ordered stages, timeout→default, 10
//     rounds, history accumulation).
//   • Slice 3: student UI. Slice 4: instructor dashboard. Slice 5: bots.
//     Slice 6: KC + finalize + gradebook. Slice 7: reports.
//
// ── ROLES ARE ASSIGNED LATE (spec §2) ──────────────────────────────────────────
// A group is THREE UNDIFFERENTIATED players until play begins; Buyer / Seller 1 /
// Seller 2 are assigned immediately before round 1 (Slice 2). So the MATCHING role is
// a SINGLE undifferentiated `player` (group of 3) — matching never assigns Buyer/Seller
// (spec §2: "Do not scaffold role assignment into the matching path"). This mirrors
// SAA's single-role shape. The Buyer/Seller seat model is a Slice-2 decision and is
// intentionally NOT declared here.
//
// ── GRADING (spec §4): PARTICIPATION ONLY. PROFIT IS NEVER GRADED. ──────────────
// computeScoreBreakdown returns a FLAT participation point for every present player
// regardless of outcome, so the single-role z-score pool is intentionally DEGENERATE
// (sample SD 0 → every present student normalizes to 0). Profit is the in-game
// currency and the object of the debrief; z-scoring it across asymmetric Buyer/Seller
// roles would be meaningless. True no-shows are handled by the engine (status no_show
// → −2), never here. Server-side bots (is_bot:true) are excluded from scoring entirely
// (the is_bot skip lives in scoreAndRecord.ts, per the SAA pattern).
//
// ── KC (Crisis_KC_Questions_v1.md, approved DRAFT): 1 gate + 8 graded MC. ───────
// The gate is the NEW late-assignment pattern (spec §7): a real 4-option question
// ("What is your role in this game?" → C "It can be either — you will find out when the
// game starts") whose CORRECT value is the single role key `player`, so the shared
// grader (answer === role) passes on C. This is a content change per game, no shared
// code change. KC score = correct statics / 8 (the shared grader counts grading:'static'
// dynamically — no hardcoded denominator). Options shuffle per student; grading is
// content-keyed (option value), never a letter/position; explanations name the concept.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Role config (ONE undifferentiated matching role — `player`) ────────────────

export const crisisConfig: RoleConfig = {
  roles: [
    { key: 'player', label: 'Player', short: 'P' },
  ],
}

// ── Outcome schema (PLACEHOLDER — the real per-round outcome arrives with Slice 2) ──
// Grading is participation-only, so the outcome CONTENT never affects the score; this
// is a dummy field that just lets the generic outcome form + finalize path run.
export const crisisSchema: OutcomeSchema = [
  { key: 'placeholder_result', type: 'decimal', min: 0, max: 1_000_000, step: 1 }, // dummy; scoring ignores it
  { key: 'notes', type: 'text' }, // optional free-text; blank = '', excluded from scoring
]

// ── Score sense (value-sense) ──────────────────────────────────────────────────

export const crisisScoreSense: Record<string, 'value' | 'cost'> = {
  player: 'value',
}

// ── Scoring (spec §4 — PARTICIPATION only; profit NEVER graded) ─────────────────
// Every PRESENT player earns the SAME flat participation point (1), independent of the
// outcome. Deliberate: the single-role z-score pool is DEGENERATE (sample SD = 0 → the
// engine's zero-SD guard normalizes every present student to 0). A "suspiciously
// uniform" report is CORRECT, not broken. A true no-show (no role / never matched) is
// handled by the engine (status no_show → raw null, z = −2), not here. The `outcome`
// argument is intentionally ignored — reading it into the grade would be exactly the
// leak §4 forbids.

export function computeScoreBreakdown(
  roleKey: string,
  _outcome: Outcome | null,
  _configData?: Record<string, unknown>,
): { value_or_cost: number; raw_score: number } {
  if (roleKey === 'player') return { value_or_cost: 1, raw_score: 1 }
  return { value_or_cost: 0, raw_score: 0 }
}

export function computeRawScore(
  roleKey: string,
  outcome: Outcome | null,
  configData?: Record<string, unknown>,
): number {
  return computeScoreBreakdown(roleKey, outcome, configData).raw_score
}

// ── Graded-KC data-object helper ──────────────────────────────────────────────
// Every graded static question is a DATA OBJECT built via gq() (the future admin-defaults
// screen — a `game_defaults/<game>` DB doc — must stay small, so never hand-write inline
// literals). grading 'static' + a locked correct_value keyed to option CONTENT (value),
// never a letter position (getStudentPrepQuestions shuffles the options per student).
const gq = (
  field: string, order: number, correct_value: string,
  prompt: string, options: { value: string; label: string }[], explanation: string,
): PrepTextQuestion => ({
  field, type: 'mc', system: false, category: 'knowledge_check', format: 'multiple_choice',
  grading: 'static', correct_value, role_target: 'player', prompt,
  placeholder: '', order, hidden: false, deletable: false, options, explanation,
})

// ── GameDefinition ────────────────────────────────────────────────────────────

export const crisisGameDef: GameDefinition = {
  game_id: 'crisis',
  roles:   crisisConfig,
  scoreSense: crisisScoreSense,

  // ⚠ FIXED group size 3 (spec §6). Not flexible. Same three people across all 10
  // rounds (reputation requires it).
  //   • composition {player:3} sets the base group to 3.
  //   • perRoleCap:3 EQUAL to composition LOCKS each group at exactly 3 — no flex.
  //     (Omitting perRoleCap would make the cap = eligible.length, letting one group
  //     absorb the remainder ABOVE 3.)
  // Remainders (turnout not a multiple of 3) are bot-filled at formation — Slice 5.
  // "Groups lock at first submission" (spec §6) is a boolean set on the group doc when
  // any member submits a round-1 decision; nothing reads it until Slice 2, so no field
  // is written here. Bots (is_bot:true), bot_count, and bot_participants on the group
  // are Slice 5; the participant model does not preclude them (see is_bot in the rules
  // blocklist + the scoreAndRecord is_bot skip).
  composition: { player: 3 },
  perRoleCap: 3,

  outcomeSchema: crisisSchema,
  computeRawScore,
  computeScoreBreakdown,
  // reservations: participation-only, so walk-away is 0 for the single role.
  reservations: { player: 0 },
  corsOrigins: ['https://crisis.mygames.live'],
  classroom: { callbackSecretId: 'crisis_v1' },

  // Settings page config fields (ONE role — `player`). The role sheet is a PLACEHOLDER
  // PDF for Slice 0; Elena supplies the real instructions sheet later. round_seconds is
  // the per-decision clock (spec §3.1 — deck says 120s, configurable; spec §10 open item
  // #3). num_rounds is fixed at 10 (spec §1.1) but exposed as a setting for clarity;
  // nothing reads either until the round loop (Slice 2).
  configFields: [
    { key: 'player_role_name', kind: 'string',      default: 'Player' },
    { key: 'player_sheet_url', kind: 'url',          default: '/role-info/crisis.pdf' },
    { key: 'round_seconds',    kind: 'positiveInt',  default: 120 },
    { key: 'num_rounds',       kind: 'positiveInt',  default: 10 },
  ],

  // Info page links — keys must appear in configFields above.
  roleInfoLinks: [
    { roleKey: 'player', links: [{ key: 'player_sheet_url', label: 'Game instructions' }] },
  ],

  // ── prepDefaults: KC gate + 8 graded statics ──────────────────────────────────
  // AUTHORITY: Crisis_KC_Questions_v1.md (approved DRAFT). Answer key (graded):
  // B·B·B·B·B·B·A·B (Q2–Q9). Gate correct = the single role key `player` (the "It can
  // be either — you will find out when the game starts" option).
  prepDefaults: [
    // ── Gate (system, ungraded) — the NEW late-assignment pattern (spec §7) ──────
    // grading 'assigned_role' → correct iff answer === participant.role. The single
    // role is `player`, so option C (value 'player') is the correct, honest answer for
    // a student who has not yet been assigned Buyer/Seller. Option values A/B/D are
    // honest distractors; they are NOT role keys, so a wrong pick is bounced back for a
    // retry. (Making A/B/D grade as tailored "wrong answers" would require either a
    // shared change or pre-committing the Slice-2 Buyer/Seller seat model — deferred;
    // see the gate audit, spec §7. Crisis ships with the gate regardless.)
    {
      field: 'kc_gate_role', type: 'mc', system: true,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'assigned_role', role_target: 'player',
      prompt: 'What is your role in this game?',
      placeholder: '', order: 0, hidden: false, deletable: false,
      options: [
        { value: 'buyer',    label: 'Buyer' },
        { value: 'seller',   label: 'Seller' },
        { value: 'player',   label: 'It can be either — you will find out when the game starts' },
        { value: 'no_roles', label: 'This game has no roles' },
      ],
      explanation: 'Roles are assigned right before the first round. Until then you are one of three players and could end up as the Buyer or as one of the two Sellers.',
    },

    // ── Q2 — Mechanics: the allocation rule ──────────────────────────────────────
    gq('kc_allocation_rule', 2, 'hundred_zero',
      'The Buyer must split 100 units between the two Sellers. Which of these is a legal allocation?',
      [
        { value: 'ninety_ten',  label: '90 to Seller 1, 10 to Seller 2' },
        { value: 'hundred_zero', label: '100 to Seller 1, 0 to Seller 2' },
        { value: 'fifty_fortyfive', label: '50 to Seller 1, 45 to Seller 2' },
        { value: 'fifteen_eightyfive', label: '15 to Seller 1, 85 to Seller 2' },
      ],
      'A legal split must sum to exactly 100 and give each Seller either 0 or at least 20 units. Giving one Seller everything and the other nothing satisfies both halves; splits that leave a Seller with 10 or 15 units break the 20-unit minimum, and a split summing to 95 is not a full contract.'),

    // ── Q3 — Mechanics: the cost of not fixing ───────────────────────────────────
    gq('kc_cost_of_not_fixing', 3, 'buyer_pays_fifteen',
      'A crisis occurs and a Seller allocated 40 units chooses not to fix it. What happens?',
      [
        { value: 'seller_loses_five', label: 'The Seller loses 5 per unit and the Buyer loses nothing' },
        { value: 'buyer_pays_fifteen', label: 'The Seller pays nothing extra and the Buyer pays 15 per unit for those 40 units' },
        { value: 'both_pay_fifteen', label: 'Both the Seller and the Buyer pay 15 per unit' },
        { value: 'nothing_delivered', label: 'The units are not delivered and neither party earns anything' },
      ],
      'An unfixed crisis costs the Seller nothing extra but costs the Buyer 15 per affected unit — here 15 × 40. Fixing would have cost the Seller 5 per unit instead. That 5-versus-15 asymmetry is the engine of the whole game.'),

    // ── Q4 — Conceptual: why the Buyer might not take the lowest price ───────────
    gq('kc_buyer_reliability', 4, 'unfixed_cost_outweighs',
      'Seller 1 bids 14 and Seller 2 bids 25. The Buyer expects that Seller 1 will not fix a crisis and Seller 2 will. Why might the Buyer allocate substantial units to Seller 2 despite the higher price?',
      [
        { value: 'min_twenty_rule', label: 'The allocation rule requires giving each Seller at least 20 units' },
        { value: 'unfixed_cost_outweighs', label: 'A crisis occurs half the time, and unfixed units cost the Buyer 15 each — which can outweigh the 11 per unit saved on price' },
        { value: 'raises_value', label: 'Allocating to the higher bidder increases the Buyer’s value per unit above 30' },
        { value: 'price_irrelevant', label: 'The Buyer’s profit does not depend on the prices paid' },
      ],
      'Price is not the only cost. An expected repair exposure of 15 per unit half the time can more than eat up the per-unit price saving, so the Buyer pays more to a Seller who will fix. The 20-unit minimum is a real rule but would not justify moving substantial units beyond 20.'),

    // ── Q5 — Conceptual: the Seller's core tradeoff ──────────────────────────────
    gq('kc_seller_tradeoff', 5, 'low_bid_thin_margin',
      'A Seller is deciding what to bid in an early round. What is the central tension?',
      [
        { value: 'below_cost', label: 'Bidding below cost is necessary to win any allocation' },
        { value: 'low_bid_thin_margin', label: 'A low bid wins more units but leaves less margin to absorb the cost of fixing a crisis' },
        { value: 'buyer_blind', label: 'The Buyer cannot see the bids, so the bid amount does not affect allocation' },
        { value: 'fixing_free', label: 'Fixing the crisis is free, so price is the only decision that matters' },
      ],
      'The bid and the fix decision are linked. A lower bid attracts more units but thins the per-unit margin that has to cover the repair cost when a crisis hits — so a Seller who bids very low may not be able to afford to fix.'),

    // ── Q6 — Conceptual: why repetition changes behavior ─────────────────────────
    gq('kc_reputation', 6, 'history_costs_future',
      'This game is played for 10 rounds with the same three people, and everyone sees the full history. How does this change a Seller’s incentives compared to playing only once?',
      [
        { value: 'no_change', label: 'It does not change them — each round’s payoff is calculated independently' },
        { value: 'history_costs_future', label: 'Refusing to fix a crisis saves money now but may cost future allocations once the Buyer sees the history' },
        { value: 'buyer_must_be_fair', label: 'The Buyer must allocate evenly across rounds to be fair' },
        { value: 'sellers_collude', label: 'Sellers can coordinate on a price because they observe each other’s bids' },
      ],
      'Because the Buyer sees every past fix decision and allocates again next round, a refusal that saves money now can lose future business — reputation. Sellers do see each other’s past bids, but within a round bids are simultaneous and unenforceable, so that is not what makes repetition matter.'),

    // ── Q7 — Conceptual: the last round ──────────────────────────────────────────
    gq('kc_last_round', 7, 'weaker_no_future',
      'Consider the final round of the game. How does a Seller’s incentive to fix a crisis in round 10 differ from round 3?',
      [
        { value: 'stronger_grade', label: 'It is stronger, because the final round determines the grade' },
        { value: 'weaker_no_future', label: 'It is weaker, because there are no future rounds in which the Buyer can respond' },
        { value: 'unchanged_costs', label: 'It is unchanged, because the Buyer’s costs are the same in every round' },
        { value: 'cannot_choose', label: 'Sellers cannot choose whether to fix in the final round' },
      ],
      'In the last round there is no future allocation left to protect, so the reputational reason to fix disappears and the incentive to fix is weaker. Note that the final round does not determine any grade — profit is never graded.'),

    // ── Q8 — Conceptual: competition between the Sellers ─────────────────────────
    gq('kc_price_competition', 8, 'undercut_toward_cost',
      'The two Sellers submit prices simultaneously and cannot communicate. What pressure does this create?',
      [
        { value: 'undercut_toward_cost', label: 'Each Seller wants to bid just low enough to win the larger allocation, which pushes prices toward cost' },
        { value: 'both_bid_high', label: 'Both Sellers benefit from bidding as high as possible, since the Buyer must buy 100 units' },
        { value: 'second_mover', label: 'The Seller who bids second has an advantage' },
        { value: 'random_allocation', label: 'Prices have no effect because allocation is random' },
      ],
      'Wanting the larger share pushes each Seller to undercut the other, driving prices down toward cost. Bidding is simultaneous, so there is no second-mover advantage, and the shared hope of both bidding high is exactly the collusive intuition that simultaneous, unenforceable bidding defeats.'),

    // ── Q9 — Conceptual: what the Buyer is really buying ─────────────────────────
    gq('kc_buying_reliability', 9, 'will_they_fix',
      'Across ten rounds, what is the Buyer actually trying to learn about each Seller?',
      [
        { value: 'production_cost', label: 'Their production cost, which is private' },
        { value: 'will_they_fix', label: 'Whether they will fix a crisis when one occurs — which price alone does not reveal' },
        { value: 'capacity', label: 'How many units they can produce per round' },
        { value: 'preference', label: 'Which Seller the other Seller prefers' },
      ],
      'The Buyer is buying reliability, not just units: the key unknown is whether a Seller will fix a crisis, and a low price does not reveal that. Cost is not the unknown here — it is common knowledge (10) and shown on screen.'),
  ],

  // Legacy stub fields — must be present but content is served via prepDefaults above.
  content: {
    infoPDFs:      {} as Record<string, { private: string; public?: string }>,
    kcQuestions:   [],
    prepQuestions: [],
    scenarioText:  {},
  },
}
