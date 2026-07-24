import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { colors, typography, layout, spacing } from '@mygames/game-ui'
import { db } from '../firebase'
import type { OnlineMember } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// OnlineGroupReveal (Slice O1). The screen an ONLINE student lands on right after login:
// who is in their group (name + email) so they can reach each other and schedule a time to
// play. Crisis-LOCAL and deliberately NOT the shared GroupReveal.tsx — that component drives
// startNegotiation / auto-advances on a negotiation status Crisis does not have.
//
// Reads members[] straight off the group doc (denormalized at grouping time, §4.6): no RTDB
// attending overlay (absent online), no getGroupMemberEmails, no shared email plumbing. LIVE
// via onSnapshot so a re-group before lock is reflected without a reload.
// ═══════════════════════════════════════════════════════════════════════════════

export default function OnlineGroupReveal({
  gameInstanceId,
  groupId,
  participantId,
  onContinue,
}: {
  gameInstanceId: string
  groupId: string
  participantId: string
  onContinue: () => void
}) {
  const [members, setMembers] = useState<OnlineMember[] | null>(null)

  useEffect(() => {
    const ref = doc(db, 'game_instances', gameInstanceId, 'groups', groupId)
    const unsub = onSnapshot(ref, (snap) => {
      const m = snap.exists() ? (snap.data()?.members as OnlineMember[] | undefined) : undefined
      setMembers(Array.isArray(m) ? m : [])
    }, () => setMembers([]))
    return () => unsub()
  }, [gameInstanceId, groupId])

  const mailtoSubject = encodeURIComponent('Crisis game — scheduling a time to play')

  return (
    <main
      data-testid="crisis-online-reveal"
      style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto', fontFamily: typography.fontFamily }}
    >
      <h1 style={{ marginTop: 0 }}>Your group</h1>
      <p style={{ lineHeight: 1.6, marginBottom: spacing.gapMd }}>
        You’ll play Crisis with the two people below. This is an online section, so there’s no
        set class time — <strong>reach out to your group, agree on a time, and play the whole
        game together in one sitting.</strong> Roles (Buyer or Seller) are assigned when the
        game begins.
      </p>

      <ul
        data-testid="crisis-reveal-members"
        style={{ listStyle: 'none', padding: 0, margin: `${spacing.gapMd} 0`, display: 'grid', gap: spacing.gapSm }}
      >
        {(members ?? []).map((m) => {
          const isYou = m.participant_id === participantId
          return (
            <li
              key={m.participant_id}
              data-testid="crisis-reveal-member"
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
                  data-testid="crisis-reveal-email"
                  href={`mailto:${m.email}?subject=${mailtoSubject}`}
                  style={{ fontSize: typography.sizeXs, color: colors.textMuted, overflowWrap: 'anywhere' }}
                >
                  {m.email}
                </a>
              ) : (
                <span style={{ fontSize: typography.sizeXs, color: colors.textMuted }}>no email on file</span>
              )}
            </li>
          )
        })}
      </ul>

      {members && members.length <= 1 && (
        <p style={{ color: colors.textSecondary, marginBottom: spacing.gapMd }}>
          You’re on your own for now — your instructor may add others (or stand-in players) before
          the game begins. Check back here; this list stays current.
        </p>
      )}

      <button data-testid="crisis-reveal-continue" onClick={onContinue} style={{ marginTop: spacing.gapSm }}>
        Continue
      </button>
    </main>
  )
}
