import { z } from 'zod';
import { env } from '@/lib/env';

/**
 * Structured LLM output provider.
 *
 * The system is designed so every AI process has a deterministic rule-based
 * path. The LLM improves phrasing and extraction recall; it is never the only
 * thing standing between a raw signal and a business decision.
 */
export type StructuredRequest<T> = {
  /** Stable identifier used for decision traceability. */
  promptVersion: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Deterministic result used when no LLM is configured or the call fails. */
  fallback: () => T;
  maxTokens?: number;
  temperature?: number;
};

export type StructuredResult<T> = {
  data: T;
  modelName: string;
  promptVersion: string;
  usedFallback: boolean;
  latencyMs: number;
};

export interface LLMProvider {
  readonly name: string;
  structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/**
 * Deterministic provider. Returns the caller's rule-based fallback, so every
 * feature works end-to-end with zero credentials and tests stay repeatable.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';

  async structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    const data = request.schema.parse(request.fallback());
    return {
      data,
      modelName: 'mock-deterministic',
      promptVersion: request.promptVersion,
      usedFallback: true,
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Anthropic Messages API provider using tool-use for schema-constrained output.
 * Falls back to the deterministic path on any error — an AI outage must never
 * stall the dispatch board.
 */
export class AnthropicLLMProvider implements LLMProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens ?? 2048,
          temperature: request.temperature ?? 0,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          tools: [
            {
              name: 'emit_result',
              description: 'Emit the structured result.',
              input_schema: toJsonSchema(request.schema),
            },
          ],
          tool_choice: { type: 'tool', name: 'emit_result' },
        }),
      });

      if (!response.ok) throw new Error(`Anthropic API ${response.status}`);
      const body = (await response.json()) as {
        content: Array<{ type: string; name?: string; input?: unknown }>;
      };
      const toolUse = body.content.find((block) => block.type === 'tool_use' && block.name === 'emit_result');
      if (!toolUse?.input) throw new Error('No tool_use block in response');

      const parsed = request.schema.safeParse(toolUse.input);
      if (!parsed.success) throw new Error(`Schema mismatch: ${parsed.error.message}`);

      return {
        data: parsed.data,
        modelName: this.model,
        promptVersion: request.promptVersion,
        usedFallback: false,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      console.warn('[llm] falling back to deterministic path:', String(error));
      const data = request.schema.parse(request.fallback());
      return {
        data,
        modelName: `${this.model}+fallback`,
        promptVersion: request.promptVersion,
        usedFallback: true,
        latencyMs: Date.now() - started,
      };
    }
  }
}

/**
 * Minimal Zod -> JSON Schema conversion covering the shapes this codebase
 * uses. Kept local to avoid a dependency for a handful of node kinds.
 */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def;

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = toJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return { type: 'object', properties, required, additionalProperties: false };
  }
  if (schema instanceof z.ZodArray) return { type: 'array', items: toJsonSchema(def.type) };
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: def.values };
  if (schema instanceof z.ZodNativeEnum) return { type: 'string', enum: Object.values(def.values) };
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return toJsonSchema(def.innerType);
  if (schema instanceof z.ZodDefault) return toJsonSchema(def.innerType);
  if (schema instanceof z.ZodUnion) return { anyOf: def.options.map(toJsonSchema) };
  if (schema instanceof z.ZodRecord) return { type: 'object', additionalProperties: true };
  return {};
}

let cached: LLMProvider | null = null;

export function getLLM(): LLMProvider {
  if (cached) return cached;
  const config = env();
  if (config.LLM_PROVIDER === 'anthropic' && config.ANTHROPIC_API_KEY) {
    cached = new AnthropicLLMProvider(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL);
  } else {
    cached = new MockLLMProvider();
  }
  return cached;
}

/** Test seam. */
export function setLLM(provider: LLMProvider | null): void {
  cached = provider;
}
