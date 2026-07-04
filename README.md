# 🎙️ Soundboard — Gemini Audio Transcriber (private / Google sign-in)

Upload an audio file, get a clean transcript from Google Gemini. The app is private:
only allowlisted Google accounts can use it, enforced **server-side**. The Gemini key
lives only as a Cloudflare environment value — never in the browser, never in this repo.

## Architecture (Cloudflare Worker + Static Assets)

- **Frontend:** `public/index.html` — served as a static asset (this is the *only*
  thing under `public/`, so backend source is never exposed).
- **Worker entry:** `worker.js` — routes `POST /api/transcribe` to the handler;
  everything else falls through to the static assets (`ASSETS` binding).
- **Handler:** `functions/api/transcribe.js` — verifies the caller, then transcribes.

> **This is a Worker, not a Pages project.** The `functions/` directory does **not**
> auto-route the way it would in Cloudflare Pages. `worker.js` imports the handler
> explicitly, and `wrangler.jsonc` sets `"main": "worker.js"` with
> `assets.run_worker_first: ["/api/*"]`. Without that, `/api/transcribe` is served as
> a static file instead of executing — which silently disables both transcription and
> the auth gate.

## Authentication (Google Sign-In, enforced server-side)

Before any transcription work, `functions/api/transcribe.js` requires a valid
**Google ID token** sent as `Authorization: Bearer <token>`:

1. Reads the Bearer token; missing/malformed → **401**.
2. Verifies it via Google's `https://oauth2.googleapis.com/tokeninfo?id_token=…`
   endpoint (rejects forged/expired tokens) → invalid → **401**.
3. Checks the token audience (`aud`) equals `GOOGLE_CLIENT_ID` → mismatch → **401**.
4. Checks the token email against `ALLOWED_EMAILS` → not allowlisted → **403**.

Gemini is **never called** unless all four pass. The frontend lock is only a
convenience; the server is the real gate.

Environment values required on the Worker (none committed to the repo):

| Name | Type | Purpose |
|------|------|---------|
| `GEMINI_API_KEY` | Secret | Gemini API key. |
| `GOOGLE_CLIENT_ID` | Var or secret | OAuth Web client ID; tokens must match this `aud`. |
| `ALLOWED_EMAILS` | Var or secret | Comma-separated allowlist, e.g. `you@gmail.com,teammate@co.com`. |

The same client ID is also a clearly-marked constant in `public/index.html`. That
value is **public** and safe to ship in the frontend.

## SETUP — manual steps

1. **OAuth client:** Google Cloud Console → *APIs & Services → Credentials → Create
   Credentials → OAuth client ID → Web application*.
2. **Authorized JavaScript origin:** `https://soundboard.adityadesai66.workers.dev`
   (no trailing slash). Leave redirect URIs empty. Copy the **Client ID**.
3. **Frontend:** set `const GOOGLE_CLIENT_ID = "…apps.googleusercontent.com";` in
   `public/index.html` (already set to your current client ID).
4. **Cloudflare env:**
   ```bash
   npx wrangler secret put GEMINI_API_KEY      # if not already set
   npx wrangler secret put GOOGLE_CLIENT_ID    # same Web client ID
   npx wrangler secret put ALLOWED_EMAILS      # e.g. you@gmail.com,teammate@co.com
   ```
5. **Deploy:**
   ```bash
   npx wrangler deploy
   ```

## Verify the access control (server-side)

**Authorized:** sign in with an allowlisted account, upload a short clip → transcript.

**Rejected at the API (bypassing the UI):**
```bash
# valid Google token but NOT allowlisted -> 403, Gemini never called
curl -i -X POST https://soundboard.adityadesai66.workers.dev/api/transcribe \
  -H "Authorization: Bearer $TOKEN" -F "audio=@clip.mp3" -F "model=gemini-2.5-flash"

# no token -> 401
curl -i -X POST https://soundboard.adityadesai66.workers.dev/api/transcribe -F "audio=@clip.mp3"

# garbage token -> 401
curl -i -X POST https://soundboard.adityadesai66.workers.dev/api/transcribe \
  -H "Authorization: Bearer not.a.real.token" -F "audio=@clip.mp3"
```
Expect `401`/`403` with a JSON `{"error":"…"}` and never a transcript. Sanity-check
the routing with `GET /api/transcribe` → it returns `{"error":"Method not allowed; use POST."}`
(proof the Worker is executing, not serving a static file).

## Notes

- **Model:** defaults to `gemini-2.5-flash`; the handler refuses retired `*-flash-exp`.
- **Size:** inline ≤ 12 MB, Files API up to 100 MB.
- **Token lifetime:** Google ID tokens expire after ~1 hour; the frontend clears the
  session and re-prompts on a `401`.
- **Secrets:** `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS` live only as
  Cloudflare env values. The client ID in `index.html` is public by design.
