<div align="center">

<img src="resources/icon.png" width="96" height="96" alt="Cueflow logo" />

# Cueflow

**Automated meeting recorder triggered by email**

[![Release](https://img.shields.io/github/v/release/Dushmantha-Amarasinghe/cueflow?style=flat-square&color=7c3aed)](https://github.com/Dushmantha-Amarasinghe/cueflow/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)](https://github.com/Dushmantha-Amarasinghe/cueflow/releases)
[![License](https://img.shields.io/github/license/Dushmantha-Amarasinghe/cueflow?style=flat-square)](LICENSE)
[![Stars](https://img.shields.io/github/stars/Dushmantha-Amarasinghe/cueflow?style=flat-square)](https://github.com/Dushmantha-Amarasinghe/cueflow/stargazers)

Cueflow watches your Gmail inbox for meeting invitation emails, extracts the schedule from ICS attachments, then automatically joins and records the meeting — even when you're away from your computer.

[**Download Latest**](https://github.com/Dushmantha-Amarasinghe/cueflow/releases/latest) · [Report a Bug](https://github.com/Dushmantha-Amarasinghe/cueflow/issues) · [Request a Feature](https://github.com/Dushmantha-Amarasinghe/cueflow/issues)

</div>

---

## ✨ Features

- **Email-triggered automation** — watches Gmail via IMAP, no OAuth required (App Password only)
- **ICS/calendar aware** — parses `.ics` attachments and recurring events to schedule recordings in advance
- **Flows** — modular, named automation pipelines; run multiple flows in parallel with independent rules
- **ffmpeg recording** — bundled ffmpeg, no OBS needed; records desktop + system audio (WASAPI loopback)
- **MKV → MP4 remux** on clean stop — crash-safe intermediate format, fast container conversion at the end
- **Multi-monitor support** — pick exactly which screen to record
- **Telegram bot** — rich notifications with inline buttons; control recordings from your phone
- **Auto-update** — checks GitHub Releases on startup and notifies you when a new version is available
- **100% local** — no cloud, no central server, no subscription

## 📥 Download

Head to [**Releases**](https://github.com/Dushmantha-Amarasinghe/cueflow/releases/latest) and grab the latest `.exe` installer for Windows.

| File | Description |
|------|-------------|
| `Cueflow-Setup-x.x.x.exe` | Windows installer (recommended) |

> **Requirements:** Windows 10 / 11 (64-bit). Zoom, Teams, or any meeting app already installed.

## 🚀 Getting started

1. Run the installer — ffmpeg is bundled, nothing else to install
2. On first launch the setup wizard guides you through:
   - **Gmail** — enter your address + a [Google App Password](https://myaccount.google.com/apppasswords)
   - **Telegram** *(optional)* — paste your bot token + chat ID for phone notifications
3. Go to **Flows → New Flow**, set a subject filter (e.g. `"Zoom"`) and choose your meeting type
4. That's it — Cueflow monitors your inbox and records matching meetings automatically

## 🔧 Configuration

### Gmail App Password

Google App Passwords let Cueflow access your inbox without your real password and without OAuth.

1. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Create an app password for **Mail**
3. Paste the 16-character password into Cueflow → Settings → Connections

### Telegram bot (optional)

1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot`
2. Copy the bot token into Settings → Connections → Telegram
3. Find your Chat ID with [@userinfobot](https://t.me/userinfobot)
4. Press **Connect & Test** — you'll receive a test message immediately

### Recording settings

| Setting | Default | Notes |
|---------|---------|-------|
| Save folder | `Documents\Cueflow\Recordings` | Subfolders per flow optional |
| Resolution | Full screen (native) | Can scale down to 1080p, 720p, etc. |
| Frame rate | 30 fps | |
| Codec | H.264 | H.265 also available |
| Audio | System audio (WASAPI loopback) | Falls back to video-only if unavailable |
| Screen | All screens | Pick a specific monitor in Settings |

## 🏗️ Building from source

```bash
# Prerequisites: Node.js 18+, Git

git clone https://github.com/Dushmantha-Amarasinghe/cueflow.git
cd cueflow
npm install

# Development (hot reload)
npm run dev

# Build installer
npm run dist
```

The installer will be in `dist/`.

## 📦 Tech stack

| Layer | Technology |
|-------|-----------|
| UI | Electron + React + Tailwind CSS |
| Recording | ffmpeg (bundled binary) |
| Email | imapflow + mailparser |
| Scheduling | node-ical + rrule-temporal + node-schedule |
| Notifications | Telegraf (Telegram Bot API) |
| Storage | JSON files (local, encrypted credentials via Electron safeStorage) |
| Auto-update | electron-updater + GitHub Releases |

## 🤝 Contributing

Pull requests are welcome. For major changes please open an issue first.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push and open a PR

## ❤️ Support

If Cueflow saves you time, consider supporting development:

[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-blue?style=flat-square&logo=paypal)](https://paypal.me/DushmanthaAmarasinghe)

## 📄 License

[MIT](LICENSE) — free to use, modify, and distribute.

---

<div align="center">
Made by <a href="https://github.com/Dushmantha-Amarasinghe">Dushmantha Amarasinghe</a>
</div>
