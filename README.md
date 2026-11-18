# EUR → INR Tracker

Installable PWA. Live EUR→INR rate from ECB reference rates (Frankfurter API), a plain-language read on when to convert, a 4-week forecast (likely range, odds of going higher, and roughly when), and alerts for new 90-day highs or your target rate. No build step.

## Deploy on GitHub Pages

1. Create a **public** repo (e.g. `eur-inr-tracker`) and put everything in this folder at the repo root.
2. Repo → Settings → Pages → *Deploy from a branch* → `main` / `(root)`.
3. Open `https://<your-username>.github.io/<repo>/`, then install it (Chrome/Edge: install icon in the address bar; iPhone: Share → Add to Home Screen).

All paths are relative, so it works under the `/<repo>/` subpath.

## Optional: Supabase settings sync

Syncs target rate, theme and amount between devices. Rate history is public data and is not stored.

1. Supabase → SQL Editor → run `supabase.sql`.
2. Auth → Users → *Add user* (email + password). Optionally turn off public sign-ups under Auth → Providers → Email.
3. Put your project URL and anon/publishable key in `config.js`.
4. Open the app → footer → *Sign in*.

## Files

- `index.html` — the app
- `fx-core.js` — rate fetching, storage and alert rules (shared with the service worker)
- `sw.js` — offline shell, background checks, notification clicks
- `config.js` — optional Supabase settings
- `manifest.webmanifest`, `icons/` — install metadata
