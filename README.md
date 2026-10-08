# Naya News Autopilot

Free, cloud-only system that turns RSS news into Startup Pakistan–style social posts:
a 3–5 sentence rewritten story with SEO hashtags, plus a 1080×1300 news card (AI picture without
people, logo top-left, headline with highlighted key words, social icons footer).
Posts go to LinkedIn now; X, Instagram and Facebook can be added later via Buffer.

## How it runs

```
Cloudflare Worker (free)                         GitHub Actions (free)
- control panel (password)                       - fetch RSS feeds, pick best fresh story
- scheduler: every 5 min, starts a run when due  - Gemini rewrites post (free tier)
- Workers AI image model (FLUX, free daily)  <-- - asks Worker for the AI picture
- stores images 14 days (KV), state (D1)     <-- - draws the news card (Pillow)
- publishes to Buffer -> LinkedIn                - hands the post to the Worker
```

Nothing runs on your computer. Everything uses free tiers that don't need a card.

## Control panel

Open the Worker URL (shown at the end of setup) and log in with your `DASHBOARD_PASSWORD`.

- **Start / Pause** turns automatic posting on or off.
- **Run now** publishes one post immediately. **Test run** makes a preview without publishing.
- **Posts** shows every post with its image. You can publish previews, edit the text, delete posts,
  or make a post from one article link.
- **News feeds** lets you add, remove or switch RSS feeds on and off.
- **Schedule** sets the interval, posts per run, daily limit, active hours and approval mode.
- **Writing** covers brand name, topics, tone, hashtags, the disclaimer and source credit.
- **Image design** covers highlight colour, image model and style, footer icons, logo PNG and frame PNG overlay.
- **Channels** lists the Buffer channels. Press Refresh after connecting a new network in Buffer.
- **Run history** shows each run with a link to the GitHub log.

## Free limits (approximate)

| Part | Free allowance |
|---|---|
| Gemini text | daily request cap per model; falls back to other Gemini models, then Cloudflare AI |
| Cloudflare Workers AI | 10,000 neurons/day ≈ 60 FLUX.2 klein or ≈ 150 FLUX.1 schnell images |
| Buffer free plan | 3 channels, 250 API calls/day |
| GitHub Actions | unlimited minutes for a public repository |
| Cloudflare Worker / D1 / KV | 100k requests/day, 1k image writes/day |

## Setup (already done once; re-run after changing keys)

1. Fill `.env` (git-ignored): `GEMINI_API_KEY`, `BUFFER_API_KEY`, `GH_TOKEN` (classic, `repo` + `workflow`),
   `DASHBOARD_PASSWORD`.
2. `cd worker && npm install && npx wrangler login`
3. `.venv/bin/python scripts/setup.py` creates D1 and KV, deploys the Worker, sets secrets,
   creates the GitHub repository, pushes the code and sets the Actions secrets.

## Adding X, Instagram, Facebook later

Connect the account in Buffer (free plan: 3 channels in total), then in the panel open
**Channels → Refresh from Buffer** and switch the new channel on. Instagram needs a Business or
Creator account.
