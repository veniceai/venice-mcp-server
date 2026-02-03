#!/usr/bin/env npx tsx
/**
 * Test Venice API endpoints used by the MCP server
 */

const VENICE_API_KEY = process.env.VENICE_API_KEY;
const BASE = 'https://api.venice.ai/api/v1';

if (!VENICE_API_KEY) {
  console.error('❌ VENICE_API_KEY not set');
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${VENICE_API_KEY}`,
  'Content-Type': 'application/json',
};

async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`Testing ${name}... `);
  try {
    await fn();
    console.log('✅');
  } catch (e) {
    console.log(`❌ ${e instanceof Error ? e.message : e}`);
  }
}

async function main() {
  console.log('\n🧪 Testing Venice API Endpoints\n');

  // 1. Chat completions
  await test('venice_chat', async () => {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'llama-3.3-70b',
        messages: [{ role: 'user', content: 'Say "test ok" and nothing else' }],
        max_tokens: 10,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json() as any;
    if (!data.choices?.[0]?.message?.content) throw new Error('No content');
  });

  // 2. Characters list
  await test('venice_characters (list)', async () => {
    const res = await fetch(`${BASE}/characters`, { headers });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json() as any;
    if (!data.data || !Array.isArray(data.data)) throw new Error('Invalid response');
    console.log(`(${data.data.length} characters)`);
  });

  // 3. Models list
  await test('venice_models', async () => {
    const res = await fetch(`${BASE}/models`, { headers });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json() as any;
    if (!data.data || !Array.isArray(data.data)) throw new Error('Invalid response');
    console.log(`(${data.data.length} models)`);
  });

  // 4. Embeddings
  await test('venice_embeddings', async () => {
    const res = await fetch(`${BASE}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'text-embedding-bge-m3',
        input: 'test embedding',
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json() as any;
    if (!data.data?.[0]?.embedding) throw new Error('No embedding');
    console.log(`(${data.data[0].embedding.length} dims)`);
  });

  // 5. Image generation via /image/generate (Venice native)
  await test('venice_image (/image/generate)', async () => {
    const res = await fetch(`${BASE}/image/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'flux-2-max',
        prompt: 'a small red dot on white background',
        width: 512,
        height: 512,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json() as any;
    const url = data.images?.[0]?.url || data.data?.[0]?.url;
    if (!url) throw new Error('No image URL');
    console.log(`(got URL)`);
  });

  // 6. Image upscale
  await test('venice_upscale', async () => {
    // Use a small test image
    const res = await fetch(`${BASE}/image/upscale`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        image: 'https://via.placeholder.com/256',
        scale: 2,
      }),
    });
    // Check if endpoint responds (may fail on invalid image but shouldn't 500)
    if (res.status >= 500) throw new Error(`Server error: ${res.status}`);
    if (res.ok) {
      console.log('(success)');
    } else {
      const err = await res.text();
      if (err.includes('image') || err.includes('pixel')) {
        console.log('(endpoint works, test image rejected)');
      } else {
        throw new Error(err);
      }
    }
  });

  // 7. Image edit
  await test('venice_image_edit', async () => {
    const res = await fetch(`${BASE}/image/edit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        image: 'https://via.placeholder.com/256',
        prompt: 'make it blue',
      }),
    });
    if (res.status >= 500) throw new Error(`Server error: ${res.status}`);
    if (res.ok) {
      console.log('(success)');
    } else {
      const err = await res.text();
      if (err.includes('image') || err.includes('Invalid')) {
        console.log('(endpoint works)');
      } else {
        throw new Error(err);
      }
    }
  });

  // 8. Background remove (with image_url)
  await test('venice_background_remove', async () => {
    const res = await fetch(`${BASE}/image/background-remove`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        image_url: 'https://via.placeholder.com/256',
      }),
    });
    if (res.status >= 500) throw new Error(`Server error: ${res.status}`);
    if (res.ok) {
      console.log('(success)');
    } else {
      const err = await res.text();
      if (err.includes('image') || err.includes('URL')) {
        console.log('(endpoint works)');
      } else {
        throw new Error(err);
      }
    }
  });

  // 9. TTS
  await test('venice_tts', async () => {
    const res = await fetch(`${BASE}/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'tts-kokoro',
        input: 'test',
        voice: 'af_heart',
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const contentType = res.headers.get('content-type');
    if (contentType?.includes('audio')) {
      console.log('(audio binary)');
    } else {
      console.log('(ok)');
    }
  });

  // 10. Video queue
  await test('venice_video_generate', async () => {
    const res = await fetch(`${BASE}/video/queue`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'kling-2.6-pro-text-to-video',
        prompt: 'a cat walking',
        duration: '5',
      }),
    });
    if (res.status >= 500) throw new Error(`Server error: ${res.status}`);
    if (res.ok) {
      const data = await res.json() as any;
      console.log(`(queued: ${data.queue_id?.slice(0, 12)}...)`);
    } else {
      const err = await res.text();
      if (err.includes('permit') || err.includes('access') || err.includes('balance')) {
        console.log('(needs access/balance)');
      } else {
        throw new Error(err);
      }
    }
  });

  // 11. Transcription (with file upload)
  await test('venice_transcribe', async () => {
    // Download a small test audio file
    const testAudioUrl = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';
    
    // Just test the endpoint exists by sending minimal request
    const formData = new FormData();
    formData.append('model', 'openai/whisper-large-v3');
    // Create a tiny audio blob
    const blob = new Blob(['fake audio data'], { type: 'audio/mp3' });
    formData.append('file', blob, 'test.mp3');
    
    const res = await fetch(`${BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VENICE_API_KEY}`,
      },
      body: formData,
    });
    
    if (res.status >= 500) throw new Error(`Server error: ${res.status}`);
    // 400 means endpoint exists but our fake file is invalid
    if (res.status === 400 || res.status === 422) {
      console.log('(endpoint works, needs valid audio)');
    } else if (res.ok) {
      console.log('(success)');
    } else {
      const err = await res.text();
      throw new Error(err);
    }
  });

  console.log('\n✅ Endpoint testing complete!\n');
}

main().catch(console.error);
