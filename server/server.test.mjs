import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const listen = async (server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; };

test("fixed-key subpath gateway keeps credentials server-side and isolates uploads", { timeout: 30000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "canvas-spfx-test-"));
    const calls = [];
    const capabilities = { requestFormat: "unified_video_v1", resolutions: ["768p"], ratios: ["8:5"], minSeconds: 2, maxSeconds: 120, frames: false, maxVideos: 1, maxAudios: 0, referenceDurationRequired: true };
    const artifact = Buffer.alloc(1024 * 1024, 0x61);
    let streamClosed;
    let streamClosedResolve;
    let slowImage = false;
    let stderr = "";
    let metadataStatus = 200;
    let metadataCapabilities = capabilities;
    const upstream = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        calls.push({ path: req.url, token: req.headers.authorization, body: Buffer.concat(chunks).toString() });
        if (req.url.startsWith("/v1/videos/stream-")) {
            if (req.url.includes("before-headers")) return res.destroy();
            if (req.headers.range === "bytes=0-15") {
                assert.equal(req.headers["if-range"], "fixture-etag");
                res.writeHead(206, { "Content-Type": "video/mp4", "Content-Length": 16, "Content-Range": `bytes 0-15/${artifact.length}` });
                return res.end(artifact.subarray(0, 16));
            }
            res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": artifact.length });
            if (req.method === "HEAD") return res.end();
            res.write(artifact.subarray(0, 16384));
            if (req.url.includes("broken")) return setTimeout(() => res.destroy(), 20);
            if (!req.url.includes("cancel") && !req.url.includes("timeout")) return res.end(artifact.subarray(16384));
            const timer = setInterval(() => res.write(artifact.subarray(0, 16384)), 10);
            res.on("close", () => { clearInterval(timer); streamClosedResolve?.(); });
            return;
        }
        res.setHeader("Content-Type", "application/json");
        if (slowImage && req.url === "/v1/images/generations") {
            res.write("{\"data\":[");
            return setTimeout(() => res.end("{}]}"), 15100);
        }
        if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: req.headers.authorization === "Bearer test-image-key" ? "test-image" : "test-video" }] }));
        if (req.url === "/api/usage/token/video-models") {
            res.statusCode = metadataStatus;
            return res.end(JSON.stringify(metadataStatus === 200 ? { data: [{ id: "test-video", price_label: "$0.25/秒", description: "Test video", capabilities: metadataCapabilities }] } : { message: "rate limited" }));
        }
        if (req.url === "/v1/image-group-pricing") return res.end(JSON.stringify({ data: { "1k": 0.1, "2k": 0.2, "4k": 0.4 } }));
        if (req.url === "/v1/videos") return res.end(JSON.stringify({ id: "mock-task", status: "queued" }));
        return res.end(JSON.stringify({ data: [] }));
    });
    const upstreamPort = await listen(upstream);
    const reservation = http.createServer();
    const gatewayPort = await listen(reservation);
    await new Promise((resolve) => reservation.close(resolve));
    await mkdir(join(root, "public"));
    await writeFile(join(root, "public/index.html"), "<!doctype html><title>Canvas fixture</title>");
    const origin = `http://127.0.0.1:${gatewayPort}`;
    // Inject a short deadline only for the timeout fixture; production remains at its existing limit.
    const preload = `const original = globalThis.fetch; globalThis.fetch = (url, init) => original(url, String(url).includes("/stream-timeout/") ? { ...init, signal: AbortSignal.any([init.signal, AbortSignal.timeout(80)]) } : init);`;
    const child = spawn(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(preload), new URL("./server.mjs", import.meta.url).pathname], {
        env: { ...process.env, PORT: String(gatewayPort), STATIC_DIR: join(root, "public"), CANVAS_DATA_DIR: join(root, "data"), CANVAS_BASE_PATH: "/image", CANVAS_PUBLIC_ORIGIN: origin, TOKEN_API_BASE_URL: `http://127.0.0.1:${upstreamPort}`, IMAGE_API_BASE_URL: `http://127.0.0.1:${upstreamPort}`, VIDEO_API_BASE_URL: `http://127.0.0.1:${upstreamPort}`, CANVAS_IMAGE_API_KEY: "test-image-key", CANVAS_VIDEO_API_KEY: "test-video-key" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Gateway failed to start"); })]);
    const request = (path, init) => fetch(origin + path, init);
    assert.equal((await request("/healthz")).status, 200);
    assert.equal((await request("/image/video")).status, 200);
    assert.equal((await request("/api/uploads", { method: "POST" })).status, 404);
    const session = await (await request("/image/api/auth/session")).text();
    assert.equal(JSON.parse(session).authenticated, true);
    assert.ok(!session.includes("test-image-key") && !session.includes("test-video-key"));
    const catalogResponse = await request("/image/api/model-catalog");
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.image[0].id, "test-image");
    assert.equal(catalog.video[0].id, "test-video");
    assert.deepEqual(catalog.video[0].capabilities, capabilities);
    assert.equal(catalog.video[0].capabilities.maxAudios, 0);
    assert.equal(catalog.video[0].capabilities.frames, false);
    metadataStatus = 429;
    const limited = await (await request("/image/api/model-catalog")).json();
    assert.deepEqual(limited.video[0].capabilities, capabilities);
    assert.equal(limited.video[0].priceLabel, "$0.25/秒");
    metadataStatus = 200;
    metadataCapabilities = { ...capabilities, secondsSteps: [5, 10, 15, 30] };
    const recovered = await (await request("/image/api/model-catalog")).json();
    assert.deepEqual(recovered.video[0].capabilities.secondsSteps, [5, 10, 15, 30]);
    assert.equal(catalogResponse.headers.get("cache-control"), "no-store");
    assert.ok(!JSON.stringify(catalog).includes("test-image-key") && !JSON.stringify(catalog).includes("test-video-key"));
    assert.deepEqual(catalog.text, []);
    assert.deepEqual(catalog.audio, []);
    assert.ok(calls.every((call) => ["Bearer test-image-key", "Bearer test-video-key"].includes(call.token)));
    const before = calls.length;
    assert.equal((await request("/image/api/ai/video/v1/videos", { method: "POST", headers: { Origin: "https://wrong.invalid", "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal(calls.length, before);
    const videoBody = { model: "test-video", prompt: "animate", seconds: 90, aspect_ratio: "8:5", resolution: "768p", references: [{ type: "video", role: "reference", url: "https://cdn.example/ref.mp4", duration_seconds: 6.5 }] };
    const video = await request("/image/api/ai/video/v1/videos", { method: "POST", headers: { Origin: origin, Authorization: "Bearer caller-key", "Content-Type": "application/json" }, body: JSON.stringify(videoBody) });
    assert.equal(video.status, 200);
    assert.equal((await video.json()).id, "mock-task");
    assert.equal(calls.at(-1).token, "Bearer test-video-key");
    assert.deepEqual(JSON.parse(calls.at(-1).body), videoBody);
    const image = await request("/image/api/ai/image/v1/images/generations", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(image.headers.get("x-canvas-proxy-stream"), "1");
    await image.json();
    assert.equal(calls.at(-1).token, "Bearer test-image-key");
    await t.test("binary bodies finish completely and existing route policy is unchanged", async () => {
        const path = "/image/api/ai/video/v1/videos/stream-full/content";
        const response = await request(path);
        assert.equal(response.headers.get("content-type"), "video/mp4");
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), artifact);
        const head = await request(path, { method: "HEAD" });
        assert.equal(head.status, 404); // HEAD is not currently allowed by the gateway route table.
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        const range = await request(path, { headers: { Range: "bytes=0-15", "If-Range": "fixture-etag" } });
        assert.equal(range.status, 206);
        assert.equal(range.headers.get("content-range"), `bytes 0-15/${artifact.length}`);
        assert.deepEqual(Buffer.from(await range.arrayBuffer()), artifact.subarray(0, 16));
    });
    await t.test("client cancellation closes upstream without crashing the gateway", async () => {
        streamClosed = new Promise((resolve) => { streamClosedResolve = resolve; });
        const controller = new AbortController();
        const response = await request("/image/api/ai/video/v1/videos/stream-cancel/content", { signal: controller.signal });
        const reader = response.body.getReader();
        await reader.read();
        controller.abort();
        await streamClosed;
        assert.equal((await request("/healthz")).status, 200);
    });
    await t.test("upstream failures do not append JSON to partial binaries", async () => {
        const partial = await new Promise((resolve, reject) => {
            const req = http.get(origin + "/image/api/ai/video/v1/videos/stream-broken/content", (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("error", () => {});
                res.on("close", () => resolve({ bytes: Buffer.concat(chunks), complete: res.complete }));
            });
            req.on("error", reject);
        });
        assert.equal(partial.complete, false);
        assert.deepEqual(partial.bytes, artifact.subarray(0, 16384));
        const timedOut = await request("/image/api/ai/video/v1/videos/stream-timeout/content");
        await assert.rejects(timedOut.arrayBuffer());
        const failed = await request("/image/api/ai/video/v1/videos/stream-before-headers/content");
        assert.equal(failed.status, 502);
        assert.ok((await failed.json()).error.message);
        assert.equal((await request("/healthz")).status, 200);
    });
    await t.test("image heartbeat stops before a slow JSON body is streamed", async () => {
        slowImage = true;
        const response = await request("/image/api/ai/image/v1/images/generations", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
        assert.equal(response.headers.get("x-canvas-proxy-stream"), "1");
        const body = await response.text();
        assert.equal(body.trim(), "{\"data\":[{}]}");
        assert.deepEqual(JSON.parse(body), { data: [{}] });
        slowImage = false;
    });
    assert.equal(child.exitCode, null);
    assert.ok(!stderr.includes("Unhandled") && !stderr.includes("unhandled"), stderr);
    assert.equal((await request("/image/api/ai/text/v1/responses", { method: "POST", headers: { Origin: origin }, body: "{}" })).status, 403);
    assert.equal((await request("/image/api/ai/image/v1/models")).status, 404);
    const bytes = Buffer.from("test fixture bytes");
    const uploadResponse = await request("/image/api/uploads", { method: "POST", headers: { Origin: origin, "Content-Type": "image/png" }, body: bytes });
    assert.equal(uploadResponse.status, 200);
    const upload = await uploadResponse.json();
    assert.ok(upload.url.startsWith(origin + "/image/u/"));
    assert.deepEqual(Buffer.from(await (await fetch(upload.url)).arrayBuffer()), bytes);
    assert.equal((await request("/image/api/uploads", { method: "POST", headers: { Origin: origin, "Content-Type": "text/html" }, body: "<html>" })).status, 415);
});