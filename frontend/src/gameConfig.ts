import { type RoleConfig } from '@mygames/game-engine/roles'
import { type OutcomeField, type OutcomeSchema } from '@mygames/game-engine/outcome'

export type { RoleConfig, OutcomeField, OutcomeSchema }

// ── SINGLE undifferentiated MATCHING role — `player` ──────────────────────────────
// A Crisis group is 3 identical players; Buyer / Seller 1 / Seller 2 are assigned
// LATE — immediately before round 1 (spec §2), NOT at match time. The matcher marks
// one member `is_lead`. Mirrors functions/src/gameDefinition.ts crisisConfig.
export const crisisConfig: RoleConfig = {
  roles: [
    { key: 'player', label: 'Player', short: 'P' },
  ],
}

// ── PLACEHOLDER outcome schema ────────────────────────────────────────────────
// Grading is participation-only (spec §4), so outcome CONTENT is scoring-irrelevant.
// The real per-round outcome (bids / allocations / fix decisions / profits) arrives
// with the round loop (Slice 2). Mirrors gameDefinition.ts crisisSchema.
export const crisisSchema: OutcomeSchema = [
  { key: 'placeholder_result', type: 'decimal', min: 0, max: 1_000_000, step: 1 },
  { key: 'notes',              type: 'text' },  // optional free-text; blank = '', excluded from scoring
]

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  placeholder_result: 'Placeholder result',
  notes:              'Notes',
}

export function formatField(field: OutcomeField, value: unknown): string {
  if (field.type === 'integer' || field.type === 'decimal') {
    return typeof value === 'number' ? value.toLocaleString('en-US') : String(value ?? '')
  }
  if (field.type === 'enum')    return String(value ?? '')
  if (field.type === 'boolean') return (value as boolean) ? 'Yes' : 'No'
  return String(value ?? '')
}
