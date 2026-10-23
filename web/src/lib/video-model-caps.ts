import { appPath } from "@/constant/app-path";

import { modelOptionName, resolveModelChannel, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

import { inferVideoRatio, VIDEO_SECONDS_MIN, VIDEO_SECONDS_MAX } from "@/lib/media-size";

/** Gateway declarations: omitted limits are unknown, not unlimited. */
export type VideoCapabilities = {
    maxPromptChars?: number;
    requestFormat?: "unified_video_v1";
    resolutions?: readonly string[];
    ratios?: readonly string[];
    minSeconds?: number;
    maxSeconds?: number;
    secondsSteps?: readonly number[];
    frames?: boolean;
    maxImages?: number;
    maxVideos?: number;
    maxAudios?: number;
    requiredImages?: number;
    referenceDurationRequired?: boolean;
};

export type VideoModelCaps = VideoCapabilities & { resolution?: string };

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
    if (!model || !resolveModelRequestConfig(config, model).baseUrl.trim().startsWith(appPath("/api/ai/"))) return null;
    const name = modelOptionName(model);
    const declared = resolveModelChannel(config, model).models.find((item) => item.name === name)?.videoCapabilities;
    if (declared?.requestFormat === "unified_video_v1") {
        return { ...declared, resolution: declared.resolutions?.length === 1 ? declared.resolutions[0] : undefined };
    }
    // Keep older gateways and plugins working; new models use backend declarations.
    return videoModelCaps(model);
}

/** Resolution value stored in the panel config (numeric pixels), derived from the fixed model resolution. */
export function capsResolutionValue(caps: VideoModelCaps, current = "720") {
    const options = caps.resolutions || (caps.resolution ? [caps.resolution] : []);
    const value = options.find((item) => (item === "4K" ? "2160" : item.replace(/p$/i, "")) === current) || options[0];
    return value ? (value === "4K" ? "2160" : value.replace(/p$/i, "")) : current;
}

export function inferCapsRatio(caps: VideoModelCaps, size: string) {
    if (caps.ratios?.includes(size)) return size;
    const pixels = size.match(/^(\d+)x(\d+)$/);
    if (pixels && Number(pixels[2]) > 0 && caps.ratios?.length) {
        const target = Number(pixels[1]) / Number(pixels[2]);
        const distance = (ratio: string) => { const [width, height] = ratio.split(":").map(Number); return Math.abs(width / height - target); };
        return caps.ratios.reduce((best, value) => distance(value) < distance(best) ? value : best);
    }
    return clampCapsRatio(caps, inferVideoRatio(size));
}

export function clampCapsRatio(caps: VideoModelCaps, ratio: string) {
    return !caps.ratios?.length || caps.ratios.includes(ratio) ? ratio : caps.ratios[0];
}

export function clampCapsSeconds(caps: VideoModelCaps, value: number) {
    const minSeconds = caps.secondsSteps?.[0] ?? caps.minSeconds ?? Math.min(VIDEO_SECONDS_MIN, caps.maxSeconds ?? VIDEO_SECONDS_MIN);
    const maxSeconds = caps.secondsSteps?.at(-1) ?? caps.maxSeconds ?? Math.max(VIDEO_SECONDS_MAX, minSeconds);
    const seconds = Number.isFinite(value) ? Math.round(value) : minSeconds;
    if (caps.secondsSteps?.length) return caps.secondsSteps.reduce((best, item) => (Math.abs(item - seconds) < Math.abs(best - seconds) ? item : best), caps.secondsSteps[0]);
    return Math.max(minSeconds, Math.min(maxSeconds, seconds));
}
