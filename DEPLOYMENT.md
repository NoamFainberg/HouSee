# Deployment guide

HouSee is built as a **local-first POC**. The full pipeline (upload → generate → stitch → download) works on your machine. Cloud deployment needs a few extra pieces.

## Repos and hosting

| Service | URL |
|---------|-----|
| GitHub | [github.com/NoamFainberg/HouSee](https://github.com/NoamFainberg/HouSee) |
| Vercel (UI + API routes) | [housee.vercel.app](https://housee.vercel.app) |
| Vercel dashboard | [vercel.com/noam-fainbergs-projects/housee](https://vercel.com/noam-fainbergs-projects/housee) |

Pushes to `main` trigger a Vercel production deploy automatically.

## Local development (recommended)

This is the supported path today.

**Requirements**

- Node 20+
- `ffmpeg` (`brew install ffmpeg`)
- Higgsfield API keys
- Optional: OpenAI or Gemini key for room tagging and transition prompts

```bash
cp .env.example .env.local
# fill HF_API_KEY_ID and HF_API_KEY_SECRET
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Vercel: what works today

The Next.js app **builds and deploys** on Vercel. You can share the UI and API route structure.

**What does not work on stock Vercel serverless:**

1. **Persistent storage** — tours live under `data/tours/` on disk. Serverless functions have an ephemeral filesystem; uploads and generated videos disappear between invocations.
2. **ffmpeg** — stitching (`src/lib/stitch.ts`) shells out to `ffmpeg`, which is not available in the default Vercel runtime.
3. **Long-running jobs** — each transition clip polls Higgsfield for up to ~12 minutes. Serverless timeouts (10s hobby / 60s pro on standard functions) will kill inline generation.
4. **Background work** — the default `PIPELINE_DRIVER=inline` fires the pipeline in-process after the HTTP response. That pattern is unreliable on serverless.

**Bottom line:** use Vercel for previews and frontend work; run the real pipeline locally until storage and jobs are moved off disk.

## Vercel environment variables

In **Vercel → housee → Settings → Environment Variables**, add the same keys as `.env.local`:

| Variable | Required | Notes |
|----------|----------|-------|
| `HF_API_KEY_ID` | Yes (for generate) | Higgsfield Cloud |
| `HF_API_KEY_SECRET` | Yes (for generate) | Higgsfield Cloud |
| `OPENAI_API_KEY` | No | Vision tagging + transition prompts |
| `GOOGLE_GENERATIVE_AI_API_KEY` | No | Alternative vision provider |
| `HF_TRANSITION_MODEL` | No | Default: `higgsfield-ai/dop/turbo` |
| `HF_CLIP_DURATION` | No | Default: `4` |
| `HF_GENERATION_CONCURRENCY` | No | Default: `2` |
| `PIPELINE_DRIVER` | No | Set to `inngest` when using Inngest (see below) |

After adding or changing variables, **Redeploy** from the Vercel dashboard.

Never commit `.env.local` — only `.env.example` (placeholders) is in git.

## Path to production on Vercel

The codebase already has hooks for the first two steps. The rest is planned work.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│   Browser   │────▶│ Vercel API   │────▶│   Inngest   │────▶│  Higgsfield  │
│  (Next.js)  │     │   routes     │     │  (jobs)     │     │     API      │
└─────────────┘     └──────┬───────┘     └──────┬──────┘     └──────────────┘
                           │                    │
                           ▼                    ▼
                    ┌──────────────┐     ┌─────────────┐
                    │ Blob storage │     │ ffmpeg worker│
                    │ (R2 / S3)    │     │ (Fly/Railway)│
                    └──────────────┘     └─────────────┘
```

### Phase 1 — Background jobs (partially wired)

**Goal:** generation survives HTTP timeouts and serverless cold starts.

**Already in repo:**

- `src/inngest/client.ts`, `src/inngest/functions.ts`
- `src/app/api/inngest/route.ts`
- `PIPELINE_DRIVER=inngest` in `src/lib/env.ts`

**To enable:**

1. Create an [Inngest](https://www.inngest.com/) account and app.
2. Connect Inngest to your Vercel project (Inngest dashboard → Vercel integration).
3. Set `PIPELINE_DRIVER=inngest` in Vercel env.
4. Deploy. Inngest serves `/api/inngest` and runs `runTourPipeline` outside the request lifecycle.

**Still needed:** persistent storage (Phase 2) so jobs read/write the same tour data across steps.

### Phase 2 — Replace local disk with blob storage

**Goal:** photos, clips, and master MP4 survive across requests.

**Replace** `src/lib/store.ts` disk I/O with an abstraction, e.g.:

- [Vercel Blob](https://vercel.com/docs/storage/vercel-blob) (simplest on Vercel)
- Cloudflare R2 or AWS S3 (cheaper at scale)

**Files to touch:**

- `readPhotoBytes`, `writeClipBytes`, `writeMasterBytes`, `readTourRecord` / `mutateTour`
- `src/app/api/media/[tourId]/[...path]/route.ts` — serve from signed blob URLs or proxy

**Tour metadata** (JSON today in `tour.json`) moves to a database:

- [Vercel Postgres](https://vercel.com/docs/storage/vercel-postgres) or [Supabase](https://supabase.com/) for tours, photos, clips, status fields

### Phase 3 — ffmpeg outside serverless

**Goal:** stitch clips into a master MP4.

**Options (pick one):**

| Approach | Pros | Cons |
|----------|------|------|
| **Fly.io / Railway Docker** | Full `ffmpeg`, long timeouts | Separate service to deploy |
| **AWS Lambda layer + ffmpeg** | Stays serverless | Complex packaging, size limits |
| **External API** (e.g. Creatomate, Shotstack) | No ops | Cost, vendor lock-in |
| **Skip stitch on Vercel** | Ship individual clip URLs | No single download MP4 |

Recommended for POC → prod: a small **Docker worker** on Fly.io that pulls clips from blob storage, runs the existing `stitchTour` logic, uploads `master.mp4`, updates tour status.

### Phase 4 — Hardening

- Auth (Clerk, NextAuth) if multi-user
- Rate limits on `/api/tours/*/generate`
- Webhook from Higgsfield instead of polling (when supported)
- Credit / usage tracking per user

## Alternative: deploy everything on a VM

Fastest way to get cloud hosting **without** refactoring storage:

1. Deploy the repo on **Railway**, **Fly.io**, or a small **VPS**
2. Install `ffmpeg` in the image
3. Mount a persistent volume at `data/tours/`
4. Run `npm run build && npm start` (or Docker)

This keeps the current codebase unchanged and avoids Vercel’s serverless constraints.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Generate returns 400 “Higgsfield not configured” | Missing env on Vercel | Add `HF_API_KEY_*`, redeploy |
| Upload works locally, empty on Vercel | Ephemeral disk | Phase 2 blob storage |
| “ffmpeg is not installed” | Serverless runtime | Phase 3 worker or local dev |
| Stuck on “Generating…” then fails | Function timeout | `PIPELINE_DRIVER=inngest` + Inngest |
| Vision warnings in logs | Invalid `OPENAI_API_KEY` | Fix key or remove it (fallback tagging still works) |

## Quick reference: deploy commands

```bash
# Push to GitHub (triggers Vercel if connected)
git push origin main

# Manual Vercel production deploy
npx vercel --prod

# Link local folder to existing Vercel project
npx vercel link --project housee
```
