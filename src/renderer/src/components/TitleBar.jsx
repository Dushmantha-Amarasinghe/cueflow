import React from 'react'
import { Minus, Square, X } from 'lucide-react'
import Logo from './Logo'

export default function TitleBar() {
  return (
    <div
      className="flex items-center justify-between h-9 px-4 bg-zinc-950 border-b border-zinc-900 flex-shrink-0"
      style={{ WebkitAppRegion: 'drag' }}
    >
      {/* Logo + name */}
      <div className="flex items-center gap-2">
        <Logo size={18} />
        <span className="text-zinc-500 text-xs font-medium tracking-wide">Cueflow</span>
      </div>

      {/* Window controls */}
      <div
        className="flex items-center gap-0.5"
        style={{ WebkitAppRegion: 'no-drag' }}
      >
        <button
          onClick={() => window.cueflow?.window.minimize()}
          className="w-7 h-7 flex items-center justify-center rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          <Minus size={11} />
        </button>
        <button
          onClick={() => window.cueflow?.window.maximize()}
          className="w-7 h-7 flex items-center justify-center rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          <Square size={9} />
        </button>
        <button
          onClick={() => window.cueflow?.window.close()}
          className="w-7 h-7 flex items-center justify-center rounded text-zinc-600 hover:text-white hover:bg-red-500 transition-colors"
        >
          <X size={11} />
        </button>
      </div>
    </div>
  )
}
