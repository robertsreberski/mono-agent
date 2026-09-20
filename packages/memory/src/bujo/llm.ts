/** JSON Schema metadata understood by hosts that support schema-guided output. */
type LlmOutputSchema = Readonly<Record<string, unknown>>;

/** Per-call hints for a completion. `label` tags the ritual (e.g. "capture:extract") so a recording host can group/name the run. */
export interface LlmCompleteOptions {
  readonly label?: string;
  readonly abortSignal?: AbortSignal;
  /**
   * Optional schema guidance. A capable host returns its structured result as
   * JSON text; text-only implementations may ignore this hint and keep their
   * existing completion path. The caller's parser remains authoritative.
   */
  readonly outputSchema?: LlmOutputSchema;
  /**
   * When a schema needs an object root for a host tool but the established text
   * contract has another root type, serialize this property as the completion.
   * Text-only implementations ignore it together with `outputSchema`.
   */
  readonly structuredResultKey?: string;
}

/** Minimal injected LLM completion surface. Implementations adapt the host runtime (P4); tests use a fake. */
export interface LlmComplete {
  readonly id: string;
  /**
   * Returns the model's text completion for the prompt. The optional `opts.label`
   * is an advisory ritual tag; implementations that don't record may ignore it.
   */
  complete(prompt: string, opts?: LlmCompleteOptions): Promise<string>;
}
