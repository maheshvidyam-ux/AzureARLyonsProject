/**
 * Real AI Foundry interpretation client (spec §5) implementing the pipeline's `FoundryClient`
 * port. Uses an Azure OpenAI deployment with Entra auth (no keys) and JSON response mode; the
 * schema is pinned in the versioned prompt and enforced downstream by `normalize` (docs/04).
 * Token usage is surfaced for cost tracking (spec §15).
 *
 * The chat call is behind a `ChatCompleter` seam so the client is unit-testable without a live
 * model; the real completer wraps `AzureOpenAI`. Live use needs a provisioned AI Foundry /
 * Azure OpenAI deployment.
 */
import { AzureOpenAI } from "openai";
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import type { BlobRef, DiLayoutResult, FoundryClient, FoundryResult } from "../pipeline/ports.js";
import { PROMPT_VERSION, buildMessages, type ChatMessage } from "./prompt.js";

export interface ChatCompletion {
  content: string;
  usage?: { prompt: number; completion: number };
}
export interface ChatCompleter {
  complete(input: { messages: ChatMessage[]; deployment: string }): Promise<ChatCompletion>;
}

export interface AzureFoundryOptions {
  completer: ChatCompleter;
  deployment: string;
  promptVersion?: string;
}

export class AzureFoundryClient implements FoundryClient {
  constructor(private readonly opts: AzureFoundryOptions) {}

  async interpret(input: { di: DiLayoutResult; blob: BlobRef }): Promise<FoundryResult> {
    const messages = buildMessages(input.di);
    const { content, usage } = await this.opts.completer.complete({ messages, deployment: this.opts.deployment });
    if (usage) {
      // Cost tracking hook — replace console with the metrics sink when wired.
      console.log(`[foundry] tokens prompt=${usage.prompt} completion=${usage.completion} deployment=${this.opts.deployment}`);
    }
    return { rawJson: content, deployment: this.opts.deployment, promptVersion: this.opts.promptVersion ?? PROMPT_VERSION };
  }
}

/** Real completer backed by an Azure OpenAI deployment. */
export class AzureOpenAiCompleter implements ChatCompleter {
  constructor(private readonly client: AzureOpenAI) {}

  async complete(input: { messages: ChatMessage[]; deployment: string }): Promise<ChatCompletion> {
    const res = await this.client.chat.completions.create({
      model: input.deployment,
      messages: input.messages,
      temperature: 0,
      response_format: { type: "json_object" },
    });
    const content = res.choices[0]?.message?.content ?? "";
    const usage = res.usage ? { prompt: res.usage.prompt_tokens, completion: res.usage.completion_tokens } : undefined;
    return { content, usage };
  }
}

export function createAzureFoundryClient(): AzureFoundryClient {
  const endpoint = requireEnv("AI_FOUNDRY_ENDPOINT");
  const deployment = requireEnv("AI_FOUNDRY_DEPLOYMENT");
  const apiVersion = process.env.AI_FOUNDRY_API_VERSION ?? "2024-10-21";
  const tokenProvider = getBearerTokenProvider(new DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default");
  const client = new AzureOpenAI({ endpoint, apiVersion, azureADTokenProvider: tokenProvider });
  return new AzureFoundryClient({ completer: new AzureOpenAiCompleter(client), deployment });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}
