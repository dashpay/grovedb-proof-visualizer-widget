// Tiny static-file HTTP server. Used by the demo Launch preview because the
// system Python build can't run http.server in the sandbox.
//
// Usage: node scripts/serve.mjs [port]
//   default port: from $PORT, else 8765
//   served root:  packages/grovedb-proof-visualizer

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = normalize(join(HERE, "..", "packages", "grovedb-proof-visualizer"));
const PORT = Number(process.env.PORT ?? process.argv[2] ?? 8765);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/demo/index.html";
  const filePath = normalize(join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`grovedb-proof-visualizer demo: http://localhost:${PORT}/`);
});
