/**
 * MCP prompt templates: discoverable, parameterized prompts that hosts
 * can offer as quick-launch entry points.
 */
import { z } from 'zod';
export interface PromptDef<S extends z.ZodRawShape = z.ZodRawShape> {
    name: string;
    title: string;
    description: string;
    argsSchema: S;
    build: (args: z.infer<z.ZodObject<S>>) => {
        messages: Array<{
            role: 'user' | 'assistant';
            content: {
                type: 'text';
                text: string;
            };
        }>;
    };
}
export declare function buildPrompts(): PromptDef[];
//# sourceMappingURL=prompts.d.ts.map