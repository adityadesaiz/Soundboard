const API = "https://generativelanguage.googleapis.com";
const INLINE_MAX = 12 * 1024 * 1024;
const HARD_MAX = 100 * 1024 * 1024;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toBase64(bytes) {
  let bin = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
async function onRequestPost({ request, env }) {
  const key = env.GEMINI_API_KEY;
  if (!key) return json({ error: "GEMINI_API_KEY is not set on the server." }, 500);
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return json({ error: "Unauthorized: Missing or invalid Authorization header." }, 401);
  }
  const token = authHeader.split(" ")[1];
  let tokenInfo;
  try {
    const tokenRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
    tokenInfo = await tokenRes.json();
    if (!tokenRes.ok) {
      return json({ error: "Unauthorized: Invalid or expired Google ID token." }, 401);
    }
  } catch (e) {
    return json({ error: "Unauthorized: Failed to verify token." }, 401);
  }
  const clientId = env.GOOGLE_CLIENT_ID;
  if (tokenInfo.aud !== clientId) {
    return json({ error: "Unauthorized: Token audience mismatch." }, 401);
  }
  const allowedEmailsStr = env.ALLOWED_EMAILS || "";
  const allowedEmails = allowedEmailsStr.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const userEmail = (tokenInfo.email || "").toLowerCase();
  if (!allowedEmails.includes(userEmail)) {
    return json({ error: "Forbidden: Email not in the allowlist." }, 403);
  }
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
  if (!model || /flash-exp/.test(model)) model = "gemini-2.5-flash";
  const mime = file.type || "audio/mp3";
  const buf = await file.arrayBuffer();
  const size = buf.byteLength;
  if (size > HARD_MAX) {
    return json({ error: `Audio is ${(size / 1048576).toFixed(1)} MB \u2014 over the ${HARD_MAX / 1048576} MB limit.` }, 413);
  }
  const auth = { "x-goog-api-key": key };
  let uploadedName = null;
  try {
    let parts;
    if (size <= INLINE_MAX) {
      parts = [
        { text: prompt },
        { inline_data: { mime_type: mime, data: toBase64(new Uint8Array(buf)) } }
      ];
    } else {
      const start = await fetch(`${API}/upload/v1beta/files`, {
        method: "POST",
        headers: {
          ...auth,
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(size),
          "X-Goog-Upload-Header-Content-Type": mime,
          "content-type": "application/json"
        },
        body: JSON.stringify({ file: { display_name: "audio" } })
      });
      if (!start.ok) {
        return json({ error: "Files API start failed: " + (await start.text()).slice(0, 200) }, 502);
      }
      const uploadUrl = start.headers.get("x-goog-upload-url");
      if (!uploadUrl) return json({ error: "Files API did not return an upload URL." }, 502);
      const up = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Length": String(size),
          "X-Goog-Upload-Offset": "0",
          "X-Goog-Upload-Command": "upload, finalize"
        },
        body: buf
      });
      if (!up.ok) {
        return json({ error: "Files API upload failed: " + (await up.text()).slice(0, 200) }, 502);
      }
      let f = (await up.json()).file;
      uploadedName = f && f.name;
      let waited = 0;
      while (f && f.state === "PROCESSING" && waited < 25e3) {
        await sleep(2e3);
        waited += 2e3;
        const g = await fetch(`${API}/v1beta/${f.name}`, { headers: auth });
        f = await g.json();
      }
      if (!f || f.state !== "ACTIVE") {
        return json({ error: "File did not finish processing in time (state: " + (f && f.state) + "). Try a smaller file." }, 504);
      }
      parts = [
        { text: prompt },
        { file_data: { mime_type: f.mimeType || mime, file_uri: f.uri } }
      ];
    }
    const r = await fetch(`${API}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] })
    });
    const data = await r.json();
    if (!r.ok) {
      return json({ error: data && data.error && data.error.message || "Gemini HTTP " + r.status }, 502);
    }
    const cand = data.candidates && data.candidates[0];
    const text = cand && cand.content && cand.content.parts ? cand.content.parts.map((p) => p.text || "").join("").trim() : "";
    if (!text) {
      const reason = cand && cand.finishReason ? " (" + cand.finishReason + ")" : "";
      return json({ error: "Model returned no text" + reason + "." }, 502);
    }
    const tokens = data.usageMetadata && data.usageMetadata.totalTokenCount ? data.usageMetadata.totalTokenCount : null;
    return json({ text, tokens });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502);
  } finally {
    if (uploadedName) {
      try {
        await fetch(`${API}/v1beta/${uploadedName}`, { method: "DELETE", headers: auth });
      } catch (_) {
      }
    }
  }
}
export {
  onRequestPost
};
