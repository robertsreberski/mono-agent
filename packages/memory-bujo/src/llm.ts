/** Minimal injected LLM completion surface. Implementations adapt the host runtime (P4); tests use a fake. */
export interface LlmComplete {
  readonly id: string;
  /** Returns the model's text completion for the prompt. */
  complete(prompt: string): Promise<string>;
}
