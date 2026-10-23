import { afterAll, beforeAll, expect, mock, test } from "bun:test";

mock.module("@/constant/app-path", () => ({ appPath: (path: string) => `/image${path}` }));

let capsModule: typeof import("../src/lib/video-model-caps");
let storeModule: typeof import("../src/stores/use-config-store");
let requestModule: typeof import("../src/lib/unified-video-request");
let videoModule: typeof import("../src/services/api/video");
let axios: typeof import("axios").default;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeAll(async () => {
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0 },
    });
    capsModule = await import("../src/lib/video-model-caps");
    storeModule = await import("../src/stores/use-config-store");
    requestModule = await import("../src/lib/unified-video-request");
    videoModule = await import("../src/services/api/video");
    axios = (await import("axios")).default;
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

function input() {
    return {
        model: "brand-new-video",
        prompt: "animate",
        seconds: 90,
        aspectRatio: "8:5",
        resolution: "768p",
        frameMode: false,
        images: [] as string[],
        videos: [] as Array<{ url: string; durationMs?: number }>,
        audios: [] as string[],
        caps: {
            requestFormat: "unified_video_v1" as const,
            resolutions: ["768p", "1080p"],
            ratios: ["8:5", "9:16"],
            minSeconds: 2,
            maxSeconds: 120,
            frames: false,
            maxImages: 2,
            maxVideos: 1,
            maxAudios: 0,
            referenceDurationRequired: true,
        },
    };
}
function config(model = "brand-new-video", declared: import("../src/lib/video-model-caps").VideoCapabilities | undefined = input().caps) {
    return {
        ...storeModule.useConfigStore.getState().config,
        model: `video::${model}`,
        videoModel: `video::${model}`,
        videoSeconds: "90",
        videoMode: "reference",
        size: "1280x800",
        vquality: "768",
        proxyEnabled: false,
        channels: [
            storeModule.createModelChannel({
                id: "video",
                baseUrl: "/image/api/ai/video",
                apiKey: "session",
                apiFormat: "openai",
                models: [{ name: model, capability: "video", videoCapabilities: declared }],
            }),
        ],
    };
}

test("SPFX image subpath uses declared limits without frontend provider rules", () => {
    expect(capsModule.videoModelCaps("brand-new-video")).toBeNull();
    const cfg = config();
    const caps = capsModule.tokenVideoModelCaps(cfg, cfg.model)!;
    expect(caps.requestFormat).toBe("unified_video_v1");
    expect(capsModule.clampCapsSeconds(caps, 90)).toBe(90);
    expect(capsModule.inferCapsRatio(caps, "1280x800")).toBe("8:5");
    expect(capsModule.capsResolutionValue(caps, "1080")).toBe("1080");
});

test("normalizing persisted model metadata preserves explicit zero and false", () => {
    const models = storeModule.normalizeChannelModels([{ name: "brand-new-video", capability: "video", videoCapabilities: input().caps }]);
    expect(models[0].videoCapabilities?.frames).toBe(false);
    expect(models[0].videoCapabilities?.maxAudios).toBe(0);
});

test("old gateways retain existing Seedance capability behavior", () => {
    const cfg = config("seedance-720p-c49", undefined);
    cfg.channels[0].models[0].videoCapabilities = undefined;
    const caps = capsModule.tokenVideoModelCaps(cfg, cfg.model)!;
    expect(caps.resolution).toBe("720p");
    expect(caps.frames).toBe(true);
    expect(capsModule.clampCapsSeconds(caps, 90)).toBe(15);
});

test("ordinary reference images never become first and last frames implicitly", () => {
    const value = input();
    value.images = ["https://cdn.example/a.png", "https://cdn.example/b.png"];
    const body = requestModule.buildUnifiedVideoRequest(value);
    expect(body.references?.map((item) => item.role)).toEqual(["reference", "reference"]);
    expect(body).not.toHaveProperty("size");
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("duration");
});

test("explicit frame requests require declared support and preserve roles", () => {
    const value = input();
    value.frameMode = true;
    value.images = ["https://cdn.example/a.png", "https://cdn.example/b.png"];
    expect(() => requestModule.buildUnifiedVideoRequest(value)).toThrow();
    value.caps.frames = true;
    expect(requestModule.buildUnifiedVideoRequest(value).references?.map((item) => item.role)).toEqual(["first_frame", "last_frame"]);
});

test("reference duration is source metadata, not requested output seconds", () => {
    const value = input();
    value.videos = [{ url: "https://cdn.example/ref.mp4", durationMs: 6500 }];
    expect(requestModule.buildUnifiedVideoRequest(value).references?.[0].duration_seconds).toBe(6.5);
    delete value.videos[0].durationMs;
    expect(() => requestModule.buildUnifiedVideoRequest(value)).toThrow();
});

test("discrete declared durations are retained beyond generic UI bounds", () => {
    expect(capsModule.clampCapsSeconds({ requestFormat: "unified_video_v1", secondsSteps: [60, 120] }, Number.NaN)).toBe(60);
    expect(capsModule.clampCapsSeconds({ requestFormat: "unified_video_v1", secondsSteps: [60, 120] }, 110)).toBe(120);
});

test("provider asset identifiers are not silently forwarded as unified URLs", () => {
    const value = input();
    value.videos = [{ url: "asset://provider-private-id", durationMs: 6500 }];
    expect(() => requestModule.buildUnifiedVideoRequest(value)).toThrow();
});

test("prompt limits count Unicode characters rather than UTF-16 code units", () => {
    const value = { ...input(), caps: { ...input().caps, maxPromptChars: 3 }, prompt: "😀😀😀" };
    expect(requestModule.buildUnifiedVideoRequest(value).prompt).toBe(value.prompt);
    value.prompt += "😀";
    expect(() => requestModule.buildUnifiedVideoRequest(value)).toThrow();
});

test("actual create path sends unified fields and keeps durations beyond legacy UI defaults", async () => {
    const original = axios.post;
    const calls: Array<{ url: string; body: any }> = [];
    axios.post = (async (url: string, body: unknown) => {
        calls.push({ url, body });
        return { data: { id: "local-job" } };
    }) as typeof axios.post;
    try {
        const cfg = config();
        const task = await videoModule.createVideoGenerationTask(cfg, "animate", [], {
            videos: [{ id: "ref", name: "ref.mp4", type: "video/mp4", url: "https://cdn.example/ref.mp4", durationMs: 6500 }],
        });
        expect(task.id).toBe("local-job");
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("/image/api/ai/video/v1/videos");
        expect(calls[0].body.seconds).toBe(90);
        expect(calls[0].body.aspect_ratio).toBe("8:5");
        expect(calls[0].body.resolution).toBe("768p");
        expect(calls[0].body.references[0]).toEqual({
            type: "video",
            role: "reference",
            url: "https://cdn.example/ref.mp4",
            duration_seconds: 6.5,
        });
        expect(calls[0].body).not.toHaveProperty("metadata");
        expect(calls[0].body).not.toHaveProperty("size");
    } finally {
        axios.post = original;
    }
});

test("unmeasured reference duration fails before any upstream task request", async () => {
    const original = axios.post;
    let calls = 0;
    axios.post = (async () => {
        calls++;
        return { data: { id: "must-not-submit" } };
    }) as typeof axios.post;
    try {
        await expect(
            videoModule.createVideoGenerationTask(config(), "animate", [], {
                videos: [{ id: "ref", name: "ref.mp4", type: "video/mp4", url: "https://cdn.example/ref.mp4" }],
            }),
        ).rejects.toThrow();
        expect(calls).toBe(0);
    } finally {
        axios.post = original;
    }
});

test("Sora without an opt-in keeps its existing pixel-size request", async () => {
    const original = axios.post;
    const bodies: any[] = [];
    axios.post = (async (_url: string, body: unknown) => {
        bodies.push(body);
        return { data: { id: "legacy-job" } };
    }) as typeof axios.post;
    try {
        const cfg = config("sora-2");
        cfg.channels[0].models[0].videoCapabilities = undefined;
        cfg.size = "720x1280";
        cfg.vquality = "720";
        cfg.videoSeconds = "8";
        await videoModule.createVideoGenerationTask(cfg, "animate", []);
        expect(bodies[0].size).toBe("720x1280");
        expect(bodies[0]).not.toHaveProperty("references");
        expect(bodies[0].extra.aspect_ratio).toBe("9:16");
    } finally {
        axios.post = original;
    }
});
