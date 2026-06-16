// Worker entry point.
// /api/transcribe (POST) -> Gemini proxy handler (functions/api/transcribe.js).
// Everything else -> static assets (index.html, etc.) via the ASSETS binding.
import { onRequestPost } from "./functions/api/transcribe.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/transcribe") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed; use POST." }), {
          status: 405,
          headers: { "content-type": "application/json", "allow": "POST" },
        });
      }
      return onRequestPost({ request, env });
    }
    return env.ASSETS.fetch(request);
  },
};
