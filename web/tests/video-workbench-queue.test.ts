import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../src/pages/video/index.tsx", import.meta.url), "utf8");
const queueSource = page.slice(page.indexOf("    const queueGeneration ="), page.indexOf("\n\n    // Handle video-generation commands"));
const updateSource = page.slice(page.indexOf("    const updateVisibleLog ="), page.indexOf("    const pollGenerationLog ="));
const pollSource = page.slice(page.indexOf("    const pollGenerationLog ="), page.indexOf("    const previewGenerationLog ="));
const transpiler = new Bun.Transpiler({ loader: "ts" });
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
class MockArtifactDownloadError extends Error {}

async function createHarness() {
    let sequence = 0;
    let storeError: unknown;
    let results: any[] = [];
    const saved = new Map<string, any>();
    const created: Array<{ id: string; prompt: string; references: unknown[] }> = [];
    const polls = new Map<string, (value: any) => void>();
    const errors: string[] = [];
    const successes: string[] = [];
    const activeLogIdsRef = { current: new Set<string>() };
    const liveJobIdsRef = { current: new Set<string>() };
    const visibleLogIdsRef = { current: new Set<string>() };
    const env = {
        activeLogIdsRef, liveJobIdsRef, visibleLogIdsRef,
        buildLog: ({ prompt, model, config, references, durationMs, status }: any) => ({ id: `log-${++sequence}`, createdAt: Date.now(), prompt, model, config, references, durationMs, status, size: config.size, resolution: config.vquality, seconds: config.videoSeconds }),
        nanoid: () => `video-${sequence}`,
        setPreviewLog: () => {},
        setResults: (update: any) => { results = typeof update === "function" ? update(results) : update; },
        getResults: () => results,
        setClock: () => {},
        updateAgentTask: (_id: string, task: any) => successes.push(task.status),
        message: { success: (text: string) => successes.push(text), error: (text: string) => errors.push(text) },
        t: (key: string) => key, effectiveConfig: {},
        buildVideoConfig: (config: any, model: string) => ({ ...config, model }),
        saveLog: async (log: any) => { if (liveJobIdsRef.current.has(log.id)) saved.set(log.id, { ...log }); },
        createVideoGenerationTask: async (config: any, prompt: string, references: any[]) => {
            const id = `task-${created.length + 1}`;
            created.push({ id, prompt, references });
            return { id, model: config.videoModel };
        },
        pollVideoGenerationTask: (_config: any, task: { id: string }) => new Promise((resolve) => polls.set(task.id, resolve)),
        storeGeneratedVideo: async (result: any) => {
            if (storeError) throw storeError;
            return { url: result.url, storageKey: `stored-${result.url}`, width: 720, height: 1280, bytes: 1234, mimeType: "video/mp4" };
        },
        isVideoArtifactDownloadError: (error: unknown) => error instanceof MockArtifactDownloadError,
        setStoreError: (error: unknown) => { storeError = error; },
        deleteStoredMedia: async () => {},
        delay: async () => {},
        created, polls, saved, errors, successes,
    };
    const source = `${queueSource}\n${updateSource}\n${pollSource}\nreturn { queueGeneration, pollGenerationLog };`;
    const make = new AsyncFunction(...Object.keys(env), transpiler.transformSync(source));
    const functions = await make(...Object.values(env));
    return { ...env, ...functions } as typeof env & { queueGeneration: (snapshot: any, count: number, agentTaskId?: string) => void; pollGenerationLog: (...args: any[]) => Promise<boolean> };
}

test("video batch creates independent tasks and keeps concurrent submissions visible", async () => {
    const h = await createHarness();
    const refsA = [{ id: "ref-a" }];
    const refsB = [{ id: "ref-b" }];
    const snapshot = (text: string, references: unknown[]) => ({ text, config: { videoModel: "seedance-test", model: "seedance-test", size: "9:16", vquality: "720", videoSeconds: "6" }, references, videos: [], audios: [] });
    h.queueGeneration(snapshot("first prompt", refsA), 3, "agent-batch");
    h.queueGeneration(snapshot("second prompt", refsB), 2);

    for (let attempt = 0; attempt < 20 && h.polls.size !== 5; attempt++) await Promise.resolve();
    expect(h.created).toHaveLength(5);
    expect(h.created.filter((item) => item.prompt === "first prompt")).toHaveLength(3);
    expect(h.created.filter((item) => item.prompt === "second prompt")).toHaveLength(2);
    expect(h.created.slice(0, 3).every((item) => item.references === refsA)).toBe(true);
    expect(h.created.slice(3).every((item) => item.references === refsB)).toBe(true);
    expect(h.getResults()).toHaveLength(5);

    h.polls.get("task-3")!({ status: "completed", result: { url: "video-3" } });
    h.polls.get("task-2")!({ status: "failed", error: "mock failure" });
    h.polls.get("task-5")!({ status: "completed", result: { url: "video-5" } });
    h.polls.get("task-1")!({ status: "completed", result: { url: "video-1" } });
    h.polls.get("task-4")!({ status: "completed", result: { url: "video-4" } });
    for (let attempt = 0; attempt < 20 && h.liveJobIdsRef.current.size; attempt++) await new Promise((resolve) => setTimeout(resolve, 0));

    expect([...h.saved.values()].filter((log: any) => log.status === "success")).toHaveLength(4);
    expect([...h.saved.values()].filter((log: any) => log.status === "failed")).toHaveLength(1);
    expect(h.liveJobIdsRef.current.size).toBe(0);
    expect(h.getResults().filter((item: any) => item.status === "success")).toHaveLength(4);
    expect(h.getResults().filter((item: any) => item.status === "failed")).toHaveLength(1);
    expect(h.successes).toContain("succeeded");
});

test("completed results remain visible when a later batch is submitted", async () => {
    const h = await createHarness();
    const snapshot = (text: string) => ({ text, config: { videoModel: "seedance-test", model: "seedance-test", size: "9:16", vquality: "720", videoSeconds: "6" }, references: [], videos: [], audios: [] });
    h.queueGeneration(snapshot("first"), 2);
    for (let attempt = 0; attempt < 20 && h.polls.size !== 2; attempt++) await Promise.resolve();
    h.polls.get("task-1")!({ status: "completed", result: { url: "video-1" } });
    h.polls.get("task-2")!({ status: "completed", result: { url: "video-2" } });
    for (let attempt = 0; attempt < 20 && h.liveJobIdsRef.current.size; attempt++) await new Promise((resolve) => setTimeout(resolve, 0));
    h.queueGeneration(snapshot("second"), 1);
    expect(h.getResults()).toHaveLength(3);
});

test("completed task artifact download errors stay recoverable on the original task", async () => {
    const h = await createHarness();
    const log = { id: "existing-log", createdAt: Date.now() - 1000, prompt: "already generated", model: "seedance-test", config: { videoModel: "seedance-test", model: "seedance-test", size: "9:16", vquality: "720", videoSeconds: "6" }, references: [], videoRefs: [], audioRefs: [], durationMs: 0, size: "9:16", resolution: "720", seconds: "6", status: "pending" as const, task: { id: "task-already-completed", provider: "openai" as const, model: "seedance-test" } };
    h.liveJobIdsRef.current.add(log.id);
    h.visibleLogIdsRef.current.add(log.id);
    h.setStoreError(new MockArtifactDownloadError("artifact endpoint returned 502"));
    const polling = h.pollGenerationLog(log);
    for (let attempt = 0; attempt < 20 && !h.polls.has(log.task.id); attempt++) await Promise.resolve();
    h.polls.get(log.task.id)!({ status: "completed", result: { url: "video" } });
    expect(await polling).toBe(false);
    const persisted: any = h.saved.get(log.id);
    expect(persisted.status).toBe("download_failed");
    expect(persisted.task.id).toBe(log.task.id);
    expect(h.created).toHaveLength(0);
});

test("retrying a record with a task ID rechecks that task instead of creating another", async () => {
    const source = page.slice(page.indexOf("    const retryResult ="), page.indexOf("\n\n    const downloadVideo ="));
    const calls: any[] = [];
    const existing = { id: "record-1", task: { id: "task-existing" }, prompt: "p", model: "m", config: {}, references: [], videoRefs: [], audioRefs: [] };
    const env = {
        logs: [existing], effectiveConfig: {}, buildVideoConfig: () => ({}), queueGeneration: (...args: any[]) => calls.push(["create", ...args]),
        liveJobIdsRef: { current: new Set<string>() }, visibleLogIdsRef: { current: new Set<string>() },
        setPreviewLog: () => {}, setResults: () => {}, saveLog: async (log: any) => calls.push(["save", log]),
        pollGenerationLog: async (log: any) => calls.push(["poll", log.task.id]),
    };
    const make = new AsyncFunction(...Object.keys(env), `${transpiler.transformSync(source)}; return retryResult;`);
    const retryResult = await make(...Object.values(env));
    retryResult(existing.id);
    await Promise.resolve();
    expect(calls.map((item) => item[0])).toEqual(["save", "poll"]);
    expect(calls[1][1]).toBe(existing.task.id);
});

test("history restores reference media URLs from local storage keys", async () => {
    const source = page.slice(page.indexOf("async function normalizeLog("), page.indexOf("\n\nfunction moveListItem"));
    const make = new AsyncFunction(
        "resolveMediaUrl", "resolveImageUrl", "ensureImagePreview", "normalizeLogConfig", "normalizeResolution", "nanoid", "i18n",
        `${transpiler.transformSync(source)}; return { normalizeLog, serializeLog };`,
    );
    const resolveMediaUrl = async (key?: string, fallback = "") => key ? `blob:${key}` : fallback;
    const functions = await make(resolveMediaUrl, async (_key: string, fallback: string) => fallback, () => {}, () => ({ videoModel: "seedance-test", size: "9:16", videoSeconds: "6", vquality: "720" }), (value: string) => value, () => "new-id", { t: () => "Untitled", resolvedLanguage: "en-US" });
    const log = await functions.normalizeLog({
        id: "history-1", model: "seedance-test",
        videoRefs: [{ id: "video-ref", name: "ref.mp4", type: "video/mp4", url: "", storageKey: "video:1" }],
        audioRefs: [{ id: "audio-ref", name: "ref.mp3", type: "audio/mpeg", url: "", storageKey: "audio:1" }],
    });
    expect(log.videoRefs[0].url).toBe("blob:video:1");
    expect(log.audioRefs[0].url).toBe("blob:audio:1");
    const stored = functions.serializeLog({ ...log, references: [], video: { id: "result", url: "blob:result", storageKey: "result:1" } });
    expect(stored.video.url).toBe("");
    expect(stored.videoRefs[0].url).toBe("");
    expect(stored.audioRefs[0].url).toBe("");
});

 test("video selection defaults to one and safely clamps persisted counts", async () => {
    if (!globalThis.localStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0 } });
    const { useConfigStore } = await import("../src/stores/use-config-store");
    expect(useConfigStore.getState().config.videoCount).toBe("1");
    for (const [value, expected] of [["4", 4], ["99", 10], ["0", 1], ["invalid", 1]] as const) {
        const count = Math.max(1, Math.min(10, Math.floor(Number(value) || 1)));
        expect(count).toBe(expected);
    }
});
