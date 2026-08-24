const DEFAULT_TIMEOUT_MS = 60_000;
function parseTimeoutMs(value) {
    const parsed = Number(value ?? DEFAULT_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}
export function loadConfig(env = process.env) {
    return {
        // VENICE_TEST_BASE_URL is an internal test-only escape hatch — never documented publicly.
        baseUrl: env.VENICE_TEST_BASE_URL?.trim() || 'https://api.venice.ai/api',
        apiKey: env.VENICE_API_KEY,
        siwxToken: env.VENICE_SIWX_TOKEN,
        defaultChatModel: env.VENICE_DEFAULT_CHAT_MODEL ?? 'deepseek-v4-flash-0731',
        defaultImageModel: env.VENICE_DEFAULT_IMAGE_MODEL ?? 'flux-2-pro',
        defaultTtsModel: env.VENICE_DEFAULT_TTS_MODEL ?? 'tts-kokoro',
        defaultAsrModel: env.VENICE_DEFAULT_ASR_MODEL ?? 'openai/whisper-large-v3',
        timeoutMs: parseTimeoutMs(env.VENICE_HTTP_TIMEOUT_MS),
        enableNsfw: env.VENICE_DISABLE_NSFW !== '1',
        serverName: '@veniceai/mcp-server',
        serverVersion: '0.2.0',
    };
}
//# sourceMappingURL=config.js.map