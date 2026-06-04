import React, { useState } from 'react'
import { Mail, MessageCircle, Check, Eye, EyeOff, ArrowRight, ChevronLeft, ExternalLink, Zap, Video, Bell } from 'lucide-react'
import Logo from '../components/Logo'

// ─── Step indicator ────────────────────────────────────────────────────────────

function Steps({ current, total }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className={`h-1 rounded-full transition-all duration-300 ${
          i < current ? 'w-6 bg-violet-500' :
          i === current ? 'w-8 bg-violet-500' :
          'w-4 bg-zinc-700'
        }`} />
      ))}
    </div>
  )
}

// ─── Shared input components ───────────────────────────────────────────────────

function Field({ label, description, children }) {
  return (
    <div className="space-y-1.5">
      <div>
        <p className="text-sm font-medium text-zinc-200">{label}</p>
        {description && <p className="text-xs text-zinc-500 mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  )
}

function Input({ type = 'text', value, onChange, placeholder, className = '' }) {
  return (
    <input
      type={type} value={value} onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full px-3 py-2.5 rounded-xl bg-zinc-800/80 border border-zinc-700 text-sm text-zinc-100
        placeholder-zinc-600 focus:outline-none focus:border-violet-500/70 transition-colors ${className}`}
    />
  )
}

function StatusBadge({ status, error }) {
  if (!status) return null
  if (status === 'connected') return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-green-400 bg-green-500/10 px-2.5 py-1 rounded-full">
      <Check size={11} /> Connected
    </span>
  )
  if (status === 'error') return (
    <span className="text-xs text-red-400 bg-red-500/10 px-2.5 py-1 rounded-full truncate max-w-xs">{error || 'Failed'}</span>
  )
  return <span className="text-xs text-amber-400">Testing…</span>
}

// ─── Step 0: Welcome ───────────────────────────────────────────────────────────

function StepWelcome({ onNext, onSkip }) {
  return (
    <div className="flex flex-col items-center text-center space-y-8">
      {/* Logo */}
      <div className="flex flex-col items-center gap-4">
        <Logo size={64} className="shadow-lg shadow-violet-500/30" />
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Welcome to Cueflow</h1>
          <p className="text-sm text-zinc-500 mt-1.5">Your automated meeting recorder</p>
        </div>
      </div>

      {/* Feature bullets */}
      <div className="w-full space-y-3">
        {[
          { icon: Mail,  color: 'text-violet-400', bg: 'bg-violet-500/10', label: 'Watches your inbox', desc: 'Detects meeting invitation emails automatically' },
          { icon: Video, color: 'text-green-400',  bg: 'bg-green-500/10',  label: 'Joins & records',    desc: 'Opens Zoom, Teams, or Meet and starts recording' },
          { icon: Bell,  color: 'text-amber-400',  bg: 'bg-amber-500/10',  label: 'Keeps you informed', desc: 'Sends Telegram notifications when recordings complete' },
        ].map(({ icon: Icon, color, bg, label, desc }) => (
          <div key={label} className="flex items-center gap-3 p-3 rounded-xl bg-zinc-900 border border-zinc-800 text-left">
            <div className={`w-8 h-8 rounded-lg ${bg} flex items-center justify-center flex-shrink-0`}>
              <Icon size={15} className={color} />
            </div>
            <div>
              <p className="text-sm font-medium text-zinc-200">{label}</p>
              <p className="text-xs text-zinc-500">{desc}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="w-full space-y-3">
        <button onClick={onNext}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold transition-colors shadow-lg shadow-violet-600/20">
          Get started <ArrowRight size={16} />
        </button>
        <button onClick={onSkip} className="w-full text-xs text-zinc-600 hover:text-zinc-400 transition-colors py-1">
          Skip setup — configure later in Settings
        </button>
      </div>
    </div>
  )
}

// ─── Step 1: Gmail ─────────────────────────────────────────────────────────────

function StepGmail({ onNext, onBack, onSkip }) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [showPwd,  setShowPwd]  = useState(false)
  const [status,   setStatus]   = useState(null)
  const [error,    setError]    = useState('')

  const test = async () => {
    if (!email || !password) { setError('Both fields are required'); return }
    setStatus('testing'); setError('')
    const r = await window.cueflow?.settings.testGmail({ email, password })
    if (r?.success) {
      setStatus('connected')
      await window.cueflow?.settings.save({ gmail: { email, password } })
    } else {
      setStatus('error'); setError(r?.error || 'Connection failed')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-violet-500/15 flex items-center justify-center flex-shrink-0">
          <Mail size={18} className="text-violet-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-zinc-100">Connect Gmail</h2>
          <p className="text-xs text-zinc-500">Cueflow needs to watch your inbox for meeting invites</p>
        </div>
      </div>

      <div className="space-y-4">
        <Field label="Gmail address">
          <Input value={email} onChange={setEmail} placeholder="you@gmail.com" />
        </Field>

        <Field label="App Password" description="16-character Google App Password — not your account password">
          <div className="relative">
            <Input type={showPwd ? 'text' : 'password'} value={password} onChange={setPassword} placeholder="xxxx xxxx xxxx xxxx" className="pr-10" />
            <button onClick={() => setShowPwd(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
              {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </Field>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center gap-3">
          <button onClick={test} disabled={status === 'testing'}
            className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-sm font-medium text-white transition-colors">
            {status === 'testing' ? 'Testing…' : 'Test & Connect'}
          </button>
          <StatusBadge status={status} error={error} />
          <button
            onClick={() => window.cueflow?.shell.openExternal('https://myaccount.google.com/apppasswords')}
            className="ml-auto flex items-center gap-1 text-xs text-zinc-600 hover:text-violet-400 transition-colors">
            <ExternalLink size={11} /> Get App Password
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
          <ChevronLeft size={16} /> Back
        </button>
        <div className="flex items-center gap-2">
          <button onClick={onSkip} className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors px-3 py-2">
            Skip
          </button>
          <button onClick={onNext} disabled={status !== 'connected'}
            className="flex items-center gap-2 px-5 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-sm font-medium text-white transition-colors">
            Next <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Step 2: Telegram ──────────────────────────────────────────────────────────

function StepTelegram({ onNext, onBack, onSkip }) {
  const [token,   setToken]   = useState('')
  const [chatId,  setChatId]  = useState('')
  const [showTok, setShowTok] = useState(false)
  const [status,  setStatus]  = useState(null)
  const [error,   setError]   = useState('')

  const test = async () => {
    if (!token) { setError('Bot token is required'); return }
    setStatus('testing'); setError('')
    const r = await window.cueflow?.settings.testTelegram({ botToken: token, chatId })
    if (r?.success) {
      setStatus('connected')
      // Merge into existing settings
      const current = await window.cueflow?.settings.get()
      await window.cueflow?.settings.save({ ...current, telegram: { botToken: token, chatId } })
    } else {
      setStatus('error'); setError(r?.error || 'Connection failed')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-blue-500/15 flex items-center justify-center flex-shrink-0">
          <MessageCircle size={18} className="text-blue-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-zinc-100">Telegram Notifications</h2>
          <p className="text-xs text-zinc-500">Get alerts when recordings start, finish, or fail</p>
        </div>
        <span className="ml-auto px-2 py-0.5 rounded-full bg-zinc-800 border border-zinc-700 text-xs text-zinc-500">Optional</span>
      </div>

      <div className="space-y-4">
        <Field label="Bot token" description="Create a bot with @BotFather and paste the token here">
          <div className="relative">
            <Input type={showTok ? 'text' : 'password'} value={token} onChange={setToken} placeholder="123456:ABC-DEF…" className="pr-10" />
            <button onClick={() => setShowTok(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
              {showTok ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </Field>

        <Field label="Your Chat ID" description="Send /start to your bot, then use @userinfobot to find your ID">
          <Input value={chatId} onChange={setChatId} placeholder="123456789" />
        </Field>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center gap-3">
          <button onClick={test} disabled={status === 'testing'}
            className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-sm font-medium text-white transition-colors">
            {status === 'testing' ? 'Testing…' : 'Test & Connect'}
          </button>
          <StatusBadge status={status} error={error} />
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
          <ChevronLeft size={16} /> Back
        </button>
        <div className="flex items-center gap-2">
          <button onClick={onSkip} className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors px-3 py-2">
            Skip
          </button>
          <button onClick={onNext} disabled={status !== 'connected'}
            className="flex items-center gap-2 px-5 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-sm font-medium text-white transition-colors">
            Next <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Step 3: Done ──────────────────────────────────────────────────────────────

function StepDone({ onFinish, gmailEmail, telegramConnected }) {
  return (
    <div className="flex flex-col items-center text-center space-y-8">
      <div className="flex flex-col items-center gap-4">
        <div className="w-16 h-16 rounded-full bg-green-500/15 flex items-center justify-center">
          <Check size={32} className="text-green-400" />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-zinc-100">You're all set!</h2>
          <p className="text-sm text-zinc-500 mt-1.5">Cueflow is ready to automate your recordings</p>
        </div>
      </div>

      <div className="w-full space-y-2.5">
        <div className="flex items-center gap-3 p-3 rounded-xl bg-zinc-900 border border-zinc-800 text-left">
          <div className="w-7 h-7 rounded-lg bg-green-500/10 flex items-center justify-center flex-shrink-0">
            <Check size={13} className="text-green-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-200">Gmail connected</p>
            <p className="text-xs text-zinc-500 truncate">{gmailEmail}</p>
          </div>
        </div>

        <div className={`flex items-center gap-3 p-3 rounded-xl border text-left ${
          telegramConnected ? 'bg-zinc-900 border-zinc-800' : 'bg-zinc-900/50 border-zinc-800/50'
        }`}>
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
            telegramConnected ? 'bg-green-500/10' : 'bg-zinc-800'
          }`}>
            {telegramConnected
              ? <Check size={13} className="text-green-400" />
              : <MessageCircle size={13} className="text-zinc-600" />
            }
          </div>
          <div>
            <p className={`text-sm font-medium ${telegramConnected ? 'text-zinc-200' : 'text-zinc-600'}`}>
              {telegramConnected ? 'Telegram connected' : 'Telegram — not set up'}
            </p>
            <p className="text-xs text-zinc-500">{telegramConnected ? 'Notifications enabled' : 'Add later in Settings → Connections'}</p>
          </div>
        </div>

        <div className="flex items-center gap-3 p-3 rounded-xl bg-zinc-900/50 border border-zinc-800/50 text-left">
          <div className="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center flex-shrink-0">
            <Zap size={13} className="text-zinc-500" />
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-500">Create your first Flow</p>
            <p className="text-xs text-zinc-600">Set up email → record automation in Flows</p>
          </div>
        </div>
      </div>

      <button onClick={onFinish}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold transition-colors shadow-lg shadow-violet-600/20">
        Open Cueflow <ArrowRight size={16} />
      </button>
    </div>
  )
}

// ─── Main Onboarding component ─────────────────────────────────────────────────

export default function Onboarding({ onComplete }) {
  const [step, setStep] = useState(0)
  const [gmailEmail, setGmailEmail] = useState('')
  const [telegramConnected, setTelegramConnected] = useState(false)

  // Read saved email after gmail step completes
  const handleGmailNext = async () => {
    const s = await window.cueflow?.settings.get()
    setGmailEmail(s?.gmail?.email || '')
    setStep(2)
  }

  const handleTelegramNext = () => {
    setTelegramConnected(true)
    setStep(3)
  }

  const finish = async () => {
    // Mark onboarding done
    const current = await window.cueflow?.settings.get() || {}
    await window.cueflow?.settings.save({ ...current, _onboardingDone: true })
    onComplete()
  }

  const skip = async () => {
    const current = await window.cueflow?.settings.get() || {}
    await window.cueflow?.settings.save({ ...current, _onboardingDone: true })
    onComplete()
  }

  const TOTAL = 3   // gmail, telegram, done

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Progress bar strip at top */}
      <div className="h-0.5 bg-zinc-800 flex-shrink-0">
        <div
          className="h-full bg-violet-500 transition-all duration-500"
          style={{ width: `${(step / 3) * 100}%` }}
        />
      </div>

      <div className="flex-1 flex items-center justify-center overflow-auto p-6">
        <div className="w-full max-w-[420px] space-y-6">
          {/* Step dots (not shown on welcome) */}
          {step > 0 && step < 3 && (
            <div className="flex justify-center">
              <Steps current={step - 1} total={TOTAL} />
            </div>
          )}

          {/* Step content */}
          {step === 0 && <StepWelcome onNext={() => setStep(1)} onSkip={skip} />}
          {step === 1 && <StepGmail onNext={handleGmailNext} onBack={() => setStep(0)} onSkip={() => setStep(2)} />}
          {step === 2 && (
            <StepTelegram
              onNext={handleTelegramNext}
              onBack={() => setStep(1)}
              onSkip={() => setStep(3)}
            />
          )}
          {step === 3 && (
            <StepDone
              onFinish={finish}
              gmailEmail={gmailEmail}
              telegramConnected={telegramConnected}
            />
          )}
        </div>
      </div>
    </div>
  )
}
