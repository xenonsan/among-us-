// Cloudflare Workers (ES Module) - server.js
// Serves AmongUsPort from GitHub and routes browser HTTP(S)/WebSocket traffic
// through this Worker as far as browser APIs allow.

const REPO_OWNER = "wasmdotrip";
const REPO_NAME = "AmongUsPort";
const REPO_BRANCH = "main";
const RAW_ORIGIN = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}`;
const PROXY_PATH = "/__proxy";
const SW_PATH = "/__proxy_sw.js";

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (url.pathname === SW_PATH) {
        return serviceWorkerResponse();
      }

      if (url.pathname === PROXY_PATH) {
        return proxyExternalRequest(request, env);
      }

      return serveRepositoryFile(request, env, ctx);
    } catch (error) {
      return new Response(`Worker error: ${error?.message || String(error)}`, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },
};

async function serveRepositoryFile(request, env, ctx) {
  const incoming = new URL(request.url);
  let path = decodeURIComponent(incoming.pathname);

  if (path === "/" || path === "") path = "/index.html";
  if (path.endsWith("/")) path += "index.html";

  if (path.includes("..") || path.includes("\\") || path.includes("\0")) {
    return new Response("Bad path", { status: 400 });
  }

  const upstreamUrl = new URL(RAW_ORIGIN + path);
  upstreamUrl.search = incoming.search;

  const headers = copyRequestHeaders(request.headers);
  headers.set("user-agent", "AmongUsPort-Cloudflare-Worker/1.0");
  headers.set("accept-encoding", "identity");

  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers,
    body: hasBody(request.method) ? request.body : undefined,
    redirect: "follow",
  });

  const cache = caches.default;
  const cacheKey = new Request(upstreamUrl.toString(), { method: "GET" });
  let response;

  if (request.method === "GET") response = await cache.match(cacheKey);
  if (!response) {
    response = await fetch(upstreamRequest, {
      cf: request.method === "GET" ? { cacheEverything: true, cacheTtl: 3600 } : undefined,
    });
    if (request.method === "GET" && response.ok) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
  }

  if (!response.ok) {
    return new Response(`GitHub file not found: ${path}`, {
      status: response.status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // raw.githubusercontent.com may return text/plain for CSS/JS files.
  // Always determine the MIME type from the requested repository path.
  const contentType = contentTypeFor(path);
  if (path.toLowerCase().endsWith(".html")) {
    let html = await response.text();
    html = injectProxyBootstrap(html);
    const outHeaders = safeResponseHeaders(response.headers);
    outHeaders.set("content-type", "text/html; charset=utf-8");
    outHeaders.set("cache-control", "no-cache");
    setSecurityHeaders(outHeaders);
    return new Response(html, { status: response.status, headers: outHeaders });
  }

  const outHeaders = safeResponseHeaders(response.headers);
  outHeaders.set("content-type", contentType);
  setSecurityHeaders(outHeaders);
  return new Response(response.body, { status: response.status, headers: outHeaders });
}

async function proxyExternalRequest(request, env) {
  const incoming = new URL(request.url);
  const encodedTarget = incoming.searchParams.get("url");
  if (!encodedTarget) return new Response("Missing ?url=", { status: 400 });

  let target;
  try {
    target = new URL(encodedTarget);
  } catch {
    return new Response("Invalid target URL", { status: 400 });
  }

  const isWebSocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const allowedProtocols = isWebSocket ? ["ws:", "wss:"] : ["http:", "https:"];
  if (!allowedProtocols.includes(target.protocol)) {
    return new Response("Protocol not allowed", { status: 400 });
  }

  if (isBlockedHost(target.hostname)) {
    return new Response("Private or local destinations are blocked", { status: 403 });
  }

  if (!isAllowedHost(target.hostname, env.ALLOWED_PROXY_HOSTS || "*")) {
    return new Response("Target host is not allowed", { status: 403 });
  }

  const headers = copyRequestHeaders(request.headers);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  headers.delete("x-forwarded-proto");
  headers.set("host", target.host);

  // Replace Worker-origin values where practical so upstream sees its own URL.
  const workerOrigin = incoming.origin;
  const origin = headers.get("origin");
  if (origin === workerOrigin) headers.set("origin", target.origin);
  const referer = headers.get("referer");
  if (referer?.startsWith(workerOrigin)) headers.set("referer", target.origin + "/");

  const init = {
    method: request.method,
    headers,
    body: hasBody(request.method) ? request.body : undefined,
    redirect: "manual",
  };

  // Cloudflare can pass an Upgrade request through fetch and return the
  // upstream WebSocket response directly.
  const upstream = await fetch(new Request(target.toString(), init));
  if (isWebSocket || upstream.status === 101) return upstream;

  const outHeaders = safeResponseHeaders(upstream.headers);
  outHeaders.set("access-control-allow-origin", "*");
  outHeaders.set("access-control-expose-headers", "*");
  outHeaders.set("x-content-type-options", "nosniff");
  outHeaders.delete("content-security-policy");
  outHeaders.delete("content-security-policy-report-only");
  outHeaders.delete("x-frame-options");

  const location = upstream.headers.get("location");
  if (location) {
    const absolute = new URL(location, target).toString();
    outHeaders.set("location", `${incoming.origin}${PROXY_PATH}?url=${encodeURIComponent(absolute)}`);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

function rewriteGameAssetUrls(html) {
  const raw = RAW_ORIGIN;

  // Static tags present in the Unity index. Keeping these absolute means the
  // browser downloads large game files directly from GitHub Raw.
  html = html.replace(
    /\b(href|src)=(['"])(?!(?:[a-z]+:|\/\/|#|data:|blob:))([^'"]+)\2/gi,
    (match, attr, quote, value) => {
      const clean = value.replace(/^\.\//, "");
      if (!/^(?:Build|TemplateData|StreamingAssets)\//i.test(clean)) return match;
      return `${attr}=${quote}${raw}/${clean}${quote}`;
    }
  );

  // Unity creates the loader tag and build URLs dynamically, so rewrite its
  // base directories before the page executes.
  html = html.replace(
    /(\b(?:var|let|const)\s+buildUrl\s*=\s*)(['"])Build\2/g,
    `$1${JSON.stringify(raw + "/Build")}`
  );
  html = html.replace(
    /(\bstreamingAssetsUrl\s*:\s*)(['"])StreamingAssets\2/g,
    `$1${JSON.stringify(raw + "/StreamingAssets")}`
  );

  return html;
}

function injectProxyBootstrap(html) {
  const script = `<script>
(() => {
  "use strict";
  const ENDPOINT = ${JSON.stringify(PROXY_PATH)};
  const WORKER_ORIGIN = location.origin;
  const RAW_GAME_ORIGIN = ${JSON.stringify(RAW_ORIGIN)};

  function isDirectGameAsset(u) {
    return u.href === RAW_GAME_ORIGIN || u.href.startsWith(RAW_GAME_ORIGIN + "/");
  }

  function proxied(value, base = location.href) {
    try {
      const u = new URL(value, base);
      // Only the large split DATA/WASM chunks bypass the Worker. CSS, loader JS,
      // framework JS, images and StreamingAssets stay on the Worker so they get
      // correct MIME types and same-origin behavior.
      if (u.origin === WORKER_ORIGIN && /\.(?:data|wasm)\.part\d+(?:$|[?#])/i.test(u.href)) {
        return RAW_GAME_ORIGIN + u.pathname + u.search + u.hash;
      }
      if (isDirectGameAsset(u) || u.origin === WORKER_ORIGIN || u.protocol === "data:" || u.protocol === "blob:" ||
          u.protocol === "javascript:" || u.protocol === "about:") return u.href;
      if (u.protocol === "http:" || u.protocol === "https:") {
        return ENDPOINT + "?url=" + encodeURIComponent(u.href);
      }
      if (u.protocol === "ws:" || u.protocol === "wss:") {
        const p = location.protocol === "https:" ? "wss:" : "ws:";
        return p + "//" + location.host + ENDPOINT + "?url=" + encodeURIComponent(u.href);
      }
      return u.href;
    } catch { return value; }
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    if (input instanceof Request) {
      const next = proxied(input.url);
      input = next === input.url ? input : new Request(next, input);
    } else {
      input = proxied(input);
    }
    return nativeFetch(input, init);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return nativeOpen.call(this, method, proxied(url), ...rest);
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class ProxyWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(proxied(url), protocols);
    }
  };
  Object.defineProperties(window.WebSocket, {
    CONNECTING: { value: 0 }, OPEN: { value: 1 }, CLOSING: { value: 2 }, CLOSED: { value: 3 }
  });

  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    window.EventSource = class ProxyEventSource extends NativeEventSource {
      constructor(url, options) { super(proxied(url), options); }
    };
  }

  if (navigator.serviceWorker && location.protocol === "https:") {
    navigator.serviceWorker.register(${JSON.stringify(SW_PATH)}, { scope: "/" }).catch(console.warn);
  }

  window.__throughWorker = proxied;
})();
</script>`;

  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, match => match + script);
  }
  return script + html;
}

function serviceWorkerResponse() {
  const js = `
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const u = new URL(event.request.url);
  // A service worker can only intercept requests whose request URL is within
  // its own scope. Cross-origin calls are redirected by the page bootstrap.
  if (u.origin === self.location.origin) event.respondWith(fetch(event.request));
});`;
  return new Response(js, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
      "service-worker-allowed": "/",
    },
  });
}

function hasBody(method) {
  return method !== "GET" && method !== "HEAD";
}

function copyRequestHeaders(source) {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.delete("accept-encoding");
  return headers;
}

function safeResponseHeaders(source) {
  const headers = new Headers(source);
  for (const name of [
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "content-length",
    "content-encoding", "set-cookie"
  ]) headers.delete(name);
  return headers;
}

function setSecurityHeaders(headers) {
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("cross-origin-resource-policy", "cross-origin");
  // Unity WebGL commonly needs wasm compilation and blob workers.
  headers.set("content-security-policy",
    "default-src 'self' data: blob: https://raw.githubusercontent.com; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://raw.githubusercontent.com; " +
    "style-src 'self' 'unsafe-inline' https://raw.githubusercontent.com; " +
    "img-src 'self' data: blob: https://raw.githubusercontent.com; font-src 'self' data:; " +
    "connect-src 'self' data: blob: ws: wss: https://raw.githubusercontent.com; " +
    "worker-src 'self' blob: https://raw.githubusercontent.com");
}

function isAllowedHost(hostname, setting) {
  if (setting.trim() === "*") return true;
  const host = hostname.toLowerCase();
  return setting.split(",").map(x => x.trim().toLowerCase()).filter(Boolean).some(entry =>
    host === entry || host.endsWith("." + entry)
  );
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host === "0.0.0.0" || host === "::" || host === "::1") return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map(Number);
    if ([a, b, c, d].some(n => n > 255)) return true;
    return a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }

  return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") ||
    host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb");
}

function contentTypeFor(path) {
  const ext = path.toLowerCase().split(".").pop();
  return ({
    html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
    js: "application/javascript; charset=utf-8", mjs: "application/javascript; charset=utf-8",
    css: "text/css; charset=utf-8", json: "application/json; charset=utf-8",
    wasm: "application/wasm", unityweb: "application/octet-stream",
    data: "application/octet-stream", symbols: "application/octet-stream",
    part1: "application/octet-stream", part2: "application/octet-stream",
    part3: "application/octet-stream", part4: "application/octet-stream",
    part5: "application/octet-stream", part6: "application/octet-stream",
    part7: "application/octet-stream", part8: "application/octet-stream",
    part9: "application/octet-stream",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
  })[ext] || "application/octet-stream";
}
