// Serverless proxy for Gemini requests (Vercel / Netlify-style function)
// Reads GEMINI_API_KEY from process.env and forwards requests to Google API.

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

    const modelName = model || "gemini-3.1-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    // forward status and body
    res
      .status(r.status)
      .setHeader(
        "content-type",
        r.headers.get("content-type") || "application/json",
      );
    return res.send(text);
  } catch (e) {
    console.error("proxy error", e);
    return res.status(500).json({ error: String(e) });
  }
}
