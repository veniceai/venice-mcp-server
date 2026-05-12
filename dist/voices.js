export function getVoiceCatalog() {
    return {
        note: 'Venice does not expose a list endpoint. These are the built-in voices available across TTS models. Cloned voices come back as `vv_<id>` from action=create.',
        kokoro: {
            description: 'Default model "tts-kokoro" - fast, multilingual, 70+ voices',
            examples: [
                'af_heart',
                'af_alloy',
                'af_aoede',
                'af_bella',
                'af_jessica',
                'af_kore',
                'af_nicole',
                'af_nova',
                'af_river',
                'af_sarah',
                'af_sky',
                'am_adam',
                'am_echo',
                'am_eric',
                'am_fenrir',
                'am_liam',
                'am_michael',
                'am_onyx',
                'am_puck',
            ],
        },
        orpheus: {
            description: 'Model "tts-orpheus" - expressive, supports emotion tags',
            voices: ['leah', 'jess', 'mia', 'zoe', 'leo', 'dan', 'zac', 'tara'],
        },
        other_models: [
            'tts-qwen3-0-6b',
            'tts-qwen3-1-7b',
            'tts-xai-v1',
            'tts-inworld-1-5-max',
            'tts-chatterbox-hd',
            'tts-elevenlabs-turbo-v2-5',
            'tts-minimax-speech-02-hd',
            'tts-gemini-3-1-flash',
        ],
        voice_cloning_supported: ['tts-chatterbox-hd', 'tts-minimax-speech-02-hd'],
        docs: 'https://docs.venice.ai/api-reference/api-spec/tts',
    };
}
//# sourceMappingURL=voices.js.map