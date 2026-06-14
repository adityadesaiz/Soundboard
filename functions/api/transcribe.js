// Cloudflare Pages Function -> served at POST /api/transcribe
// Small files (<= 12 MB) go inline; larger files use the Gemini Files API
// (raw upload, no base64 — keeps the Worker under its CPU limit).
// The key lives only in env.GEMINI_API_KEY (Cloudflare secret), never in the repo.

const API = "https://generativelanguage.googleapis.com";
const INLINE_MAX = 12 * 1024 * 1024;   // use inline data at/below this size
const HARD_MAX = 100 * 1024 * 1024;    // reject anything larger (Cloudflare body limit)

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export async function onRequestPost({ request, env }) {
  const key = env.GEMINI_API_KEY;
  if (!key) return json({ error: "GEMINI_API_KEY is not set on the server." }, 500);

  let form;
  try {
    form = await request.formData();
  } catch (_) {
    return json({ error: "Expected a multipart form upload." }, 400);
  }

  const file = form.get("audio");
  if (!file || typeof file.arrayBuffer !== "function") {
    return json({ error: "No audio file in the request." }, 400);
  }

  const prompt = (form.get("prompt") || "Transcribe this audio.").toString();
  let model = (form.get("model") || "gemini-2.5-flash").toString().replace(/[^a-zA-Z0-9.\-]/g, "");
  // Guard: never use the retired experimental model, even if a client sends it.
  if (!model || /flash-exp/.test(model)) model = "gemini-2.5-flash";

  const mime = file.type || "audio/mp3";
  const buf = await file.arrayBuffer();
  const size = buf.byteLength;

  if (size > HARD_MAX) {
    return json({ error: `Audio is ${(size / 1048576).toFixed(1)} MB — over the ${HARD_MAX / 1048576} MB limit.` }, 413);
  }

  const auth = { "x-goog-api-key": key };
  let uploadedName = null;

  try {
    let parts;

    if (size <= INLINE_MAX) {
      parts = [
        { text: prompt },
        { inline_data: { mime_type: mime, data: toBase64(new Uint8Array(buf)) } },
      ];
    } else {
      // 1) Start a resumable upload session.
      const start = await fetch(`${API}/upload/v1beta/files`, {
        method: "POST",
        headers: {
          ...auth,
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(size),
          "X-Goog-Upload-Header-Content-Type": mime,
          "content-type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: "audio" } }),
      });
      if (!start.ok) {
        return json({ error: "Files API start failed: " + (await start.text()).slice(0, 200) }, 502);
      }
      const uploadUrl = start.headers.get("x-goog-upload-url");
      if (!uploadUrl) return json({ error: "Files API did not return an upload URL." }, 502);

      // 2) Upload the bytes and finalize.
      const up = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Length": String(size),
          "X-Goog-Upload-Offset": "0",
          "X-Goog-Upload-Command": "upload, finalize",
        },
        body: buf,
      });
      if (!up.ok) {
        return json({ error: "Files API upload failed: " + (await up.text()).slice(0, 200) }, 502);
      }
      let f = (await up.json()).file;
      uploadedName = f && f.name;

      // 3) Poll until the file is ACTIVE (cap ~25s to stay within Worker limits).
      let waited = 0;
      while (f && f.state === "PROCESSING" && waited < 25000) {
        await sleep(2000);
        waited += 2000;
        const g = await fetch(`${API}/v1beta/${f.name}`, { headers: auth });
        f = await g.json();
      }
      if (!f || f.state !== "ACTIVE") {
        return json({ error: "File did not finish processing in time (state: " + (f && f.state) + "). Try a smaller file." }, 504);
      }

      parts = [
        { text: prompt },
        { file_data: { mime_type: f.mimeType || mime, file_uri: f.uri } },
      ];
    }

    // 4) Transcribe.
    const r = await fetch(`${API}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
    const data = await r.json();

    if (!r.ok) {
      return json({ error: (data && data.error && data.error.message) || "Gemini HTTP " + r.status }, 502);
    }
    const cand = data.candidates && data.candidates[0];
    const text =
      cand && cand.content && cand.content.parts
        ? cand.content.parts.map((p) => p.text || "").join("").trim()
        : "";
    if (!text) {
      const reason = cand && cand.finishReason ? " (" + cand.finishReason + ")" : "";
      return json({ error: "Model returned no text" + reason + "." }, 502);
    }
    const tokens =
      data.usageMetadata && data.usageMetadata.totalTokenCount ? data.usageMetadata.totalTokenCount : null;
    return json({ text, tokens });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  } finally {
    // 5) Clean up the uploaded file regardless of outcome.
    if (uploadedName) {
      try {
        await fetch(`${API}/v1beta/${uploadedName}`, { method: "DELETE", headers: auth });
      } catch (_) {}
    }
  }
}
