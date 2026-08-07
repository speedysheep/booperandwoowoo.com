# booperandwoowoo.com !

Static site for [booperandwoowoo.com](https://booperandwoowoo.com), deployed to Cloudflare
Workers (static assets).

## Local development

```powershell
npm install
npm run dev
```

## Deploy

Preferred: connect this repo in the Cloudflare dashboard (**Workers & Pages** →
`booperandwoowoo-com` → **Settings** → **Builds** → **Connect**) so every push to `main` builds
and deploys automatically. Deploy command: `npx wrangler deploy`.

Manual deploy, if you ever need it:

```powershell
npx wrangler login
npm run deploy
```

## Custom domain

Attached via `routes` in `wrangler.jsonc` (`custom_domain: true`). Requires
`booperandwoowoo.com` to already be an active zone on this Cloudflare account, and no
conflicting DNS record on the root hostname.

## Adding photos and videos

- Drop new photos into `public/pictures/`.
- Drop new videos into `public/videos/` (this folder is git-ignored — the files themselves
  never get committed; they're uploaded to R2 instead).
- Run:

  ```powershell
  npm run gallery
  ```

  This regenerates `public/gallery.json` and everything it needs:
  - **Photos**: a thumbnail in `public/thumbs/` (via `scripts/generate-thumbnails.mjs`,
    using `sharp`).
  - **Videos** (via `scripts/process-videos.mjs`, using `ffmpeg-static`/`ffprobe-static`):
    a poster-frame thumbnail in `public/thumbs/`; a small muted ~3s hover-preview clip; and
    the full video, re-encoded to H.264 capped at 1280px if it's HEVC, high-bitrate, or
    larger than that (this matters beyond file size — HEVC doesn't play in Chrome/Firefox
    at all). The preview clip and full video are uploaded to the `booperandwoowoo-media`
    R2 bucket and served from `https://media.booperandwoowoo.com`; only the poster JPG is
    committed to git.
  - Safe to re-run: unchanged videos are skipped (tracked in the git-ignored
    `.media-cache.json`). Any video that fails to read or encode gets moved to
    `../invalid_videos/` (a sibling of this repo, never touched by git) instead of failing
    the whole batch.
  - Requires `npx wrangler login` once, with access to the `booperandwoowoo-media` R2
    bucket.
- Commit `public/pictures/`, `public/thumbs/`, and `public/gallery.json`. Do **not** commit
  `public/videos/` — it's ignored on purpose.
