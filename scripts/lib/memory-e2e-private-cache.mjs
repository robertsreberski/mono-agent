import { createHash } from "node:crypto";
import { meteredEmbeddings } from "./memory-e2e-providers.mjs";
import { PrivateError, privateCode } from "./memory-e2e-private-input.mjs";

/** Run-local only: hashed keys and vectors are never serialized or logged.
 * Cache outside the meter, so only unique misses incur provider reservations.
 * In-flight entries also deduplicate concurrent/batched requests. */
export function privateEmbeddingCache() {
  const entries = new Map();
  const stats = { hits: 0, misses: 0 };
  return {
    stats,
    clear() { entries.clear(); },
    wrap(provider, { budget, model, dimension, tag }) {
      const metered = meteredEmbeddings(provider, { budget, dimension, tag });
      return {
        id: provider.id,
        ...(provider.legacyId === undefined ? {} : { legacyId: provider.legacyId }),
        async embed(texts, options) {
          budget.reserve({});
          if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string") || options?.abortSignal?.aborted) throw new PrivateError("private_embedding_failed");
          const missing = [], waiting = [];
          for (const text of texts) {
            const key = createHash("sha256").update(JSON.stringify([model, dimension, provider.id, text])).digest("hex");
            let pending = entries.get(key);
            if (pending) stats.hits += 1;
            else {
              let resolve, reject;
              pending = new Promise((yes, no) => { resolve = yes; reject = no; });
              entries.set(key, pending); stats.misses += 1;
              missing.push({ key, text, pending, resolve, reject });
            }
            waiting.push(pending);
          }
          const result = Promise.all(waiting).then((vectors) => vectors.map((vector) => [...vector]));
          // Attach before calling a provider: a failed batch rejects all entries.
          result.catch(() => {});
          if (missing.length) {
            try {
              const vectors = await metered.embed(missing.map((entry) => entry.text), options);
              if (!Array.isArray(vectors) || vectors.length !== missing.length
                || vectors.some((vector) => !vector || vector.length !== dimension
                  || Array.from(vector).some((value) => !Number.isFinite(value)))) throw new PrivateError("private_embedding_failed");
              missing.forEach((entry, index) => entry.resolve(Array.from(vectors[index])));
            } catch (error) {
              const failure = error instanceof PrivateError ? error : new PrivateError(privateCode(error) === "private_budget_exhausted" ? "private_budget_exhausted" : "private_embedding_failed");
              for (const entry of missing) {
                if (entries.get(entry.key) === entry.pending) entries.delete(entry.key);
                entry.reject(failure);
              }
            }
          }
          return await result;
        },
      };
    },
  };
}
