# Routstr Platform

Routstr Platform is a client-only Next.js app for managing Routstr developer workflows:

- Home quickstart and setup checks
- Playground for testing requests
- API key management
- Wallet flows (NIP-60 / Lightning / Cashu)

## Stack

- Next.js 16 (App Router)
- React 19
- TypeScript
- Tailwind CSS 4
- Radix + shadcn/ui

## Requirements

- Node.js 20+
- npm

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Scripts

```bash
npm run dev      # Start dev server (Turbopack)
npm run build    # Production build
npm run start    # Run production server
npm run lint     # Run lint script
```

## Project Structure

```text
app/         # Routes (home, playground, api-keys, wallet, login)
components/  # UI and feature components
context/     # Auth and shared context providers
hooks/       # App hooks
lib/         # Utilities and wallet helpers
```