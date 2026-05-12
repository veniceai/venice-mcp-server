const DEFAULT_BASE_URL = 'https://api.venice.ai/api';
const DEFAULT_TIMEOUT_MS = 60_000;
function normalizeBaseUrl(value) {
    const trimmed = value?.trim();
    if (!trimmed)
        return DEFAULT_BASE_URL;
    const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
    if (withoutTrailingSlash === 'https://api.venice.ai')
        return DEFAULT_BASE_URL;
    return withoutTrailingSlash;
}
function parseTimeoutMs(value) {
    const parsed = Number(value ?? DEFAULT_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}
export function loadConfig(env = process.env) {
    return {
        baseUrl: normalizeBaseUrl(env.VENICE_API_BASE_URL),
        apiKey: env.VENICE_API_KEY,
        siwxToken: env.VENICE_SIWX_TOKEN,
        defaultChatModel: env.VENICE_DEFAULT_CHAT_MODEL ?? 'venice-uncensored',
        defaultImageModel: env.VENICE_DEFAULT_IMAGE_MODEL ?? 'flux-2-pro',
        defaultTtsModel: env.VENICE_DEFAULT_TTS_MODEL ?? 'tts-kokoro',
        defaultAsrModel: env.VENICE_DEFAULT_ASR_MODEL ?? 'openai/whisper-large-v3',
        timeoutMs: parseTimeoutMs(env.VENICE_HTTP_TIMEOUT_MS),
        enableNsfw: env.VENICE_DISABLE_NSFW !== '1',
        serverName: '@veniceai/mcp-server',
        serverVersion: '0.1.0',
    };
}
//# sourceMappingURL=config.js.map