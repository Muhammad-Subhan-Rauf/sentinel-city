// ============================================================
// AuthGate.jsx — wraps the app with a Supabase login wall
// ============================================================
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabaseClient'

export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined) // undefined = loading
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('login') // 'login' | 'signup'

  useEffect(() => {
    // Bootstrap existing session
    supabase.auth.getSession().then(({ data }) => setSession(data.session))

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  const handleAuth = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const fn =
      mode === 'login'
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({ email, password })

    const { error } = await fn
    if (error) setError(error.message)
    setLoading(false)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
  }

  // ── Loading state ──────────────────────────────────────────
  if (session === undefined) {
    return (
      <div className="flex items-center justify-center h-full bg-[#0a0e1a]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-full border-2 border-[#f97316] border-t-transparent animate-spin" />
          <span className="text-[#6b82a8] text-sm tracking-widest uppercase">Initializing</span>
        </div>
      </div>
    )
  }

  // ── Authenticated — render children with sign-out available ─
  if (session) {
    return (
      <>
        {children}
        {/* Floating sign-out badge */}
        <button
          id="btn-sign-out"
          onClick={handleSignOut}
          className="fixed bottom-4 right-4 z-[1000] flex items-center gap-2 px-3 py-1.5 rounded-md
                     bg-[#0f1629] border border-[#1e2d4d] text-[#6b82a8] text-xs
                     hover:border-[#f97316] hover:text-[#f97316] transition-all"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] status-blink" />
          {session.user.email}
          <span className="ml-1 text-[#4b6082]">· Sign out</span>
        </button>
      </>
    )
  }

  // ── Login / Sign-up form ───────────────────────────────────
  return (
    <div className="flex items-center justify-center h-full bg-[#0a0e1a]">
      {/* Background grid */}
      <div
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage: 'linear-gradient(rgba(249,115,22,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(249,115,22,0.15) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <div className="relative z-10 w-full max-w-md animate-[fadeIn_0.5s_ease-out]">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-md bg-[#f97316] flex items-center justify-center shadow-[0_0_20px_rgba(249,115,22,0.5)]">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Sentinel<span className="text-[#f97316]">-</span>City</h1>
          </div>
          <p className="text-[#6b82a8] text-sm">Disaster Orchestration Platform</p>
        </div>

        {/* Card */}
        <div className="bg-[#0f1629] border border-[#1e2d4d] rounded-xl p-8 shadow-[0_0_60px_rgba(0,0,0,0.5)]">
          <h2 className="text-white font-semibold text-lg mb-6">
            {mode === 'login' ? 'Operator Login' : 'Create Account'}
          </h2>

          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleAuth} className="space-y-4">
            <div>
              <label className="block text-[#6b82a8] text-xs font-medium mb-1.5 uppercase tracking-wider">
                Email
              </label>
              <input
                id="input-email"
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="operator@sentinel.city"
                className="w-full bg-[#141d35] border border-[#1e2d4d] rounded-lg px-4 py-2.5
                           text-[#c9d6f0] placeholder-[#4b6082] text-sm
                           focus:outline-none focus:border-[#f97316] focus:shadow-[0_0_0_2px_rgba(249,115,22,0.15)]
                           transition-all"
              />
            </div>

            <div>
              <label className="block text-[#6b82a8] text-xs font-medium mb-1.5 uppercase tracking-wider">
                Password
              </label>
              <input
                id="input-password"
                type="password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-[#141d35] border border-[#1e2d4d] rounded-lg px-4 py-2.5
                           text-[#c9d6f0] placeholder-[#4b6082] text-sm
                           focus:outline-none focus:border-[#f97316] focus:shadow-[0_0_0_2px_rgba(249,115,22,0.15)]
                           transition-all"
              />
            </div>

            <button
              id="btn-auth-submit"
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg font-semibold text-white text-sm
                         bg-[#f97316] hover:bg-[#ea6c0a]
                         shadow-[0_0_20px_rgba(249,115,22,0.35)]
                         hover:shadow-[0_0_30px_rgba(249,115,22,0.55)]
                         disabled:opacity-50 disabled:cursor-not-allowed
                         transition-all active:scale-[0.98]"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Authenticating…
                </span>
              ) : mode === 'login' ? 'Access Command Center' : 'Create Operator Account'}
            </button>
          </form>

          <p className="mt-4 text-center text-[#6b82a8] text-xs">
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <button
              onClick={() => { setMode(m => m === 'login' ? 'signup' : 'login'); setError(null) }}
              className="text-[#f97316] hover:underline"
            >
              {mode === 'login' ? 'Sign up' : 'Log in'}
            </button>
          </p>
        </div>
      </div>
    </div>
  )
}
