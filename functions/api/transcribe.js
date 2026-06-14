// Cloudflare Pages Function -> served at POST /api/transcribe
// Uses Gemini Files API for files up to ~9.5 hours / 50+ MB
// Falls back to inline data for smaller files (< 15 MB)

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

// Upload file to Gemini Files API and wait for processing
async function uploadFileToGemini(bytes, mimeType, key) {
  const uploadUrl = "https://generativelanguage.googleapis.com/upload/content?key=" + key;
  
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": bytes.length,
      "X-Goog-Upload-Header-Content-Type": mimeType,
    },
  });

  if (!response.ok) {
    throw new Error("Failed to start file upload: " + response.status);
  }

  const uploadUrl2 = response.headers.get("X-Goog-Upload-URL");
  if (!uploadUrl2) {
    throw new Error("No upload URL returned");
  }

  // Upload the file content
  const uploadResponse = await fetch(uploadUrl2, {
    method: "PUT",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
      "Content-Type": mimeType,
    },
    body: bytes,
  });

  if (!uploadResponse.ok) {
    throw new Error("File upload failed: " + uploadResponse.status);
  }

  const uploadData = await uploadResponse.json();
  const fileUri = uploadData.file?.uri;

  if (!fileUri) {
    throw new Error("No file URI in upload response");
  }

  // Poll for file processing to complete
  const fileCheckUrl = "https://generativelanguage.googleapis.com/v1beta/files/" + 
    encodeURIComponent(fileUri.split("/").pop()) + "?key=" + key;
  
  let attempts = 0;
  const maxAttempts = 60; // ~3 minutes max wait
  
  while (attempts < maxAttempts) {
    const checkResponse = await fetch(fileCheckUrl);
    const checkData = await checkResponse.json();

    if (checkData.state === "ACTIVE") {
      return fileUri;
    }

    if (checkData.state === "FAILED") {
      throw new Error("File processing failed");
    }

    // Wait 3 seconds before checking again
    await new Promise(resolve => setTimeout(resolve, 3000));
    attempts++;
  }

  throw new Error("File processing timeout");
}

// Delete file from Gemini (cleanup)
async function deleteFileFromGemini(fileUri, key) {
  try {
    const fileId = fileUri.split("/").pop();
    await fetch(
      "https://generativelanguage.googleapis.com/v1beta/files/" +
        encodeURIComponent(fileId) +
        "?key=" +
        key,
      { method: "DELETE" }
    );
  } catch (_) {
    // Ignore cleanup errors
  }
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
  const model = (form.get("model") || "gemini-2.0-flash-exp")
    .toString()
    .replace(/[^a-zA-Z0-9.\-]/g, "");
  const mime = file.type || "audio/mp3";

  const bytes = new Uint8Array(await file.arrayBuffer());
  const useFilesApi = bytes.length > 15 * 1024 * 1024;
  const LIMIT = 100 * 1024 * 1024; // 100 MB limit

  if (bytes.length > LIMIT) {
    return j(
      { error: `Audio is ${(bytes.length / 1024 / 1024).toFixed(1)} MB — over the 100 MB limit.` },
      413
    );
  }

  let fileUri = null;
  let transcriptText = "";
  let tokens = null;

  try {
    if (useFilesApi) {
      // Upload file and get URI
      fileUri = await uploadFileToGemini(bytes, mime, key);

      // Transcribe using file URI
      const body = {
        contents: [
          {
            parts: [
              { text: prompt },
              {
                file_data: {
                  mime_type: mime,
                  file_uri: fileUri,
                },
              },
            ],
          },
        ],
      };

      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(model) +
          ":generateContent?key=" +
          key,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      const data = await r.json();

      if (!r.ok) {
        const msg =
          (data && data.error && data.error.message) || "Gemini HTTP " + r.status;
        return j({ error: msg }, 502);
      }

      const cand = data.candidates && data.candidates[0];
      transcriptText =
        cand && cand.content && cand.content.parts
          ? cand.content.parts.map((p) => p.text || "").join("").trim()
          : "";

      if (!transcriptText) {
        const reason = cand && cand.finishReason ? " (" + cand.finishReason + ")" : "";
        return j({ error: "Model returned no text" + reason + "." }, 502);
      }

      tokens =
        data.usageMetadata && data.usageMetadata.totalTokenCount
          ? data.usageMetadata.totalTokenCount
          : null;
    } else {
      // Inline data path for small files
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

      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(model) +
          ":generateContent?key=" +
          key,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      const data = await r.json();

      if (!r.ok) {
        const msg =
          (data && data.error && data.error.message) || "Gemini HTTP " + r.status;
        return j({ error: msg }, 502);
      }

      const cand = data.candidates && data.candidates[0];
      transcriptText =
        cand && cand.content && cand.content.parts
          ? cand.content.parts.map((p) => p.text || "").join("").trim()
          : "";

      if (!transcriptText) {
        const reason = cand && cand.finishReason ? " (" + cand.finishReason + ")" : "";
        return j({ error: "Model returned no text" + reason + "." }, 502);
      }

      tokens =
        data.usageMetadata && data.usageMetadata.totalTokenCount
          ? data.usageMetadata.totalTokenCount
          : null;
    }

    return j({ text: transcriptText, tokens });
  } catch (e) {
    return j({ error: String((e && e.message) || e) }, 502);
  } finally {
    // Clean up uploaded file
    if (fileUri) {
      await deleteFileFromGemini(fileUri, key);
    }
  }
}