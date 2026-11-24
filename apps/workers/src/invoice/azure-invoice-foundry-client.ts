/**
 * Real AI Foundry client for VENDOR INVOICE interpretation (AP) — the invoice counterpart of
 * AzureFoundryClient. Same Azure OpenAI + Entra + JSON-mode plumbing, but with the invoice prompt
 * (invoice-prompt.ts) so the model emits the FoundryInvoiceDraft shape. Behind the same ChatCompleter
 * seam, so it is unit-testable without a live model and composes with FewShotCompleter.
 */
import { AzureOpenAI } from "openai";
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import type { BlobRef, DiLayoutResult, FoundryClient, FoundryResult } from "../pipeline/ports.js";
import { AzureOpenAiCompleter, type ChatCompleter } from "../interpretation/index.js";
import { INVOICE_PROMPT_VERSION, buildInvoiceMessages } from "./invoice-prompt.js";

export interface AzureInvoiceFoundryOptions {
  completer: ChatCompleter;
  deployment: string;
  promptVersion?: string;
}

export class AzureInvoiceFoundryClient implements FoundryClient {
  constructor(private readonly opts: AzureInvoiceFoundryOptions) {}

  async interpret(input: { di: DiLayoutResult; blob: BlobRef }): Promise<FoundryResult> {
    const messages = buildInvoiceMessages(input.di);
    const { content, usage } = await this.opts.completer.complete({ messages, deployment: this.opts.deployment });
    if (usage) {
      console.log(`[foundry:invoice] tokens prompt=${usage.prompt} completion=${usage.completion} deployment=${this.opts.deployment}`);
    }
    return { rawJson: content, deployment: this.opts.deployment, promptVersion: this.opts.promptVersion ?? INVOICE_PROMPT_VERSION };
  }
}

export function createAzureInvoiceFoundryClient(opts: { wrapCompleter?: (c: ChatCompleter) => ChatCompleter } = {}): AzureInvoiceFoundryClient {
  const endpoint = requireEnv("AI_FOUNDRY_ENDPOINT");
  const deployment = process.env.AI_FOUNDRY_INVOICE_DEPLOYMENT ?? requireEnv("AI_FOUNDRY_DEPLOYMENT");
  const apiVersion = process.env.AI_FOUNDRY_API_VERSION ?? "2024-10-21";
  const tokenProvider = getBearerTokenProvider(new DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default");
  const client = new AzureOpenAI({ endpoint, apiVersion, azureADTokenProvider: tokenProvider });
  const base = new AzureOpenAiCompleter(client);
  return new AzureInvoiceFoundryClient({ completer: opts.wrapCompleter ? opts.wrapCompleter(base) : base, deployment });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}
