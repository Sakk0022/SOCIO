// Serverless proxy for OpenRouter requests.
// Keeps GEMINI_API_KEY as the environment variable name for compatibility.

function geminiPayloadToOpenRouterMessages(payload = {}) {
  const messages = [];
  const systemText = Array.isArray(payload.systemInstruction?.parts)
    ? payload.systemInstruction.parts
        .map((part) => part?.text || "")
        .filter(Boolean)
        .join("\n\n")
    : "";

  if (systemText) {
    messages.push({ role: "system", content: systemText });
  }

  for (const item of payload.contents || []) {
    const content = Array.isArray(item?.parts)
      ? item.parts
          .map((part) => part?.text || "")
          .filter(Boolean)
          .join("\n\n")
      : "";

    if (!content) continue;

    messages.push({
      role: item?.role === "model" ? "assistant" : item?.role || "user",
      content,
    });
  }

  return messages;
}

function openRouterToGeminiResponse(data) {
  const text = data?.choices?.[0]?.message?.content;
  const normalizedText = Array.isArray(text)
    ? text
        .map((item) => (typeof item === "string" ? item : item?.text || ""))
        .filter(Boolean)
        .join("\n")
    : text;

  return {
    candidates: [
      {
        content: {
          parts: [{ text: normalizedText || "" }],
        },
      },
    ],
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    return res
      .status(500)
      .json({ error: "Gemini API key not configured on the server" });

  try {
    const { payload, model } = req.body || {};
    if (!payload) return res.status(400).json({ error: "Missing payload" });

    const modelName = model || "nvidia/nemotron-3-super-120b-a12b:free";
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: geminiPayloadToOpenRouterMessages(payload),
      }),
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) {
      return res.status(r.status).json({
        error: {
          message:
            data?.error?.message ||
            data?.message ||
            "OpenRouter request failed",
        },
      });
    }

    return res.status(200).json(openRouterToGeminiResponse(data));
  } catch (e) {
    console.error("proxy error", e);
    return res.status(500).json({ error: String(e) });
  }
}
