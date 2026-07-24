import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export const SEEDANCE_REFERENCE_LIMITS = {
    images: 9,
    videos: 3,
    audios: 3,
    imageMaxBytes: 30 * 1024 * 1024,
    videoMaxBytes: 50 * 1024 * 1024,
    audioMaxBytes: 15 * 1024 * 1024,
};

export type SeedanceModeType = "text2video" | "image2video" | "frames2video";

export type SeedanceCapabilities = {
    channel?: 47 | 48 | 49 | 50;
    minDuration: number;
    maxDuration: number;
    ratios: readonly string[];
    modes: readonly SeedanceModeType[];
    maxImages: number;
    maxVideos: number;
    maxAudios: number;
    resolution?: "480p" | "720p" | "1080p" | "4K";
};

const ALL_SEEDANCE_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "2:3", "3:2"] as const;
const COMPACT_SEEDANCE_RATIOS = ["16:9", "9:16", "1:1"] as const;
const ALL_SEEDANCE_MODES = ["text2video", "image2video", "frames2video"] as const;

export const seedanceModeOptions = [
    { value: "auto", label: "自动" },
    { value: "text2video", label: "文生视频" },
    { value: "image2video", label: "图生视频" },
    { value: "frames2video", label: "首尾帧" },
] as const;

export const seedanceResolutionOptions = [
    { value: "480p", label: "480p" },
    { value: "720p", label: "720p" },
    { value: "1080p", label: "1080p" },
    { value: "4K", label: "4K" },
] as const;

export const seedanceRatioOptions = [
    { value: "16:9", label: "横屏" },
    { value: "9:16", label: "竖屏" },
    { value: "1:1", label: "方形" },
    { value: "4:3", label: "标准横屏" },
    { value: "3:4", label: "标准竖屏" },
    { value: "21:9", label: "宽银幕" },
    { value: "2:3", label: "海报竖屏" },
    { value: "3:2", label: "相机横屏" },
    { value: "adaptive", label: "自适应" },
] as const;

export const seedanceDurationOptions = [4, 5, 6, 8, 12, 15] as const;

const seedancePixels = {
    "480p": {
        "16:9": "864x496",
        "4:3": "752x560",
        "1:1": "640x640",
        "3:4": "560x752",
        "9:16": "496x864",
        "21:9": "992x432",
    },
    "720p": {
        "16:9": "1280x720",
        "4:3": "1112x834",
        "1:1": "960x960",
        "3:4": "834x1112",
        "9:16": "720x1280",
        "21:9": "1470x630",
    },
    "1080p": {
        "16:9": "1920x1080",
        "4:3": "1664x1248",
        "1:1": "1440x1440",
        "3:4": "1248x1664",
        "9:16": "1080x1920",
        "21:9": "2206x946",
    },
} as const;

export function isSeedanceVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "baseUrl">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return isSeedanceVideoModel(modelOptionName(requestConfig.model || requestConfig.videoModel)) || isArkPlanBaseUrl(requestConfig.baseUrl);
}

export function isSeedanceVideoModel(model: string) {
    const value = model.toLowerCase();
    return value.includes("seedance") || value.includes("doubao-seedance");
}

export function isSeedanceFastModel(model: string) {
    const value = model.toLowerCase();
    return isSeedanceVideoModel(value) && value.includes("fast");
}

export function seedanceCapabilitiesForModel(model: string): SeedanceCapabilities {
    const value = modelOptionName(model).toLowerCase();
    const channelMatch = value.match(/-c(47|48|49|50)$/);
    const channel = channelMatch ? (Number(channelMatch[1]) as 47 | 48 | 49 | 50) : undefined;
    const resolutionMatch = value.match(/seedance-(480p|720p|1080p|4k)(?:-|$)/);
    const resolution = resolutionMatch ? (resolutionMatch[1] === "4k" ? "4K" : (resolutionMatch[1] as "480p" | "720p" | "1080p")) : undefined;

    if (channel === 50) {
        return {
            channel,
            minDuration: 5,
            maxDuration: 15,
            ratios: COMPACT_SEEDANCE_RATIOS,
            modes: ["text2video", "image2video"],
            maxImages: 4,
            maxVideos: 3,
            maxAudios: 1,
            resolution,
        };
    }
    if (channel === 49) {
        return { channel, minDuration: 4, maxDuration: 15, ratios: COMPACT_SEEDANCE_RATIOS, modes: ALL_SEEDANCE_MODES, maxImages: 9, maxVideos: 3, maxAudios: 3, resolution };
    }
    if (channel === 47 || channel === 48) {
        return { channel, minDuration: 4, maxDuration: 15, ratios: ALL_SEEDANCE_RATIOS, modes: ALL_SEEDANCE_MODES, maxImages: 9, maxVideos: 3, maxAudios: 3, resolution };
    }
    return { minDuration: 4, maxDuration: 15, ratios: [...ALL_SEEDANCE_RATIOS, "adaptive"], modes: ALL_SEEDANCE_MODES, maxImages: 9, maxVideos: 3, maxAudios: 3, resolution };
}

export function resolveSeedanceModeType(value: string | undefined, imageCount: number, capabilities: SeedanceCapabilities): SeedanceModeType {
    if (value && value !== "auto" && capabilities.modes.includes(value as SeedanceModeType)) return value as SeedanceModeType;
    return imageCount > 0 ? "image2video" : "text2video";
}

export function validateSeedanceRequest(model: string, modeValue: string | undefined, images: ReferenceImage[], videos: ReferenceVideo[], audios: ReferenceAudio[]) {
    const capabilities = seedanceCapabilitiesForModel(model);
    if (images.length > capabilities.maxImages) return `当前模型最多支持 ${capabilities.maxImages} 张参考图`;
    if (videos.length > capabilities.maxVideos) return `当前模型最多支持 ${capabilities.maxVideos} 个参考视频`;
    if (audios.length > capabilities.maxAudios) return `当前模型最多支持 ${capabilities.maxAudios} 个参考音频`;
    if (modeValue !== "auto" && modeValue && !capabilities.modes.includes(modeValue as SeedanceModeType)) return "当前模型不支持所选生成模式";
    const mode = resolveSeedanceModeType(modeValue, images.length, capabilities);
    if (mode === "text2video" && images.length) return "文生视频模式不能传参考图，请移除参考图或切换为图生视频";
    if (mode === "image2video" && !images.length) return "图生视频模式至少需要 1 张参考图";
    if (mode === "frames2video" && images.length !== 2) return "首尾帧模式必须正好传入 2 张参考图，顺序为首帧、尾帧";
    return "";
}

export function isArkPlanBaseUrl(baseUrl: string) {
    return baseUrl.toLowerCase().includes("ark.cn-beijing.volces.com/api/plan/v3") || baseUrl.toLowerCase().includes("/api/plan/v3");
}

export function normalizeSeedanceResolution(value: string, model = "") {
    const modelResolution = seedanceCapabilitiesForModel(model).resolution;
    if (modelResolution) return modelResolution;
    const normalized = normalizeResolutionToken(value);
    return seedanceResolutionOptions.some((item) => item.value === normalized) ? normalized : "720p";
}

export function normalizeResolutionToken(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    if (String(value).toLowerCase() === "4k") return "4K";
    const resolution = String(value || "").replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

export function normalizeSeedanceDuration(value: string, model = "") {
    const capabilities = seedanceCapabilitiesForModel(model);
    const seconds = Math.floor(Number(value) || capabilities.minDuration);
    return Math.max(capabilities.minDuration, Math.min(capabilities.maxDuration, seconds));
}

export function normalizeSeedanceRatio(value: string, model = "") {
    const capabilities = seedanceCapabilitiesForModel(model);
    if (!value || value === "auto" || value === "adaptive") return capabilities.ratios.includes("adaptive") ? "adaptive" : "16:9";
    if (capabilities.ratios.includes(value)) return value;
    const match = value.match(/^(\d+)x(\d+)$/);
    if (!match) return capabilities.ratios.includes("16:9") ? "16:9" : capabilities.ratios[0];
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return capabilities.ratios.includes("16:9") ? "16:9" : capabilities.ratios[0];
    const ratio = width / height;
    const options = [
        ["16:9", 16 / 9],
        ["4:3", 4 / 3],
        ["1:1", 1],
        ["3:4", 3 / 4],
        ["9:16", 9 / 16],
        ["21:9", 21 / 9],
        ["2:3", 2 / 3],
        ["3:2", 3 / 2],
    ] as const;
    const supported = options.filter((item) => capabilities.ratios.includes(item[0]));
    return supported.reduce((best, item) => (Math.abs(item[1] - ratio) < Math.abs(best[1] - ratio) ? item : best), supported[0])[0];
}

export function seedancePixelLabel(resolution: string, ratio: string) {
    const normalizedResolution = normalizeSeedanceResolution(resolution);
    const normalizedRatio = normalizeSeedanceRatio(ratio);
    if (normalizedRatio === "adaptive") return "自动匹配";
    if (!(normalizedResolution in seedancePixels)) return normalizedRatio;
    const pixels = seedancePixels[normalizedResolution as keyof typeof seedancePixels] as Partial<Record<string, string>>;
    return pixels[normalizedRatio] || normalizedRatio;
}

export function boolConfig(value: string | undefined, fallback: boolean) {
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
}

export function seedanceReferenceLabel(kind: "image" | "video" | "audio", index: number) {
    if (kind === "image") return `图片${index + 1}`;
    if (kind === "video") return `视频${index + 1}`;
    return `音频${index + 1}`;
}

export function buildSeedancePromptText(prompt: string, images: ReferenceImage[], videos: ReferenceVideo[], audios: ReferenceAudio[]) {
    const labels = [...images.map((_, index) => seedanceReferenceLabel("image", index)), ...videos.map((_, index) => seedanceReferenceLabel("video", index)), ...audios.map((_, index) => seedanceReferenceLabel("audio", index))];
    const text = prompt.trim();
    if (!labels.length) return text;
    return `参考素材编号：${labels.join("、")}。请按这些编号理解提示词中的图片、视频和音频引用。\n\n${text}`;
}

export function seedanceVideoReferenceError(videos: ReferenceVideo[]) {
    let totalDurationMs = 0;
    for (let index = 0; index < videos.length; index += 1) {
        const video = videos[index];
        const label = seedanceReferenceLabel("video", index);
        if (video.bytes && video.bytes > SEEDANCE_REFERENCE_LIMITS.videoMaxBytes) return `${label} 超过 50MB，请压缩后再上传`;
        if (video.durationMs) {
            if (video.durationMs < 2000 || video.durationMs > 15000) return `${label} 时长需要在 2-15 秒之间`;
            totalDurationMs += video.durationMs;
        }
        if (video.width && video.height) {
            if (video.width < 300 || video.width > 6000 || video.height < 300 || video.height > 6000) return `${label} 宽高需要在 300-6000px 之间`;
            const ratio = video.width / video.height;
            if (ratio < 0.4 || ratio > 2.5) return `${label} 宽高比需要在 0.4-2.5 之间`;
            const pixels = video.width * video.height;
            if (pixels < 640 * 640 || pixels > 2206 * 946) return `${label} 像素总量不符合 Seedance 要求，请转成 480p/720p/1080p 后再上传`;
        }
    }
    if (totalDurationMs > 15000) return "Seedance 参考视频总时长不能超过 15 秒";
    return "";
}

export const seedanceVideoReferenceHint = "参考视频需为 mp4/mov，H.264/H.265，FPS 24-60；含真人人脸素材请使用火山授权 asset:// 素材。";
