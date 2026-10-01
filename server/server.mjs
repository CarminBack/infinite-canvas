import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const STATIC_DIR = process.env.STATIC_DIR || "/app/public";
const DATA_DIR = process.env.CANVAS_DATA_DIR || "/app/data";
const PUBLIC_ORIGIN = origin(process.env.CANVAS_PUBLIC_ORIGIN || "https://canvas.mewinyou.shop");
const TOKEN_ORIGIN = origin(process.env.TOKEN_API_BASE_URL || process.env.TOKEN_ISSUER_URL || "https://token.mewinyou.shop");
const IMAGE_ORIGIN = origin(process.env.IMAGE_API_BASE_URL || "https://image-api.mewinyou.shop");
const CLIENT_ID = process.env.CANVAS_OAUTH_CLIENT_ID?.trim() || "canvas";
const REDIRECT_URI = process.env.CANVAS_OAUTH_REDIRECT_URI?.trim() || `${PUBLIC_ORIGIN}/auth/callback`;
const SESSION_TTL = validTtl(process.env.CANVAS_SESSION_TTL_SECONDS);
const SESSION_COOKIE = PUBLIC_ORIGIN.startsWith("https://") ? "__Host-canvas_session" : "canvas_session";
const OAUTH_COOKIE = PUBLIC_ORIGIN.startsWith("https://") ? "__Host-canvas_oauth" : "canvas_oauth";
const COOKIE_FLAGS = `Path=/; HttpOnly; SameSite=Lax${PUBLIC_ORIGIN.startsWith("https://") ? "; Secure" : ""}`;
const CAPABILITIES = new Set(["image", "video", "text", "audio"]);
const ALLOWED = [
    ["POST", /^\/v1\/responses$/, ["text"]],
    ["POST", /^\/v1\/chat\/completions$/, ["text", "audio"]],
    ["POST", /^\/v1\/images\/(generations|edits)$/, ["image"]],
    ["POST", /^\/v1\/videos$/, ["video"]],
    ["GET", /^\/v1\/videos\/[^/]+(?:\/content)?$/, ["video"]],
    ["POST", /^\/v1\/contents\/generations\/tasks$/, ["video"]],
    ["GET", /^\/v1\/contents\/generations\/tasks\/[^/]+$/, ["video"]],
    ["POST", /^\/v1\/audio\/speech$/, ["audio"]],
];
const MIME = { ".css": "text/css; charset=utf-8", ".gif": "image/gif", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2" };

mkdirSync(DATA_DIR, { recursive: true });

// Reference media uploaded by signed-in users, served by unguessable URL so upstream video providers can fetch it.
const UPLOAD_DIR = join(DATA_DIR, "uploads");
const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MB = 1024 * 1024;
const UPLOAD_TYPES = {
    "image/jpeg": [".jpg", 30 * MB], "image/png": [".png", 30 * MB], "image/webp": [".webp", 30 * MB],
    "video/mp4": [".mp4", 50 * MB], "video/quicktime": [".mov", 50 * MB],
    "audio/mpeg": [".mp3", 15 * MB], "audio/mp3": [".mp3", 15 * MB], "audio/wav": [".wav", 15 * MB], "audio/x-wav": [".wav", 15 * MB], "audio/wave": [".wav", 15 * MB], "audio/mp4": [".m4a", 15 * MB], "audio/x-m4a": [".m4a", 15 * MB],
};
const UPLOAD_EXT_MIME = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4" };
mkdirSync(UPLOAD_DIR, { recursive: true });
void cleanupUploads();
setInterval(cleanupUploads, UPLOAD_CLEANUP_INTERVAL_MS).unref();
const db = new DatabaseSync(join(DATA_DIR, "canvas.db"));
db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS canvas_sessions (
 session_hash TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
 username TEXT NOT NULL, token_ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canvas_sessions_expires_at ON canvas_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_canvas_sessions_subject ON canvas_sessions(issuer, subject);`);

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url || "/", PUBLIC_ORIGIN);
        if (url.pathname === "/healthz") return json(res, 200, { status: "ok" });
        if (url.pathname === "/api/auth/login" && req.method === "GET") return login(url, res);
        if (url.pathname === "/auth/callback" && req.method === "GET") return callback(req, url, res);
        if (url.pathname === "/api/auth/session" && req.method === "GET") return sessionInfo(req, res);
        if (url.pathname === "/api/auth/logout" && req.method === "POST") return logout(req, res);
        if (url.pathname === "/api/model-catalog" && req.method === "GET") return modelCatalog(req, res);
        if (url.pathname === "/api/account/balance" && req.method === "GET") return balance(req, res);
        if (url.pathname.startsWith("/api/ai/")) return aiProxy(req, url, res);
        if (url.pathname === "/api/uploads" && req.method === "POST") return uploadReference(req, res);
        if (url.pathname.startsWith("/u/")) return serveUpload(req, url, res);
        if (url.pathname === "/login") return loginPage(req, url, res);
        return staticFile(req, url, res);
    } catch (error) {
        console.error("Canvas gateway request failed", error instanceof Error ? error.message : error);
        if (!res.headersSent) json(res, 500, { error: "服务暂时不可用" });
        else res.end();
    }
});

server.listen(PORT, "0.0.0.0", () => console.log(`Canvas gateway listening on http://0.0.0.0:${PORT}`));

function login(url, res) {
    const returnTo = normalizeReturnTo(url.searchParams.get("return_to"));
    const verifier = randomBytes(64).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const payload = encrypt(JSON.stringify({ state, verifier, returnTo, expiresAt: now() + 600 }));
    const authorize = new URL("/oauth/authorize", TOKEN_ORIGIN);
    Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state, code_challenge: challenge, code_challenge_method: "S256" }).forEach(([key, value]) => authorize.searchParams.set(key, value));
    redirect(res, authorize.toString(), `${OAUTH_COOKIE}=${payload}; Max-Age=600; ${COOKIE_FLAGS}`);
}

async function callback(req, url, res) {
    const loginUrl = new URL("/login", PUBLIC_ORIGIN);
    const oauth = readOauth(cookie(req, OAUTH_COOKIE));
    if (!oauth || !url.searchParams.get("code") || url.searchParams.get("state") !== oauth.state) {
        loginUrl.searchParams.set("error", "登录请求已过期，请重新登录");
        return redirect(res, loginUrl.toString(), clearCookie(OAUTH_COOKIE));
    }
    try {
        const secret = process.env.CANVAS_OAUTH_CLIENT_SECRET?.trim();
        if (!secret) throw new Error("CANVAS_OAUTH_CLIENT_SECRET is required");
        const response = await fetch(new URL("/oauth/token", TOKEN_ORIGIN), {
            method: "POST",
            headers: { Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: REDIRECT_URI, code_verifier: oauth.verifier }),
            signal: AbortSignal.timeout(15000),
        });
        const payload = await response.json();
        const tokens = payload.group_tokens;
        if (!response.ok || payload.token_type?.toLowerCase() !== "bearer" || !tokens?.image || !tokens.video || !tokens.text || !tokens.audio || !payload.user?.sub || !payload.user?.username) {
            throw new Error(payload.error_description || payload.error || `token exchange failed (${response.status})`);
        }
        const sessionId = randomBytes(32).toString("base64url");
        const createdAt = now();
        const expiresAt = createdAt + SESSION_TTL;
        db.prepare(`INSERT INTO canvas_sessions (session_hash, issuer, subject, username, token_ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(hash(sessionId), TOKEN_ORIGIN, payload.user.sub, payload.user.username, encrypt(JSON.stringify(tokens)), createdAt, expiresAt);
        db.prepare("DELETE FROM canvas_sessions WHERE expires_at < ?").run(createdAt);
        res.setHeader("Set-Cookie", [`${SESSION_COOKIE}=${sessionId}; Max-Age=${SESSION_TTL}; ${COOKIE_FLAGS}`, clearCookie(OAUTH_COOKIE)]);
        return redirect(res, new URL(oauth.returnTo, PUBLIC_ORIGIN).toString());
    } catch (error) {
        console.error("Canvas OAuth callback failed", error instanceof Error ? error.message : error);
        loginUrl.searchParams.set("error", "登录配置失败，请稍后重试");
        return redirect(res, loginUrl.toString(), clearCookie(OAUTH_COOKIE));
    }
}

function sessionInfo(req, res) {
    const session = getSession(req);
    return session ? json(res, 200, { authenticated: true, user: { sub: session.subject, username: session.username }, expiresAt: session.expiresAt }) : json(res, 401, { authenticated: false });
}

function logout(req, res) {
    const id = cookie(req, SESSION_COOKIE);
    if (id) db.prepare("DELETE FROM canvas_sessions WHERE session_hash = ?").run(hash(id));
    res.setHeader("Set-Cookie", clearCookie(SESSION_COOKIE));
    return json(res, 200, { success: true });
}

async function modelCatalog(req, res) {
    const session = requireSession(req, res);
    if (!session) return;
    try {
        const [image, video, text, audio, videoDetails, imagePrice] = await Promise.all([
            fetchModels(session.tokens.image), fetchModels(session.tokens.video), fetchModels(session.tokens.text).catch(() => []), fetchModels(session.tokens.audio).catch(() => []), fetchJson(new URL("/api/usage/token/video-models", TOKEN_ORIGIN), session.tokens.video).then((value) => value.data || []).catch(() => []), fetchJson(new URL("/v1/image-group-pricing", TOKEN_ORIGIN), session.tokens.image).then((value) => value.data).catch(() => null),
        ]);
        const videoMetadata = new Map(videoDetails.map((item) => [item.id, item]));
        const defaults = { image: "gpt-image-2", video: "grok-image-video", text: "gpt-5.6-sol", audio: "gpt-4o-audio-preview" };
        return json(res, 200, {
            image: prioritize(image, defaults.image).map((id) => ({ id, priceLabel: imagePrice ? `1K $${Number(imagePrice["1k"]).toFixed(2)} · 2K $${Number(imagePrice["2k"]).toFixed(2)} · 4K $${Number(imagePrice["4k"]).toFixed(2)}` : undefined })),
            video: prioritize(video, defaults.video).map((id) => ({ id, ...videoMeta(videoMetadata.get(id)) })),
            text: prioritize(text.filter(isTextModel), defaults.text).map((id) => ({ id })),
            audio: prioritize(audio, defaults.audio).map((id) => ({ id, priceLabel: "按量计费" })), defaults,
        });
    } catch (error) {
        console.error("Canvas model catalog failed", error instanceof Error ? error.message : error);
        return json(res, 502, { error: "模型列表读取失败" });
    }
}

async function balance(req, res) {
    const session = requireSession(req, res);
    if (!session) return;
    try {
        const payload = await fetchJson(new URL("/api/usage/token/balance", session.issuer), session.tokens.image);
        const data = payload.data;
        if (payload.success === false || !data || !Number.isFinite(data.quota) || !Number.isFinite(data.quota_per_unit) || data.quota_per_unit <= 0) throw new Error(payload.message || "invalid balance");
        return json(res, 200, { quota: data.quota, quotaPerUnit: data.quota_per_unit, quotaDisplayType: data.quota_display_type || "USD", usdExchangeRate: data.usd_exchange_rate || 1, customCurrencySymbol: data.custom_currency_symbol || "¤", customCurrencyExchangeRate: data.custom_currency_exchange_rate || 1, rechargeUrl: new URL("/wallet", session.issuer).toString() });
    } catch (error) {
        console.error("Canvas balance failed", error instanceof Error ? error.message : error);
        return json(res, 502, { error: "余额读取失败" });
    }
}

async function aiProxy(req, url, res) {
    const session = requireSession(req, res);
    if (!session) return;
    const match = url.pathname.match(/^\/api\/ai\/(image|video|text|audio)(\/v1\/.*)$/);
    const legacyMatch = url.pathname.match(/^\/api\/ai(\/v1\/.*)$/);
    const capability = match?.[1] || (legacyMatch ? inferCapability(legacyMatch[1]) : null);
    const path = match?.[2] || legacyMatch?.[1];
    if (!capability || !path || !CAPABILITIES.has(capability)) return json(res, 404, { error: { message: "不允许的模型接口" } });
    if (!ALLOWED.some(([method, pattern, caps]) => method === req.method && pattern.test(path) && caps.includes(capability))) return json(res, 404, { error: { message: "不允许的模型接口" } });
    if (!["GET", "HEAD"].includes(req.method) && req.headers.origin !== PUBLIC_ORIGIN) return json(res, 403, { error: { message: "请求来源校验失败" } });
    const upstreamUrl = new URL(path + url.search, capability === "image" ? IMAGE_ORIGIN : TOKEN_ORIGIN);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value && !["authorization", "cookie", "host", "origin", "referer", "content-length", "connection", "transfer-encoding", "accept-encoding", "forwarded", "x-forwarded-for", "x-real-ip"].includes(key)) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    headers.set("Authorization", `Bearer ${session.tokens[capability]}`);
    headers.set("Accept-Encoding", "identity");
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    const init = { method: req.method, headers, redirect: "manual", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]) };
    if (!["GET", "HEAD"].includes(req.method)) Object.assign(init, { body: Readable.toWeb(req), duplex: "half" });
    const heartbeat = capability === "image" && /^\/v1\/images\/(generations|edits)$/.test(path);
    let timer;
    try {
        if (heartbeat) {
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", "X-Canvas-Proxy-Stream": "1" });
            res.write(" ".repeat(2048) + "\n");
            timer = setInterval(() => res.write(" ".repeat(2048) + "\n"), 15000);
        }
        const upstream = await fetch(upstreamUrl, init);
        if (!heartbeat) {
            const responseHeaders = {};
            upstream.headers.forEach((value, key) => { if (!["set-cookie", "connection", "transfer-encoding", "content-encoding"].includes(key)) responseHeaders[key] = value; });
            responseHeaders["cache-control"] = "no-store";
            if (upstream.status >= 400) {
                // Log a short upstream error summary (no request body or credentials) to diagnose rejected tasks.
                const text = await upstream.text();
                console.error(`Canvas AI upstream ${upstream.status} ${req.method} ${capability}${path}: ${text.slice(0, 500)}`);
                delete responseHeaders["content-length"];
                res.writeHead(upstream.status, responseHeaders);
                return res.end(text);
            }
            res.writeHead(upstream.status, responseHeaders);
        }
        if (upstream.body) await Readable.fromWeb(upstream.body).pipe(res);
        else res.end();
    } catch (error) {
        if (!res.headersSent) json(res, 502, { error: { message: "模型服务暂时不可用" } });
        else if (!res.writableEnded) res.end(JSON.stringify({ error: { message: "模型服务暂时不可用" } }));
    } finally {
        if (timer) clearInterval(timer);
    }
}

async function uploadReference(req, res) {
    const session = requireSession(req, res);
    if (!session) return;
    if (req.headers.origin !== PUBLIC_ORIGIN) return json(res, 403, { error: "请求来源校验失败" });
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const rule = UPLOAD_TYPES[type];
    if (!rule) return json(res, 415, { error: "不支持的文件格式，仅支持 jpg/png/webp、mp4/mov、mp3/wav/m4a" });
    const [ext, maxBytes] = rule;
    const tooLarge = () => json(res, 413, { error: `文件超过 ${maxBytes / MB}MB 上限，请压缩后再上传` });
    if (Number(req.headers["content-length"] || 0) > maxBytes) return tooLarge();
    const name = randomBytes(16).toString("hex") + ext;
    const file = join(UPLOAD_DIR, name);
    let size = 0;
    const limiter = new Transform({
        transform(chunk, _encoding, callback) {
            size += chunk.length;
            callback(size > maxBytes ? new Error("upload too large") : null, chunk);
        },
    });
    try {
        await pipeline(req, limiter, createWriteStream(file, { flags: "wx" }));
    } catch {
        await rm(file, { force: true });
        res.setHeader("Connection", "close");
        if (size > maxBytes) return tooLarge();
        if (!res.headersSent && !res.destroyed) return json(res, 400, { error: "上传中断，请重试" });
        return;
    }
    if (!size) {
        await rm(file, { force: true });
        return json(res, 400, { error: "文件为空" });
    }
    return json(res, 200, { url: `${PUBLIC_ORIGIN}/u/${name}`, bytes: size });
}

function serveUpload(req, url, res) {
    const match = url.pathname.match(/^\/u\/([0-9a-f]{32})(\.[a-z0-9]+)$/);
    if (!match || !UPLOAD_EXT_MIME[match[2]] || !["GET", "HEAD"].includes(req.method)) return json(res, 404, { error: "Not found" });
    const file = join(UPLOAD_DIR, match[1] + match[2]);
    let info;
    try {
        info = statSync(file);
    } catch {
        return json(res, 404, { error: "Not found" });
    }
    res.writeHead(200, { "Content-Type": UPLOAD_EXT_MIME[match[2]], "Content-Length": info.size, "Cache-Control": "public, max-age=86400", "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff" });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
}

async function cleanupUploads() {
    const cutoff = Date.now() - UPLOAD_TTL_MS;
    try {
        for (const name of await readdir(UPLOAD_DIR)) {
            const file = join(UPLOAD_DIR, name);
            const info = await stat(file).catch(() => null);
            if (info?.isFile() && info.mtimeMs < cutoff) await rm(file, { force: true });
        }
    } catch (error) {
        console.error("Canvas upload cleanup failed", error instanceof Error ? error.message : error);
    }
}

function inferCapability(path) {
    if (/^\/v1\/images\//.test(path)) return "image";
    if (/^\/v1\/(videos|contents\/generations\/tasks)/.test(path)) return "video";
    if (/^\/v1\/responses$/.test(path)) return "text";
    if (/^\/v1\/chat\/completions$/.test(path)) return "audio";
    if (/^\/v1\/audio\//.test(path)) return "audio";
    return null;
}

function staticFile(req, url, res) {
    if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { error: "Method not allowed" });
    const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, "");
    let file = join(STATIC_DIR, requested);
    if (!file.startsWith(STATIC_DIR)) return json(res, 404, { error: "Not found" });
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, "index.html");
    if (file.endsWith("index.html") && !getSession(req)) return redirect(res, `/login?return_to=${encodeURIComponent(url.pathname + url.search)}`);
    const stat = statSync(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Content-Length": stat.size, "Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable" });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
}

function loginPage(req, url, res) {
    if (getSession(req)) return redirect(res, normalizeReturnTo(url.searchParams.get("return_to")));
    const error = escapeHtml(url.searchParams.get("error") || "");
    const returnTo = encodeURIComponent(normalizeReturnTo(url.searchParams.get("return_to")));
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录无限画布</title><style>body{margin:0;background:#fafafa;color:#1c1917;font-family:system-ui,-apple-system,sans-serif}.wrap{min-height:100vh;display:grid;place-items:center;padding:24px}.box{width:min(390px,100%);box-sizing:border-box;border:1px solid #e7e5e4;background:white;padding:32px;border-radius:8px}h1{font-size:22px;margin:0 0 8px}p{color:#78716c;font-size:14px;line-height:1.6}.error{color:#b91c1c;background:#fef2f2;padding:10px;margin:18px 0;border-radius:6px}a{display:flex;justify-content:center;background:#1c1917;color:white;text-decoration:none;padding:12px;border-radius:6px;margin-top:24px;font-size:14px}</style></head><body><main class="wrap"><section class="box"><h1>登录无限画布</h1><p>使用 Token 账号安全授权，无需手动填写 API Key。</p>${error ? `<div class="error">${error}</div>` : ""}<a href="/api/auth/login?return_to=${returnTo}">使用 Token 账号一键登录</a><p>真实密钥仅加密保存在服务器会话中。</p></section></main></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(html);
}

function getSession(req) {
    const id = cookie(req, SESSION_COOKIE);
    if (!id) return null;
    const row = db.prepare("SELECT issuer, subject, username, token_ciphertext, expires_at FROM canvas_sessions WHERE session_hash = ?").get(hash(id));
    if (!row) return null;
    if (row.expires_at < now()) { db.prepare("DELETE FROM canvas_sessions WHERE session_hash = ?").run(hash(id)); return null; }
    try { return { issuer: row.issuer, subject: row.subject, username: row.username, tokens: JSON.parse(decrypt(row.token_ciphertext)), expiresAt: row.expires_at }; }
    catch { db.prepare("DELETE FROM canvas_sessions WHERE session_hash = ?").run(hash(id)); return null; }
}
function requireSession(req, res) { const session = getSession(req); if (!session) json(res, 401, { error: "登录已失效，请重新登录" }); return session; }
function readOauth(value) { try { const data = JSON.parse(decrypt(value || "")); return data.state && data.verifier && data.expiresAt >= now() ? { ...data, returnTo: normalizeReturnTo(data.returnTo) } : null; } catch { return null; } }
function encryptionKey() { const raw = process.env.CANVAS_ENCRYPTION_KEY?.trim(); if (!raw) throw new Error("CANVAS_ENCRYPTION_KEY is required"); const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64"); if (key.length !== 32) throw new Error("CANVAS_ENCRYPTION_KEY must be 32 bytes"); return key; }
function encrypt(text) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv); const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]); return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`; }
function decrypt(value) { const [version, iv, tag, body] = value.split("."); if (version !== "v1" || !iv || !tag || !body) throw new Error("invalid encrypted value"); const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url")); decipher.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8"); }
function cookie(req, name) { for (const part of (req.headers.cookie || "").split(";")) { const [key, ...value] = part.trim().split("="); if (key === name) return value.join("="); } }
function clearCookie(name) { return `${name}=; Max-Age=0; ${COOKIE_FLAGS}`; }
function normalizeReturnTo(value) { if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/"; try { const url = new URL(value, PUBLIC_ORIGIN); return url.origin === PUBLIC_ORIGIN && !url.pathname.startsWith("/auth/") && !url.pathname.startsWith("/api/auth/") ? `${url.pathname}${url.search}${url.hash}` : "/"; } catch { return "/"; } }
function redirect(res, location, setCookie) { if (setCookie) res.setHeader("Set-Cookie", setCookie); res.writeHead(302, { Location: location, "Cache-Control": "no-store" }); res.end(); }
function json(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" }); res.end(body); }
async function fetchJson(url, token) { const response = await fetch(url, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: "application/json" }, signal: AbortSignal.timeout(15000) }); const body = await response.json(); if (!response.ok) throw new Error(body.error?.message || body.message || `request failed (${response.status})`); return body; }
async function fetchModels(token) { const payload = await fetchJson(new URL("/v1/models", TOKEN_ORIGIN), token); return [...new Set((payload.data || []).map((item) => item.id?.trim()).filter(Boolean))]; }
function prioritize(models, preferred) { return [...new Set(models)].sort((a, b) => a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b)); }
function videoMeta(item) { return item ? { priceLabel: item.price_label?.trim() || undefined, description: item.description?.trim() || undefined, limitations: Array.isArray(item.limitations) ? item.limitations.filter((value) => typeof value === "string" && value.trim()) : undefined } : { priceLabel: "价格以 Token 页面为准" }; }
function isTextModel(id) { return !["image", "audio", "realtime", "video", "tts", "speech"].some((word) => id.toLowerCase().includes(word)); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function now() { return Math.floor(Date.now() / 1000); }
function origin(value) { return new URL(value).origin; }
function validTtl(value) { const ttl = Number(value || 2592000); return Number.isFinite(ttl) && ttl >= 300 ? Math.floor(ttl) : 2592000; }
function escapeHtml(value) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char])); }
