import DisasterDashboard from './components/DisasterDashboard'
import { ToastProvider } from './components/ui/ToastProvider'

export default function App() {
  return (
    <ToastProvider>
      <div style={{ height: '100vh', width: '100vw', overflow: 'hidden' }}>
        <DisasterDashboard />
      </div>
    </ToastProvider>
  )
}
