const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = __dirname;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
};

function loadEnvFile() {
  const envPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(envPath)) return;

  const envText = fs.readFileSync(envPath, "utf8");
  envText.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const normalized = trimmed.startsWith("export ")
      ? trimmed.slice(7).trim()
      : trimmed;

    const eqIndex = normalized.indexOf("=");
    if (eqIndex === -1) return;

    const key = normalized.slice(0, eqIndex).trim();
    const value = normalized
      .slice(eqIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

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

async function handleGeminiProxy(req, res) {
  if (req.method !== "POST") {
    return send(res, 405, JSON.stringify({ error: "Method not allowed" }), {
      "Content-Type": "application/json; charset=utf-8",
      Allow: "POST",
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return send(
      res,
      500,
      JSON.stringify({ error: "Gemini API key not configured on the server" }),
      { "Content-Type": "application/json; charset=utf-8" },
    );
  }

  try {
    const { payload, model } = await readJsonBody(req);
    if (!payload) {
      return send(res, 400, JSON.stringify({ error: "Missing payload" }), {
        "Content-Type": "application/json; charset=utf-8",
      });
    }

    const modelName = model || "nvidia/nemotron-3-super-120b-a12b:free";
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
          messages: geminiPayloadToOpenRouterMessages(payload),
        }),
      },
    );

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return send(
        res,
        response.status,
        JSON.stringify({
          error: {
            message:
              data?.error?.message ||
              data?.message ||
              "OpenRouter request failed",
          },
        }),
        { "Content-Type": "application/json; charset=utf-8" },
      );
    }

    return send(res, 200, JSON.stringify(openRouterToGeminiResponse(data)), {
      "Content-Type": "application/json; charset=utf-8",
    });
  } catch (error) {
    send(res, 500, JSON.stringify({ error: String(error) }), {
      "Content-Type": "application/json; charset=utf-8",
    });
  }
}

loadEnvFile();

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function getSafePath(requestUrl) {
  const parsedUrl = new URL(requestUrl, `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const normalizedPath = path
    .normalize(requestedPath)
    .replace(/^([.][.][/\\])+/, "");
  const filePath = path.join(ROOT_DIR, normalizedPath);

  if (!filePath.startsWith(ROOT_DIR)) {
    return null;
  }

  return filePath;
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (parsedUrl.pathname === "/api/gemini") {
    handleGeminiProxy(req, res);
    return;
  }

  const filePath = getSafePath(req.url || "/");

  if (!filePath) {
    send(res, 403, "Forbidden", {
      "Content-Type": "text/plain; charset=utf-8",
    });
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      send(res, 404, "Not found", {
        "Content-Type": "text/plain; charset=utf-8",
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
    };

    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      send(res, 500, "Server error", {
        "Content-Type": "text/plain; charset=utf-8",
      });
    });
    res.writeHead(200, headers);
    stream.pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server started: http://${HOST}:${PORT}`);
});
