import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

/** Capability limits for a Token-hosted video model, used by both the settings panel and request normalization. */
export type VideoModelCaps = {
    /** Fixed output resolution label (the model name encodes it), e.g. "720p" or "4K". */
    resolution: string;
    ratios: readonly string[];
    minSeconds: number;
    maxSeconds: number;
    /** Discrete allowed durations; when set, only these values are valid. */
    secondsSteps?: readonly number[];
    /** Whether first/last-frame generation is supported. */
    frames: boolean;
    maxImages: number;
    maxVideos: number;
    maxAudios: number;
    /** Exact number of reference images required (e.g. grok-video-1.5 needs exactly one). */
    requiredImages?: number;
};

const SEEDANCE_RATIOS_6 = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;

// Line limits mirrored from the AistarsLab channel list provided by the operator.
const SEEDANCE_CHANNELS: Record<string, Omit<VideoModelCaps, "resolution">> = {
    "47": { ratios: SEEDANCE_RATIOS_6, minSeconds: 4, maxSeconds: 15, frames: false, maxImages: 9, maxVideos: 3, maxAudios: 3 },
    "48": { ratios: SEEDANCE_RATIOS_6, minSeconds: 4, maxSeconds: 15, frames: false, maxImages: 9, maxVideos: 3, maxAudios: 3 },
    "50": { ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"], minSeconds: 4, maxSeconds: 15, frames: false, maxImages: 9, maxVideos: 3, maxAudios: 3 },
    "53": { ratios: SEEDANCE_RATIOS_6, minSeconds: 4, maxSeconds: 15, frames: false, maxImages: 9, maxVideos: 3, maxAudios: 3 },
    "54": { ratios: SEEDANCE_RATIOS_6, minSeconds: 4, maxSeconds: 30, frames: false, maxImages: 30, maxVideos: 10, maxAudios: 10 },
    "58": { ratios: ["16:9", "9:16"], minSeconds: 5, maxSeconds: 15, secondsSteps: [5, 10, 15], frames: false, maxImages: 9, maxVideos: 0, maxAudios: 0 },
    "63": { ratios: ["16:9", "9:16", "1:1"], minSeconds: 4, maxSeconds: 30, frames: false, maxImages: 30, maxVideos: 10, maxAudios: 10 },
    "64": { ratios: SEEDANCE_RATIOS_6, minSeconds: 4, maxSeconds: 15, frames: false, maxImages: 9, maxVideos: 3, maxAudios: 3 },
};

const SEEDANCE_DEFAULT: Omit<VideoModelCaps, "resolution"> = { ratios: SEEDANCE_RATIOS_6, minSeconds: 4, maxSeconds: 15, frames: true, maxImages: 9, maxVideos: 3, maxAudios: 3 };

const GROK_VIDEO_CAPS: VideoModelCaps = { resolution: "720p", ratios: ["16:9", "9:16"], minSeconds: 4, maxSeconds: 15, frames: false, maxImages: 1, maxVideos: 0, maxAudios: 0, requiredImages: 1 };

/** Capability limits by model name; returns null for models without known Token limits. */
export function videoModelCaps(model: string): VideoModelCaps | null {
    const name = modelOptionName(model).trim().toLowerCase();
    if (name === "grok-video-1.5") return GROK_VIDEO_CAPS;
    if (!name.startsWith("seedance-")) return null;
    const resolutionMatch = name.match(/^seedance-(480p|720p|1080p|4k)(?:-|$)/);
    const resolution = resolutionMatch ? (resolutionMatch[1] === "4k" ? "4K" : resolutionMatch[1]) : "720p";
    const channel = name.match(/-c(\d+)$/)?.[1] || "";
    return { resolution, ...(SEEDANCE_CHANNELS[channel] || SEEDANCE_DEFAULT) };
}

/** Caps only apply to models served through the Token gateway; user-configured channels keep the generic controls. */
export function tokenVideoModelCaps(config: AiConfig, model: string) {
    if (!model || !resolveModelRequestConfig(config, model).baseUrl.trim().startsWith("/api/ai/")) return null;
    return videoModelCaps(model);
}

/** Resolution value stored in the panel config (numeric pixels), derived from the fixed model resolution. */
export function capsResolutionValue(caps: VideoModelCaps) {
    return caps.resolution === "4K" ? "2160" : caps.resolution.replace(/p$/i, "");
}

export function clampCapsRatio(caps: VideoModelCaps, ratio: string) {
    return caps.ratios.includes(ratio) ? ratio : caps.ratios[0];
}

export function clampCapsSeconds(caps: VideoModelCaps, value: number) {
    const seconds = Number.isFinite(value) ? Math.round(value) : caps.minSeconds;
    if (caps.secondsSteps?.length) return caps.secondsSteps.reduce((best, item) => (Math.abs(item - seconds) < Math.abs(best - seconds) ? item : best), caps.secondsSteps[0]);
    return Math.max(caps.minSeconds, Math.min(caps.maxSeconds, seconds));
}
