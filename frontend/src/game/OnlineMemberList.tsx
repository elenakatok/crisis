import { colors, typography, spacing } from '@mygames/game-ui'
import type { OnlineMember } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// OnlineMemberList — the shared Crisis-side group-member presentation used by BOTH the group
// reveal (OnlineGroupReveal) and the pre-round waiting screen (CrisisGame.PreGameWaiting): full
// list, display name + email as a mailto link. One source of markup — never duplicated.
//
// Pass `arrived` (the group doc's arrival set) to additionally mark each member "here" /
// "not here yet" live — used on the waiting screen so a student can see WHO is still missing,
// not just how many. Omit it (reveal) and no status is shown.
// ═══════════════════════════════════════════════════════════════════════════════

const MAILTO_SUBJECT = encodeURIComponent('Crisis game — scheduling a time to play')

export default function OnlineMemberList({
  members, participantId, arrived,
}: {
  members: OnlineMember[]
  participantId: string
  arrived?: Set<string>
}) {
  const showStatus = arrived != null
  return (
    <ul
      data-testid="crisis-member-list"
      style={{ listStyle: 'none', padding: 0, margin: `${spacing.gapMd} 0`, display: 'grid', gap: spacing.gapSm }}
    >
      {members.map((m) => {
        const isYou = m.participant_id === participantId
        const here = isYou || (arrived?.has(m.participant_id) ?? false) // you are here by definition
        return (
          <li
            key={m.participant_id}
            data-testid="crisis-member-item"
            style={{
              padding: `${spacing.gapSm} ${spacing.gapMd}`,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              background: isYou ? colors.confirmBg : colors.surfaceSubtle,
              display: 'flex',
              alignItems: 'baseline',
              gap: spacing.gapMd,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontWeight: isYou ? 700 : 600, color: colors.textStrong, overflowWrap: 'anywhere' }}>
              {m.display_name}{isYou && ' · you'}
            </span>
            {m.email ? (
              <a
                data-testid="crisis-member-email"
                href={`mailto:${m.email}?subject=${MAILTO_SUBJECT}`}
                style={{ fontSize: typography.sizeXs, color: colors.textMuted, overflowWrap: 'anywhere' }}
              >
                {m.email}
              </a>
            ) : (
              <span style={{ fontSize: typography.sizeXs, color: colors.textMuted }}>no email on file</span>
            )}
            {showStatus && (
              <span
                data-testid="crisis-member-status"
                data-here={String(here)}
                style={{ marginLeft: 'auto', fontSize: typography.sizeXs, fontWeight: 600, color: here ? colors.successText : colors.textMuted }}
              >
                {here ? '● here' : '○ not here yet'}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
