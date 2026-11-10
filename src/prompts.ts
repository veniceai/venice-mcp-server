/**
 * MCP prompt templates: discoverable, parameterized prompts that hosts
 * can offer as quick-launch entry points.
 */
import { z } from 'zod'
import type { Config } from './config.js'

export interface PromptDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  title: string
  description: string
  /** Hidden when NSFW capability advertising is off (VENICE_DISABLE_NSFW=1). */
  nsfw?: boolean
  argsSchema: S
  build: (args: z.infer<z.ZodObject<S>>) => {
    messages: Array<{
      role: 'user' | 'assistant'
      content: { type: 'text'; text: string }
    }>
  }
}

const userMessage = (lines: string[]): ReturnType<PromptDef['build']> => ({
  messages: [{ role: 'user', content: { type: 'text', text: lines.join('\n') } }],
})

const consentRule = 'Only show a real person from their own photo or with their permission.'
const videoPeopleRule =
  'People: some video models reject footage of identifiable people, such as Seedance models whose id ends in -basic. ' +
  `If one rejects a request showing a person, switch to another model family instead of rewording the prompt. ${consentRule}`
const followSkill = (skill: string) => `If the ${skill} skill is installed, follow it for the details.`
const thumbnailFormats: Record<string, string> = {
  youtube: 'a 16:9 YouTube thumbnail',
  shorts: 'a 9:16 cover for Shorts, Reels or TikTok',
  podcast: 'a 1:1 podcast or course cover',
}

export function buildPrompts(cfg: Pick<Config, 'enableNsfw'>): PromptDef[] {
  const prompts: PromptDef[] = [
    {
      name: 'uncensored-research',
      title: 'Uncensored research',
      description: 'Set up a research session free of nanny refusals (security, medical, legal, journalism).',
      nsfw: true,
      argsSchema: {
        topic: z.string().describe('What you want researched.'),
        domain: z
          .enum(['security', 'medical', 'legal', 'journalism', 'historical', 'other'])
          .optional(),
      },
      build: ({ topic, domain }) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `You are an uncensored research assistant. Domain: ${domain ?? 'general'}. ` +
                `Provide complete, factual analysis. Cite sources where possible. ` +
                `Do not refuse legitimate research questions.\n\nTopic: ${topic}`,
            },
          },
        ],
      }),
    },
    {
      name: 'nsfw-creative-writing',
      title: 'NSFW creative writing',
      description: 'Adult fiction / mature creative writing scaffold.',
      nsfw: true,
      argsSchema: {
        scenario: z.string().describe('Scene or premise.'),
        style: z.string().optional().describe('e.g. "noir", "fantasy", "literary".'),
      },
      build: ({ scenario, style }) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Write an adult creative-writing piece. Style: ${style ?? 'literary'}. ` +
                `Be vivid and unfiltered as appropriate to the scene. ` +
                `Length: 600-1000 words.\n\nScene: ${scenario}`,
            },
          },
        ],
      }),
    },
    {
      name: 'image-style-explorer',
      title: 'Image style explorer',
      description: 'Generate the same prompt across multiple styles for comparison.',
      argsSchema: {
        prompt: z.string(),
        styles: z
          .array(z.string())
          .max(8)
          .optional()
          .describe('Style preset names, see venice://styles.'),
      },
      build: ({ prompt, styles }) => {
        const list = styles ?? ['photographic', 'cinematic', 'anime', 'oil-painting']
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text:
                  `Use the venice_image_generate tool to generate "${prompt}" in each of these styles, ` +
                  `then describe the differences:\n\n${list.map((s: string) => `- ${s}`).join('\n')}`,
              },
            },
          ],
        }
      },
    },
    {
      name: 'create-image',
      title: 'Create images',
      description: 'Turn a brief into finished images: pick a model, generate options, then refine them with edits, cutouts and upscales.',
      argsSchema: {
        brief: z.string().describe('What the image should show.'),
        use: z.string().optional().describe('Where it will be used, e.g. a website hero, an Instagram post or a logo. Sets the shape.'),
      },
      build: ({ brief, use }) => userMessage([
        `Make finished images with the Venice tools for this brief: ${brief}`,
        `Where it will be used: ${use ?? 'not given; ask if it changes the shape'}.`,
        '',
        '1. Ask only for what changes the result: subject, style or mood, how many options, and any exact text that must appear.',
        '2. Pick a model with venice_list_models (type "image") and read its aspect ratios and resolutions with venice_model_details. Use only the values it lists: an unlisted aspect ratio usually falls back to the model\'s default shape instead of failing.',
        '3. Generate with venice_image_generate: one concrete prompt (subject, setting, lighting, composition, style), anything to avoid in negative_prompt, and 2-4 variants to compare. venice_image_styles lists style presets. Each variant is billed as one image, so say how many you are making and on which model.',
        '4. Show the results, then refine with the smallest step that gets there: venice_image_edit for one change, venice_image_multi_edit to combine images, venice_image_remove_bg for a transparent PNG, venice_image_upscale for print sizes.',
        '5. Tell the user the model, prompt, seed and style you used, so the image can be made again.',
        '',
        `${consentRule} ${followSkill('venice-create-image')}`,
      ]),
    },
    {
      name: 'create-video',
      title: 'Create a video',
      description: 'Turn an idea or a still into a finished clip: pick a model, quote the price and confirm, then queue and collect the video.',
      argsSchema: {
        idea: z.string().describe('What happens in the clip.'),
        image_url: z.string().optional().describe('A first frame to animate: a public https URL or a data: URL.'),
        aspect_ratio: z.string().optional().describe('For example 16:9 for the web or 9:16 for vertical social.'),
      },
      build: ({ idea, image_url, aspect_ratio }) => userMessage([
        `Make a video clip with the Venice tools: ${idea}`,
        image_url
          ? `Animate this image as the first frame, with an image-to-video model: ${image_url}`
          : 'There is no starting image, so use a text-to-video model unless the user supplies one.',
        `Aspect ratio: ${aspect_ratio ?? 'ask, or choose it from where the clip will be shown (16:9 for the web, 9:16 for vertical social)'}.`,
        '',
        '1. Plan one clear action per clip, and split a longer story into several clips.',
        '2. Pick a model with venice_list_models (type "video"). Text-to-video and image-to-video are separate model ids. Read its durations (exact strings such as "5s"), aspect ratios, resolutions and audio support with venice_model_details, and build the request only from those.',
        '3. Price it with venice_video_quote, which is free. Tell the user the price and wait for a yes: the charge happens when the job is queued.',
        '4. Queue it with venice_video_generate and keep the queue_id with the model, plus the download_url if one comes back.',
        '5. Wait with venice_video_wait if this server lists it; otherwise poll venice_video_status every 10-20 seconds and tell the user roughly how long is left. A failure is final for that queue_id and is usually refunded.',
        '6. Deliver the video and say which model, prompt, duration and seed you used. If the result is a download_url, download it promptly, since it expires within 24 hours, then call venice_video_complete with the same queue_id and model so Venice deletes its copy.',
        '',
        `${videoPeopleRule} Every retake is billed, so ask before making another. ${followSkill('venice-create-video')}`,
      ]),
    },
    {
      name: 'create-audio',
      title: 'Create audio',
      description: 'Make a song, an instrumental, a loop, a sound effect or a voiceover: pick the model, quote music before queuing it, and collect the audio.',
      argsSchema: {
        brief: z.string().describe('What it should sound like, e.g. a 30 second lo-fi loop, or the script for a voiceover.'),
        kind: z.string().optional().describe('song, instrumental, loop, sound effect or voiceover.'),
      },
      build: ({ brief, kind }) => userMessage([
        `Make audio with the Venice tools: ${brief}`,
        `Kind: ${kind ?? 'work it out from the brief: a song with lyrics, an instrumental, a seamless loop, a sound effect or a spoken voiceover'}.`,
        '',
        'Music, loops and sound effects:',
        '1. Agree on genre or mood, energy, length and whether it has vocals. For a song, agree on the lyrics first, or let the model write them with lyrics_optimizer.',
        '2. Pick a model with venice_list_models (type "music"), and check venice_model_details for lyrics, instrumental and loop support and its duration rules. A field the model does not support is rejected.',
        '3. Price it with venice_audio_quote, which is free. Tell the user the price and wait for a yes.',
        '4. Queue it with venice_music_generate, using lyrics_prompt, force_instrumental or loop only where the model supports them, and keep the queue_id with the model. Wait with venice_music_wait if this server lists it; otherwise poll venice_music_status every few seconds. If the result is a download_url, download it, then call venice_music_complete with the same queue_id and model so Venice deletes its copy.',
        '',
        'Voiceover:',
        '1. Write short sentences, a paragraph or two per call.',
        '2. List voices with venice_voice_clone (action "list"), pick one that suits the brief, and speak the script with venice_tts. Speech is billed per character: the model\'s pricing.input.usd in venice_model_details is USD per million characters.',
        '3. Clone a voice with venice_voice_clone (action "create") only if the person whose voice it is has agreed.',
        '',
        `Tell the user the model, voice and settings you used. ${followSkill('venice-create-audio')}`,
      ]),
    },
    {
      name: 'youtube-thumbnail',
      title: 'YouTube thumbnail',
      description: 'Make thumbnails and covers that honestly show what a video is about, in 16:9, 9:16 or 1:1, with room for a headline.',
      argsSchema: {
        video: z.string().describe('What the video actually shows, and what the viewer gets from it.'),
        headline: z.string().optional().describe('Three to five words, if the thumbnail needs text.'),
        format: z.string().optional().describe('youtube (16:9), shorts (9:16) or podcast (1:1).'),
        photo_url: z.string().optional().describe("The creator's own photo, to put them in the thumbnail."),
      },
      build: ({ video, headline, format, photo_url }) => userMessage([
        `Make thumbnail options with the Venice tools for this video: ${video}`,
        '',
        '1. Promise only what the video delivers. Pick one idea: a result, a before and after, a question or an emotion.',
        `2. Format: ${format ? (thumbnailFormats[format.trim().toLowerCase()] ?? format) : `${thumbnailFormats.youtube}, unless the user wants ${thumbnailFormats.shorts} or ${thumbnailFormats.podcast}`}. Choose a model whose venice_model_details lists that aspect ratio, and check that every result has that shape.`,
        headline
          ? `3. Headline: "${headline}". Either use a model that renders text well, with the exact words in quotes in the prompt, and check the spelling in every result; or leave clean space for it and add it in a design tool.`
          : '3. No headline was requested. If the user wants one, keep it to three to five words.',
        photo_url
          ? `4. Put the creator into the scene from their own photo (${photo_url}) with venice_image_multi_edit or venice_image_edit, and keep their likeness faithful.`
          : `4. ${consentRule}`,
        '   Never generate look-alikes of public figures.',
        '5. Generate 3 or 4 variants with venice_image_generate: a bold subject, strong contrast, a clean background and no clutter. Each variant is billed as one image.',
        '6. Refine the pick with venice_image_edit, then check it at a small size. If the idea is not clear at a glance, simplify it.',
        '',
        followSkill('venice-youtube-thumbnail'),
      ]),
    },
    {
      name: 'product-photoshoot',
      title: 'Product photoshoot',
      description: 'Turn one product photo into studio, lifestyle, flat lay, hero and seasonal shots, keeping the product unchanged.',
      argsSchema: {
        product: z.string().describe('A photo of the product (a public https URL or a data: URL), or a description if there is no photo yet.'),
        shots: z.string().optional().describe('Which shots, e.g. packshot, lifestyle, flat lay, hero banner, seasonal.'),
        brand: z.string().optional().describe('Brand colors, mood and target customer.'),
      },
      build: ({ product, shots, brand }) => userMessage([
        `Run a product photoshoot with the Venice tools. Product: ${product}`,
        `Shots: ${shots ?? 'ask; the usual set is a packshot on white, a lifestyle scene, a flat lay, a hero banner with space for a headline, and a seasonal scene'}.`,
        `Brand: ${brand ?? 'ask for the colors, mood and target customer'}.`,
        '',
        '1. With a photo, edit it once per shot with venice_image_edit (edit models are venice_list_models type "inpaint"). Say what changes, and end every instruction with "Keep the product, its label and colors unchanged." To match a reference look, pass the photo and the reference to venice_image_multi_edit.',
        '   With no photo yet, make concept shots with venice_image_generate, and say they are concepts, not the real product.',
        '2. Compare every shot with the original before showing it: the label text, logo, shape, color and proportions must match. Redo any shot that changed the product, and never present a changed product as the real one.',
        '3. Size each shot for where it goes, using aspect ratios the model lists: 1:1 for a marketplace or social square, 4:5 for a feed portrait, 9:16 for stories, 16:9 or 21:9 for a web hero.',
        '4. Make transparent cutouts with venice_image_remove_bg, and upscale only the final picks with venice_image_upscale (scale 2-4, low creativity).',
        '',
        `Every edit, cutout and upscale is billed per image, so say how many calls the set takes before starting. ${followSkill('venice-product-photoshoot')}`,
      ]),
    },
    {
      name: 'explainer-video',
      title: 'Explainer video',
      description: 'Plan and produce a narrated explainer: script, scene clips, voiceover and music, quoted as a whole before anything is generated, then joined with ffmpeg.',
      argsSchema: {
        topic: z.string().describe('What the video explains.'),
        audience: z.string().optional().describe('Who it is for.'),
        length: z.string().optional().describe('Target length, e.g. 60 seconds.'),
      },
      build: ({ topic, audience, length }) => userMessage([
        `Make a narrated explainer video with the Venice tools about: ${topic}`,
        `Audience: ${audience ?? 'ask'}. Target length: ${length ?? '30 to 90 seconds'}.`,
        '',
        '1. Write the script, then split it into scenes, each with its narration line, what is on screen and a length. Speech runs about 150 words a minute, so a 6 second scene holds about 15 words.',
        '2. Pick one video model with venice_list_models (type "video"), and give every scene one of the durations venice_model_details lists. Use the same model and aspect ratio for every scene, and add one style line (palette, art style, camera feel) to every scene prompt. For the closest match between scenes, make a still per scene with venice_image_generate (same style line and seed) and animate each with an image-to-video model.',
        '3. Quote the whole project before generating anything: venice_video_quote for each clip, venice_audio_quote for an instrumental music bed, and the narration from the speech model\'s pricing.input.usd in venice_model_details, which is USD per million characters of script. Show the total and wait for a yes.',
        '4. Make each scene\'s narration with venice_tts and check that it fits the scene\'s length; shorten the line or lengthen the scene before any video is paid for. Make the first clip with venice_video_generate and show it before queuing the rest, so a wrong look is not paid for in every scene. Then queue the other clips, and an instrumental with venice_music_generate.',
        '5. Save the pieces, calling venice_video_complete or venice_music_complete after downloading any download_url result, and join them with ffmpeg on the user\'s machine: the clips in order with their own audio dropped, each narration line padded to its clip\'s length, and the music underneath at a low volume.',
        '6. Deliver the MP4 with the script, so a single scene can be redone without starting over.',
        '',
        `${videoPeopleRule} A cloned voice needs its owner's permission too. ${followSkill('venice-explainer-video')}`,
      ]),
    },
  ]
  return cfg.enableNsfw ? prompts : prompts.filter((prompt) => !prompt.nsfw)
}
