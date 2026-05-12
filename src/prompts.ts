/**
 * MCP prompt templates: discoverable, parameterized prompts that hosts
 * can offer as quick-launch entry points.
 */
import { z } from 'zod'

export interface PromptDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  title: string
  description: string
  argsSchema: S
  build: (args: z.infer<z.ZodObject<S>>) => {
    messages: Array<{
      role: 'user' | 'assistant'
      content: { type: 'text'; text: string }
    }>
  }
}

export function buildPrompts(): PromptDef[] {
  return [
    {
      name: 'uncensored-research',
      title: 'Uncensored research',
      description: 'Set up a research session free of nanny refusals (security, medical, legal, journalism).',
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
  ]
}
