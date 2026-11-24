/**
 * Few-shot learning for interpretation. Wraps any ChatCompleter and, before each call, prepends a
 * compact block of recent reviewer corrections as guidance — so the model is nudged toward the
 * interpretations humans have already fixed on similar documents. This is the "soft" half of the
 * learning loop (the "hard", deterministic half is the learned-alias overlay in matching).
 *
 * The hints come from a provider (the worker wires it to persistence.listCorrections), so this stays
 * free of any storage dependency and unit-testable with a fake completer.
 */
import type { ChatCompleter, ChatCompletion } from "./azure-foundry-client.js";
import type { ChatMessage } from "./prompt.js";

export interface CorrectionHint {
  field: string;
  from: string | null;
  to: string | null;
  kind: string;
}

export type HintsProvider = () => Promise<CorrectionHint[]>;

export class FewShotCompleter implements ChatCompleter {
  constructor(
    private readonly base: ChatCompleter,
    private readonly hintsProvider: HintsProvider,
    private readonly maxHints = 8,
  ) {}

  async complete(input: { messages: ChatMessage[]; deployment: string }): Promise<ChatCompletion> {
    let hints: CorrectionHint[] = [];
    try {
      hints = (await this.hintsProvider()).slice(0, this.maxHints);
    } catch {
      hints = []; // learning is best-effort; never block interpretation on it
    }
    if (hints.length === 0) return this.base.complete(input);
    const guidance: ChatMessage = { role: "system", content: buildGuidance(hints) };
    return this.base.complete({ ...input, messages: [guidance, ...input.messages] });
  }
}

export function buildGuidance(hints: CorrectionHint[]): string {
  const lines = hints.map((h) => `- [${h.kind}] field ${h.field}: "${h.from ?? "∅"}" → "${h.to ?? "∅"}"`);
  return [
    "LEARNED CORRECTIONS. Human reviewers previously corrected these fields on similar documents.",
    "Prefer the corrected interpretation when the same pattern appears; otherwise ignore.",
    ...lines,
  ].join("\n");
}
