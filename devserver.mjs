// devserver.mjs. alleen voor lokaal testen op je eigen computer.
// Start met: node devserver.mjs
// Open dan: http://localhost:3002

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const marifoonHandler = (await import("./api/marifoon.js")).default;
const getijHandler = (await import("./api/getij.js")).default;

function parseQuery(url) {
  const q = {};
  const i = url.indexOf("?");
  if (i === -1) return q;
  for (const part of url.slice(i + 1).split("&")) {
    const [k, v] = part.split("=");
    if (k) q[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return q;
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/marifoon") || req.url.startsWith("/api/getij")) {
    const handler = req.url.startsWith("/api/marifoon") ? marifoonHandler : getijHandler;
    const fakeReq = { query: parseQuery(req.url) };
    const fakeRes = {
      _status: 200,
      setHeader: () => {},
      status(code) {
        this._status = code;
        return this;
      },
      json(body) {
        res.writeHead(this._status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body, null, 2));
      },
    };
    await handler(fakeReq, fakeRes);
    return;
  }

  const filePath = req.url === "/" ? "/index.html" : req.url;
  const fullPath = path.join(__dirname, filePath);
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(fullPath);
    const type = ext === ".html" ? "text/html" : ext === ".js" ? "application/javascript" : "text/plain";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
});

const PORT = 3002;
server.listen(PORT, () => {
  console.log(`Marifoon dev-server draait op http://localhost:${PORT}`);
});
