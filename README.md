# Cristina × Wonder — Voice of the Guest

A live, working web app built for Cristina Mello's Wonder manager interview. It reads every
public Google review of the Wonder fleet (14 shops across NYC and northern NJ) and clusters it
into the short list of recurring, fleet-wide themes a multi-shop operator can actually act on.

```
/   Voice of the Guest — review volume + rating trend, top 5 recurring complaints,
    top 5 consistent wins, each with month-by-month evolution
```

## Local development

```bash
cd web
cp .env.example .env       # add ANTHROPIC_API_KEY only if you want to regenerate the analysis
npm install
npm run dev                # http://localhost:3000
```

The app is self-contained: the bundled `seed/outscraper-wonder.xlsx` is loaded into a local
SQLite DB on first boot, and the pre-computed `seed/strategic-all.json` drives the top issues /
wins. No API keys are needed at runtime.

## Environment variables

| Variable | Required for | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Re-running `npm run analyze` only | Standard `sk-ant-...` key. Not needed to serve the site. |
| `DB_PATH` | SQLite location | Defaults to `./data/wonder.db`. On Railway, set to `/data/wonder.db` and mount a volume there. |

## Regenerating the analysis

`seed/strategic-all.json` is already committed. To rebuild it from the seed reviews
(per-review Claude categorization → strategic top-5 clustering → monthly evolution):

```bash
npm run analyze            # needs ANTHROPIC_API_KEY in .env
```

## Deploying to Railway

The repo includes `railway.json` and `nixpacks.toml`, so Railway builds out of the box.

1. Create a new Railway project → **Deploy from GitHub repo**, point it at this repo.
   The repo root *is* the Next.js app, so no Root Directory setting is needed.
2. (Optional but recommended) Mount a volume at `/data` and set `DB_PATH=/data/wonder.db` so the
   SQLite cache persists across deploys. Without it the DB just rebuilds from the bundled
   xlsx on every boot — also fine, just slightly slower on cold start.
3. No env vars are required to serve the site. Deploy — your URL will be
   `<service>.up.railway.app`.

## How the data flows

```
seed/outscraper-wonder.xlsx ──(on boot)──→ reviews_cache (SQLite)  ──→ volume + rating trend, counts
seed/strategic-all.json ──(read directly)─────────────────────────→ top 5 issues / top 5 wins
```

`strategic-all.json` is produced offline by `scripts/analyze-and-export.ts`: each review since
Jan 2024 is categorized by Claude Haiku, themes are clustered into the top 5 issues and top 5
wins, and each bucket's month-by-month prevalence is computed.

## Architecture choices

- **Next.js 16 App Router**, server components for data.
- **SQLite (better-sqlite3)**, zero ops; rebuilds from the bundled xlsx if no volume.
- **Tailwind v4**, Wonder navy + warm coral accent, modern sans for headings.
- **Claude Haiku** for per-review categorization — fast and cheap at fleet scale.
