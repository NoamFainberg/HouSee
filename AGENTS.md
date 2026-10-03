<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

HouSee is a single Next.js 16 app. Node 22 and `ffmpeg` are already on the Cloud Agent image.

- Install: `npm ci`, then `cp .env.example .env.local` if `.env.local` is missing. Both are idempotent.
- Dev server: `npm run dev` (defaults to `0.0.0.0:3000`). Lint: `npm run lint`. Production build: `npm run build`. There is no automated test script.
- Creating a listing, uploading photos, and room tagging work without API keys. Filename heuristics tag rooms when `OPENAI_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` are unset.
- Clip generation and stitching need `HF_API_KEY_ID` and `HF_API_KEY_SECRET` (Higgsfield Cloud). Without them, `POST /api/tours/:id/generate` returns 400. Do not invent keys.
- Tour photos, clips, and `tour.json` are written under `data/tours/` (gitignored). `ffmpeg` is invoked by `src/lib/stitch.ts` only after clips exist.
