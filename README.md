# booperandwoowoo.com

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
