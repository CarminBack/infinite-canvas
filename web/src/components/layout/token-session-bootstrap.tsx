import { useEffect } from "react";

import { useConfigStore, type AiConfig, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";

type CatalogItem = { id: string; priceLabel?: string; description?: string; limitations?: string[] };
type ModelCatalog = {
    image: CatalogItem[];
    video: CatalogItem[];
    text: CatalogItem[];
    audio: CatalogItem[];
    defaults: Record<ModelCapability, string>;
};

const CHANNEL_NAMES: Record<ModelCapability, string> = {
    image: "Token Image",
    video: "Token Video",
    text: "Token ChatGPT",
    audio: "Token Audio",
};

export function TokenSessionBootstrap() {
    useEffect(() => {
        const controller = new AbortController();
        void bootstrap(controller.signal);
        return () => controller.abort();
    }, []);
    return null;
}

async function bootstrap(signal: AbortSignal) {
    const session = await fetch("/api/auth/session", { cache: "no-store", signal });
    if (session.status === 401) {
        window.location.assign(`/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`);
        return;
    }
    if (!session.ok) throw new Error("登录状态读取失败");

    const response = await fetch("/api/model-catalog", { cache: "no-store", signal });
    const catalog = (await response.json()) as ModelCatalog & { error?: string };
    if (!response.ok) throw new Error(catalog.error || "模型列表读取失败");
    useConfigStore.setState((state) => ({ config: applyCatalog(state.config, catalog) }));
}

function applyCatalog(config: AiConfig, catalog: ModelCatalog): AiConfig {
    const capabilities: ModelCapability[] = ["image", "video", "text", "audio"];
    const channels = capabilities.map((capability) => catalogChannel(capability, catalog[capability])).filter((channel): channel is ModelChannel => Boolean(channel));
    const models = channels.flatMap((channel) => channel.models.map((model) => `${channel.id}::${model.name}`));
    const selected = (capability: ModelCapability, current: string) => {
        const id = `${capability}::`;
        const currentName = current.includes("::") ? current.slice(current.indexOf("::") + 2) : current;
        const entries = catalog[capability];
        const name = entries.some((item) => item.id === currentName) ? currentName : entries.some((item) => item.id === catalog.defaults[capability]) ? catalog.defaults[capability] : entries[0]?.id;
        return name ? id + name : "";
    };
    const imageModel = selected("image", config.imageModel);
    const videoModel = selected("video", config.videoModel);
    const textModel = selected("text", config.textModel);
    const audioModel = selected("audio", config.audioModel);
    return {
        ...config,
        baseUrl: "/api/ai/image",
        apiKey: "session",
        apiFormat: "openai",
        channels,
        models,
        imageModel,
        videoModel,
        textModel,
        audioModel,
        model: imageModel || textModel || videoModel || audioModel,
        proxyEnabled: false,
    };
}

function catalogChannel(capability: ModelCapability, items: CatalogItem[]): ModelChannel | null {
    if (!items.length) return null;
    const models: ChannelModel[] = items.map((item) => ({ name: item.id, capability, priceLabel: item.priceLabel, description: item.description, limitations: item.limitations }));
    return { id: capability, name: CHANNEL_NAMES[capability], baseUrl: `/api/ai/${capability}`, apiKey: "session", apiFormat: "openai", models };
}
