// Cloudflare Pages Function -> served at POST /api/transcribe
// The Gemini API key lives in env.GEMINI_API_KEY (set in the Cloudflare dashboard
// as a Secret), never in this code and never in the browser.

const j = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

// Chunked base64 encode for binary audio (avoids call-stack limits on big files)
function toBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function onRequestPost({ request, env }) {
  const key = env.GEMINI_API_KEY;
  if (!key) return j({ error: "GEMINI_API_KEY is not set on the server." }, 500);

  let form;
  try {
    form = await request.formData();
  } catch (_) {
    return j({ error: "Expected a multipart form upload." }, 400);
  }

  const file = form.get("audio");
  if (!file || typeof file.arrayBuffer !== "function") {
    return j({ error: "No audio file in the request." }, 400);
  }

  const prompt = (form.get("prompt") || "Transcribe this audio.").toString();
  const model = (form.get("model") || "gemini-2.5-flash")
    .toString()
    .replace(/[^a-zA-Z0-9.\-]/g, "");
  const mime = file.type || "audio/mp3";

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Inline data path: Gemini caps the whole request at ~20 MB, so audio must
  // stay under ~15 MB. Larger/longer audio should use the Colab notebook.
  if (bytes.length > 15 * 1024 * 1024) {
    return j(
      { error: "Audio is over the 15 MB limit for the hosted site. Use the Colab notebook for longer recordings." },
      413
    );
  }

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mime, data: toBase64(bytes) } },
        ],
      },
    ],
  };

  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(model) +
        ":generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      }
    );
    const data = await r.json();

    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || "Gemini HTTP " + r.status;
      return j({ error: msg }, 502);
    }

    const cand = data.candidates && data.candidates[0];
    const text =
      cand && cand.content && cand.content.parts
        ? cand.content.parts.map((p) => p.text || "").join("").trim()
        : "";
    if (!text) {
      const reason = cand && cand.finishReason ? " (" + cand.finishReason + ")" : "";
      return j({ error: "Model returned no text" + reason + "." }, 502);
    }

    const tokens =
      data.usageMetadata && data.usageMetadata.totalTokenCount
        ? data.usageMetadata.totalTokenCount
        : null;
    return j({ text, tokens });
  } catch (e) {
    return j({ error: String((e && e.message) || e) }, 502);
  }
}