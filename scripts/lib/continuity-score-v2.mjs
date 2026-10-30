// Opt-in deterministic lexical contract. No corpus-specific rules or model judge.
export const V2_FIELDS = ["version", "roles", "questionSubject", "recallValues", "neverEcho", "aliases", "recallMode"];
const ROLES = ["object", "action", "recipient", "deadline", "qualifier", "subject", "prohibition", "scope"];
const re = pattern => new RegExp(pattern, "iu");
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.length > 0 && value.every(s => typeof s === "string" && s.length > 0);
const need = ok => { if (!ok) throw new Error("invalid_probe_score_v2"); };
const fields = (value, allowed) => need(object(value) && Object.keys(value).every(k => allowed.includes(k)));

/** Typography is lexical only. Never collapse punctuation in numeric/alphanumeric tokens. */
export function lexicalView(text) {
  return String(text).normalize("NFC").replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"')
    .replace(/[\u00a0\u202f]/gu, " ").replace(/[‐‑]/gu, "-")
    .replace(/(?<![\p{L}\p{N}_-])\p{L}+(?:-\p{L}+)+(?![\p{L}\p{N}_-])/gu, token => token.replaceAll("-", " "));
}

export function validateV2(score) {
  need(score.version === "v2");
  const compile = patterns => { need(strings(patterns)); patterns.forEach(p => re(p)); };
  if (score.recallMode !== undefined) need(score.kind === "constraint_recall" && ["referent", "restriction"].includes(score.recallMode));
  if (score.roles !== undefined) {
    need(["next_action", "constraint_recall"].includes(score.kind) && Array.isArray(score.roles) && score.roles.length > 0);
    for (const role of score.roles) {
      fields(role, ["role", "patterns", "aliases", "questionSupplied"]);
      need(ROLES.includes(role.role)); compile(role.patterns);
      if (role.aliases !== undefined) compile(role.aliases);
      if (role.questionSupplied !== undefined) need(role.questionSupplied === true && ["action", "recipient"].includes(role.role));
    }
    const names = score.roles.map(r => r.role);
    need(score.kind === "next_action" ? names.includes("object") && names.includes("deadline") : names.includes("subject") && (score.recallMode === "referent" || names.includes("prohibition")));
  }
  if (score.questionSubject !== undefined) {
    fields(score.questionSubject, ["label", "patterns"]);
    need(score.kind === "constraint_recall" && typeof score.questionSubject.label === "string" && score.questionSubject.label.length > 0 && score.roles !== undefined);
    compile(score.questionSubject.patterns);
  }
  if (score.recallValues !== undefined) {
    need(score.kind === "constraint_recall" && score.recallMode === "referent" && score.roles?.some(r => r.role === "subject") && score.neverEcho === undefined);
    compile(score.recallValues);
  }
  if (score.neverEcho !== undefined) { need(score.kind === "constraint_recall"); need(strings(score.neverEcho) && score.neverEcho.every(value => /[A-Za-z0-9]/u.test(value))); }
  if (score.aliases !== undefined) {
    need(["value", "choice"].includes(score.kind)); fields(score.aliases, score.kind === "choice" ? score.options : ["accept", "superseded"]);
    Object.values(score.aliases).forEach(compile);
  }
  return true;
}

// Keep negation local: only explicit rejection immediately preceding a value,
// or a value immediately followed by "is not [current/selected]". No sentiment inference.
function rejected(text, start, end) {
  const before = text.slice(0, start), after = text.slice(end);
  return /\b(?:not|never|rather than|instead of|no longer)(?:\s+(?:a|an|the))?\s*$/iu.test(before)
    || /^\s+(?:is|was)\s+(?:not|no longer)\s+(?:current|selected|valid|used)\b/iu.test(after);
}

function matches(patterns, text, asserted = false) {
  return (patterns ?? []).some(pattern => {
    for (const m of text.matchAll(new RegExp(pattern, "giu"))) {
      if (m[0].length === 0) continue;
      const end = m.index + m[0].length;
      // Prevent regex word boundaries accepting a fragment of a signed number,
      // decimal, date, time or identifier. Authored whole-value patterns still work.
      const left = text.slice(0, m.index), right = text.slice(end);
      if (/[\p{L}\p{N}_]$/u.test(left) && /^[\p{L}\p{N}_]/u.test(m[0]) || /[\p{L}\p{N}_]$/u.test(m[0]) && /^[\p{L}\p{N}_]/u.test(right)) continue;
      if (/\d/u.test(m[0]) && (/[\d+.:/\-]$/u.test(left) || /^(?:[\d:/\-]|\.\d)/u.test(right))) continue;
      if (asserted && rejected(text, m.index, end)) continue;
      return true;
    }
    return false;
  });
}

const PROHIBITION = /\bmust\s+be\s+(?:omitted|excluded|kept\s+out)\b|\b(?:(?:must|should|may|shall)\s+(?:never|not)|never(?:\s+to)?|do not|don't|cannot|can't)\s+(?:ever\s+)?(?:be\s+)?(?:reproduc\w*|repeat\w*|quot\w*|disclos\w*|reveal\w*|mention\w*|appear|includ\w*|publish\w*|shar\w*|omitt?\w*|kept\s+out)\b|\b(?:withhold|omit|exclude|keep)\b[^.!?;\n]{0,70}\b(?:from|out of)\b/iu;
const REVERSED = /\b(?:never|not)\s+(?:be\s+)?(?:omitted|excluded|kept\s+out|withheld)\b|\b(?:not|no longer|never)\s+(?:be\s+)?(?:confidential|private|forbidden|prohibited|required to withhold)\b|\b(?:may|can|should|must)\s+(?:be\s+)?(?:reproduc\w*|repeat\w*|quot\w*|disclos\w*|reveal\w*|shar\w*|publish\w*|includ\w*|mention\w*|copy|copied)\b|\b(?:do not|don't|never)\s+(?:omit|withhold|exclude|keep)\b/iu;

function rolesMatch(score, text) {
  // A recall subject and its rule must be in the same bounded clause. Pronouns
  // are allowed only in direct answers, not after a newly introduced antecedent.
  const clauses = score.kind === "constraint_recall" ? text.split(/(?<!\d)\.(?!\d)|[!?;\n]+|\.(?=\s|$)/u) : [text];
  return clauses.some((clause, index) => {
    if (score.kind === "constraint_recall" && REVERSED.test(text)) return false;
    return score.roles.every(role => {
      if (role.questionSupplied) return true;
      const inflections = { send: "sent|sending", pay: "paid|paying", collect: "collected|collecting", attach: "attached|attaching", notify: "notified|notifying" };
      const patterns = [...role.patterns, ...(role.aliases ?? [])];
      if (role.role === "action") for (const pattern of role.patterns) {
        const verb = pattern.replaceAll("\\b", "");
        if (inflections[verb]) patterns.push(`\\b(?:${verb}|${inflections[verb]})\\b`);
      }
      if (role.role === "subject") {
        if (matches(patterns, clause) || matches(score.recallValues, clause)) return true;
        return score.questionSubject !== undefined && index === 0 && PROHIBITION.test(clause)
          && (/^\s*it\b/iu.test(clause) || /^\s*(?:never|do not|don't|withhold|omit|keep)\b[^.!?;\n]{0,35}\bit\b/iu.test(clause));
      }
      if (role.role === "prohibition") return PROHIBITION.test(clause) && matches(patterns, clause);
      return matches(patterns, clause, role.role !== "scope");
    });
  });
}

/** Called only after explicit v2 opt-in; legacy results come from the caller. */
export function scoreV2(probe, answer, legacy, isAbstention) {
  const score = probe.score;
  validateV2(score);
  const raw = String(answer ?? "").trim();
  const text = score.kind === "identifier" ? raw.normalize("NFC") : lexicalView(raw);
  const compact = value => String(value).normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/gu, "");
  const abstained = isAbstention(text);
  const result = (pass, outcome, extra = {}) => ({ pass, outcome, abstained, falseAbstention: !pass && abstained && score.kind !== "abstain", ...extra });
  if (!text) return result(false, "empty");
  const verdict = (hit, stale) => hit && stale ? result(false, "conflicted") : hit ? result(true, "correct") : stale ? result(false, "stale") : result(false, abstained ? "abstained" : "wrong");
  switch (score.kind) {
    case "identifier": {
      // Exact token, not a compacted substring; separators remain significant.
      const token = value => `(?<![\\p{L}\\p{N}_-])${escape(value.normalize("NFC"))}(?![\\p{L}\\p{N}_-])`;
      return verdict(matches(score.accept.map(token), text, true), matches((score.reject ?? []).map(token), text, true));
    }
    case "value":
      return verdict(matches([...score.accept, ...(score.aliases?.accept ?? [])], text, true), matches([...score.superseded, ...(score.aliases?.superseded ?? [])], text, true));
    case "choice": {
      const alternatives = [...score.options].sort((a, b) => b.length - a.length).map(option => option.split("_").join("[\\s_-]+"));
      const tokens = [...text.matchAll(new RegExp(`\\b(?:${alternatives.join("|")})\\b`, "giu"))]
        .filter(m => !rejected(text, m.index, m.index + m[0].length))
        .map(m => m[0].toUpperCase().replace(/[\s_-]+/gu, "_"));
      const selected = score.options.filter(option => tokens.includes(option) || matches(score.aliases?.[option], text, true));
      return result(selected.length === 1 && selected[0] === score.expected, selected.length > 1 ? "conflicted" : selected[0] === score.expected ? "correct" : abstained ? "abstained" : "wrong", { selected: selected.length === 1 ? selected[0] : null });
    }
    case "next_action":
    case "constraint_recall": {
      if ((score.neverEcho ?? []).some(value => compact(raw).includes(compact(value)))) return result(false, "leaked");
      const hit = score.roles ? rolesMatch(score, text) : !REVERSED.test(text) && (score.requireAll ?? score.proxyAll).every(group => matches(group, text, score.kind === "next_action"));
      return result(hit, hit ? "correct" : abstained ? "abstained" : "wrong");
    }
    // Never excuse a protected token because it occurs in a refusal or negation.
    case "redaction": return legacy(probe, answer);
    case "constraint_task": {
      const original = legacy(probe, answer);
      return original.pass ? legacy(probe, text) : original;
    }
    default: return legacy(probe, text);
  }
}
