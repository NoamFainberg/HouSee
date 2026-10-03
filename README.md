# HouSee POC

Upload a few apartment photos and get a cinematic 16:9 house-tour video.

Photos and videos stay on disk under `data/tours/`. The only cloud API you need is **Higgsfield**.

## What you need

1. **Higgsfield Cloud** keys from [cloud.higgsfield.ai](https://cloud.higgsfield.ai) — API usage burns credits
2. **ffmpeg** — `brew install ffmpeg`
3. Optional: `OPENAI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` for smarter room tagging (otherwise filenames + manual tags)

```bash
cp .env.example .env.local
# fill HF_API_KEY_ID and HF_API_KEY_SECRET
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), drop 3–8 listing photos, generate, wait, download.

## How it works

1. Photos are saved locally
2. Rooms are tagged (vision API or filenames)
3. Higgsfield animates each still (3–15s clip)
4. ffmpeg stitches a master MP4 with a title card and room labels

This is a stills walkthrough, not a filmed gimbal tour. Wide, well-lit photos work best.
