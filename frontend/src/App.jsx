import AuthGate from './components/AuthGate'
import DisasterDashboard from './components/DisasterDashboard'

export default function App() {
  return (
    <div style={{ height: '100vh', width: '100vw', overflow: 'hidden' }}>
      <AuthGate>
        <DisasterDashboard />
      </AuthGate>
    </div>
  )
}
