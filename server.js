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
  ".env": "text/plain; charset=utf-8",
};

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

    if (path.basename(filePath) === ".env") {
      headers["Cache-Control"] = "no-store";
    }

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
