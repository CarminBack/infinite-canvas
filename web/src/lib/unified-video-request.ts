import i18n from "@/i18n";
import type { VideoCapabilities } from "@/lib/video-model-caps";

type VideoReference = { url: string; durationMs?: number };
type UnifiedVideoInput = {
    model: string;
    prompt: string;
    seconds: number;
    aspectRatio: string;
    resolution: string;
    frameMode: boolean;
    images: string[];
    videos: VideoReference[];
    audios: string[];
    caps: VideoCapabilities;
};

/** Only declared unified adapters receive this shape; legacy protocols stay untouched. */
export function buildUnifiedVideoRequest(input: UnifiedVideoInput) {
    const { caps, images, videos, audios } = input;
    if (caps.maxPromptChars !== undefined && [...input.prompt.trim()].length > caps.maxPromptChars)
        throw new Error(i18n.t("apiErrors.capsPromptLimit", { count: caps.maxPromptChars }));
    if (input.frameMode && caps.frames !== true) throw new Error(i18n.t("settingsPanels.video.framesUnsupported"));
    if (input.frameMode && images.length > 2) throw new Error(i18n.t("apiErrors.capsImagesLimit", { count: 2 }));
    if (
        caps.referenceDurationRequired &&
        videos.length &&
        (videos.length !== 1 || !Number.isFinite(videos[0].durationMs) || (videos[0].durationMs || 0) <= 0)
    ) {
        throw new Error(i18n.t("apiErrors.referenceVideoDurationRequired"));
    }
    const references: Array<{
        type: "image" | "video" | "audio";
        role: "reference" | "first_frame" | "last_frame";
        url: string;
        duration_seconds?: number;
    }> = [
        ...images.map((url, index) => ({
            type: "image" as const,
            role: input.frameMode ? (index === 0 ? ("first_frame" as const) : ("last_frame" as const)) : ("reference" as const),
            url,
        })),
        ...videos.map((video) => ({
            type: "video" as const,
            role: "reference" as const,
            url: video.url,
            ...(Number.isFinite(video.durationMs) && (video.durationMs || 0) > 0 ? { duration_seconds: video.durationMs! / 1000 } : {}),
        })),
        ...audios.map((url) => ({ type: "audio" as const, role: "reference" as const, url })),
    ];
    if (references.some((item) => !/^https?:\/\/[^\s]+$/i.test(item.url))) throw new Error(i18n.t("apiErrors.publicReferenceRequired"));
    return {
        model: input.model,
        prompt: input.prompt,
        seconds: input.seconds,
        aspect_ratio: input.aspectRatio,
        resolution: input.resolution,
        ...(references.length ? { references } : {}),
    };
}
