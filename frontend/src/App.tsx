import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { auth, functions } from './firebase'
import Play from './pages/Play'
import InstructorDashboard from './pages/InstructorDashboard'
import Configure from './pages/Configure'
import Reports from './pages/Reports'
import { SettingsPage } from '@mygames/game-ui'

// SINGLE undifferentiated MATCHING role — `player` (Buyer / Seller assigned late, §2).
const crisisRoleLabels: Record<string, string> = {
  player: 'Player',
}

const crisisInfoLinks = [
  { roleKey: 'player', links: [
    { key: 'player_sheet_url', label: 'Game instructions' },
  ]},
]

// Instructor-editable settings beyond role name / sheet. round_seconds is the
// per-decision clock (spec §3.1); num_rounds is fixed at 10 (spec §1.1) but surfaced
// for clarity. Nothing reads either until the round loop (Slice 2).
const crisisConfigSections = [
  {
    id: 'rounds',
    title: 'Rounds',
    fields: [
      { key: 'round_seconds', label: 'Seconds per decision (round clock)', kind: 'positiveInt' as const, placeholder: '120' },
      { key: 'num_rounds',    label: 'Number of rounds',                   kind: 'positiveInt' as const, placeholder: '10' },
    ],
  },
]

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"          element={<Play />} />
        <Route path="/dashboard" element={<InstructorDashboard />} />
        <Route path="/configure" element={<Configure />} />
        <Route path="/reports"   element={<Reports />} />
        <Route path="/settings"  element={
          <SettingsPage
            title="Settings — Crisis"
            functions={functions}
            auth={auth}
            roleLabels={crisisRoleLabels}
            roleInfoLinks={crisisInfoLinks}
            configSections={crisisConfigSections}
          />
        } />
      </Routes>
    </BrowserRouter>
  )
}
