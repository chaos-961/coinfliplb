# Coinflip LB frontend (v1.4)

Static site. Drop these files on any static host (GitHub Pages,
Netlify, Cloudflare Pages, Vercel, plain Nginx).

## Files

- `index.html` — markup
- `styles.css` — single-source-of-truth stylesheet (rewritten for v1.4)
- `app.js` — SPA logic
- `config.js` — runtime config; **edit `API_BASE_URL` to point at your backend**
- `CNAME` — only used by GitHub Pages for a custom domain

## Deploy

1. Edit `config.js` and set `API_BASE_URL` to your deployed backend URL
   (e.g. `https://coinfliplb-production.up.railway.app`).
2. Push these files as the root of your `gh-pages` (or production)
   branch, or drop them into your hosting provider's static deploy.
3. Make sure the backend's `FRONTEND_ORIGIN` env var includes your
   frontend's origin (e.g. `https://coinfliplb.com`).

That's it — no build step, no bundler.
