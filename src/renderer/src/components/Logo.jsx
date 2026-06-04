import React from 'react'
import logo from '../assets/logo.png'

// Cueflow brand mark — the violet "C" icon.
// size = pixel width/height; rounded keeps the existing app aesthetic.
export default function Logo({ size = 24, className = '', rounded = true }) {
  return (
    <img
      src={logo}
      width={size}
      height={size}
      alt="Cueflow"
      draggable={false}
      className={`${rounded ? 'rounded-[22%]' : ''} select-none ${className}`}
      style={{ width: size, height: size }}
    />
  )
}
