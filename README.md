# 🎙️ Soundboard — Gemini Audio Transcriber

A small web app: upload an audio file, get a clean transcript from Google Gemini.
The API key lives in a server-side function — never in the browser, never in this repo.

- **Frontend:** `index.html` (static)
- **Backend:** `functions/api/transcribe.js` (a Cloudflare Pages Function that holds the key and calls Gemini)

> **Why not GitHub Pages?** GitHub Pages serves static files only — it can't run the
> function that hides the key, and the browser can't call Gemini directly (CORS).
> A host with serverless functions (Cloudflare Pages, Netlify, Vercel) is required.

---

## SETUP: Google Sign-in Allowlist

Since this project enforces server-side access control, you MUST configure Google OAuth before the app will work.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one) and configure the **OAuth consent screen**.
3. Go to **Credentials → Create Credentials → OAuth client ID**.
4. Choose **Web application** as the Application type.
5. Under **Authorized JavaScript origins**, add your deployment URL (e.g., `https://soundboard.adityadesai66.workers.dev`).
6. Copy the generated **Client ID**.
7. Open `index.html` in this repo and replace `YOUR_GOOGLE_CLIENT_ID_HERE` with your actual Client ID.

## Deploy on Cloudflare Pages (recommended)

1. Push this folder to a new GitHub repo (see **Push to GitHub** below).
2. Go to **dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git**.
3. Select the repo. Leave the build command empty and the output directory as `/`
   (this is a static site with a `functions/` folder — no build step).
4. Under **Settings → Variables and Secrets**, add the following:
   - **Secret:** `GEMINI_API_KEY` (your key from https://aistudio.google.com/apikey)
   - **Environment Variable:** `GOOGLE_CLIENT_ID` (your Google OAuth Client ID)
   - **Environment Variable:** `ALLOWED_EMAILS` (comma-separated list of allowed emails, e.g., `user1@gmail.com,user2@gmail.com`)
5. **Save and Deploy.** You get a public URL like `https://your-app.pages.dev`.

That's it. The `functions/api/transcribe.js` file is automatically served at
`/api/transcribe`, which is what the page calls.

## Push to GitHub

```bash
cd gemini-transcriber-site
git init
git add .
git commit -m "Gemini audio transcriber"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

## Notes

- **Size limit:** the hosted site accepts audio up to **15 MB** (Gemini's inline-data
  ceiling). For longer recordings, use the Colab notebook version, which uses the
  Files API and handles audio up to ~9.5 hours.
- **Model:** defaults to `gemini-2.5-flash`. Switch to `gemini-2.5-pro` for higher
  accuracy, or type any other model name in the field.
- **Security:** never commit your key. It only ever lives in the Cloudflare secret.
- **Other hosts:** Netlify and Vercel also work — move the function to their
  conventions (`netlify/functions/` or `api/`) and set `GEMINI_API_KEY` in their
  dashboard. Cloudflare is suggested because its free tier allows the largest uploads.

## Testing Auth

To verify the allowlist works:
1. Sign in with an email that is **not** in the `ALLOWED_EMAILS` list.
2. Attempt to transcribe an audio file.
3. The UI should display an error saying "Forbidden: Email not in the allowlist." or similar, and the file will not be processed.
4. Sign in with an email that **is** in the allowlist, and the transcription will succeed.