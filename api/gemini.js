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

function isLikelyOpenRouterKey(apiKey) {
  return typeof apiKey === "string" && apiKey.trim().startsWith("sk-or-v1-");
}

function getConfiguredApiKeys() {
  return [
    { name: "GEMINI_API_KEY", value: process.env.GEMINI_API_KEY },
    {
      name: "GEMINI_API_KEY_FALLBACK",
      value: process.env.GEMINI_API_KEY_FALLBACK,
    },
  ]
    .map(({ name, value }) => ({
      name,
      value: typeof value === "string" ? value.trim() : "",
    }))
    .filter(({ value }) => value);
}

function shouldRetryWithBackup(statusCode, message) {
  const normalizedMessage = String(message || "").toLowerCase();

  if (
    [0, 401, 402, 403, 404, 408, 409, 429, 500, 502, 503, 504].includes(
      statusCode,
    )
  ) {
    return true;
  }

  return [
    "timeout",
    "timed out",
    "temporarily",
    "unavailable",
    "overloaded",
    "rate limit",
    "quota",
    "authentication",
    "unauthorized",
    "credit",
    "no endpoints found",
    "provider returned error",
  ].some((fragment) => normalizedMessage.includes(fragment));
}

function getApiKeyConfigurationError(keys) {
  if (!keys.length) {
    return "OpenRouter API key not configured on the server";
  }

  return "GEMINI_API_KEY and GEMINI_API_KEY_FALLBACK must contain OpenRouter API keys (sk-or-v1-...)";
}

async function requestOpenRouter(apiKey, modelName, messages) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages,
        }),
        signal: controller.signal,
      },
    );

    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: error?.name === "AbortError" ? 408 : 0,
      error,
      data: null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function getOpenRouterErrorMessage(result) {
  if (result?.error?.name === "AbortError") {
    return "OpenRouter request timed out";
  }

  return (
    result?.data?.error?.message ||
    result?.data?.message ||
    result?.error?.message ||
    "OpenRouter request failed"
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const configuredApiKeys = getConfiguredApiKeys();
  const validApiKeys = configuredApiKeys.filter(({ value }) =>
    isLikelyOpenRouterKey(value),
  );

  if (!validApiKeys.length) {
    return res.status(500).json({
      error: {
        message: getApiKeyConfigurationError(configuredApiKeys),
      },
    });
  }

  try {
    const { payload, model } = req.body || {};
    if (!payload) return res.status(400).json({ error: "Missing payload" });

    const modelName = model || "nvidia/nemotron-3-super-120b-a12b:free";
    const messages = geminiPayloadToOpenRouterMessages(payload);
    let lastResult = null;

    for (let index = 0; index < validApiKeys.length; index += 1) {
      const { value: apiKey } = validApiKeys[index];
      const result = await requestOpenRouter(apiKey, modelName, messages);

      if (result.ok) {
        return res.status(200).json(openRouterToGeminiResponse(result.data));
      }

      lastResult = result;
      const hasNextKey = index < validApiKeys.length - 1;
      const errorMessage = getOpenRouterErrorMessage(result);

      if (hasNextKey && shouldRetryWithBackup(result.status, errorMessage)) {
        continue;
      }

      return res.status(result.status || 500).json({
        error: {
          message: errorMessage,
        },
      });
    }

    return res.status(lastResult?.status || 500).json({
      error: {
        message: getOpenRouterErrorMessage(lastResult),
      },
    });
  } catch (e) {
    console.error("proxy error", e);
    return res.status(500).json({ error: String(e) });
  }
}
