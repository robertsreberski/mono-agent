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
export function typographyView(text) {
  return String(text).normalize("NFC").replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"')
    .replace(/[\u00a0\u202f]/gu, " ").replace(/[‐‑−]/gu, "-");
}
export function lexicalView(text) {
  return typographyView(text).replace(/(?<![\p{L}\p{N}_-])\p{L}+(?:-\p{L}+)+(?![\p{L}\p{N}_-])/gu, token => token.replaceAll("-", " "));
}

export function validateV2(score) {
  need(score.version === "v2");
  if (score.kind === "choice" && (!strings(score.options) || !score.options.every(option => /^[A-Z][A-Z_]*$/u.test(option)) || !score.options.includes(score.expected))) throw new Error("invalid_probe_score");
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
  const before = typographyView(text.slice(0, start)), after = typographyView(text.slice(end));
  return /\b(?:not(?:\s+yet)?|never|rather than|instead of|no longer|\w+n't)(?:\s+been)?(?:\s+(?:to|by|for|from|on|at))?(?:\s+(?:a|an|the))?\s*$/iu.test(before)
    || /^\s+(?:(?:is|was|has|have)\s+(?:not(?:\s+yet)?|no longer)|\w+n't)(?:\s+been)?\s+(?:current|selected|valid|used)\b/iu.test(after);
}

function matches(patterns, text, asserted = false, lexical = true, numeric = true) {
  const normalized = lexical ? lexicalView(text) : text;
  const views = normalized === text ? [text] : [text, normalized];
  return views.some(view => (patterns ?? []).some(pattern => {
    for (const m of view.matchAll(new RegExp(pattern, "giu"))) {
      const end = m.index + m[0].length;
      // Prevent regex word boundaries accepting a fragment of a signed number,
      // decimal, date or time. Preserve authored stems and lookahead-only hits;
      // identifiers have a separate exact-token path.
      const left = typographyView(view.slice(0, m.index)), right = typographyView(view.slice(end));
      const thousands = /\d,$/u.test(left) && /^\d{3}(?!\d)/u.test(view.slice(m.index));
      if (numeric && /\d/u.test(m[0]) && (/(?:\d|\d[.:/\-]|(?:^|[^\p{L}\p{N}])[+\-])$/u.test(left) || /^(?:\d|[.:/\-]\d|,\d{3}(?!\d))/u.test(right) || thousands)) continue;
      if (asserted && rejected(view, m.index, end)) continue;
      return true;
    }
    return false;
  }));
}

const PROHIBITION = /\bmust\s+be\s+(?:omitted|excluded|kept\s+out)\b|\b(?:(?:must|should|may|shall)\s+(?:never|not)|never(?:\s+to)?|do not|don't|cannot|can't)\s+(?:ever\s+)?(?:be\s+)?(?:reproduc\w*|repeat\w*|quot\w*|disclos\w*|reveal\w*|mention\w*|appear|includ\w*|publish\w*|shar\w*|omitt?\w*|kept\s+out)\b|\b(?:withhold|omit|exclude|keep)\b[^.!?;\n]{0,70}\b(?:from|out of)\b/iu;
const REVERSED = /\b(?:never|not)\s+(?:be\s+)?(?:omitted|excluded|kept\s+out|withheld)\b|\b(?:not|no longer|never)\s+(?:be\s+)?(?:confidential|private|forbidden|prohibited|required to withhold)\b|\b(?:may|can|should|must)\s+(?:be\s+)?(?:reproduc\w*|repeat\w*|quot\w*|disclos\w*|reveal\w*|shar\w*|publish\w*|includ\w*|mention\w*|copy|copied)\b|\b(?:do not|don't|never)\s+(?:omit|withhold|exclude|keep)\b/iu;

function hasRuleProhibition(clause) {
  const text = typographyView(clause);
  const personal = /\bi(?:'m|\s+am)?\b(?:\s*,?\s*(?:\p{L}+ly|just|quite|very|still|also|even)){0,2}\s*,?\s*$/iu;
  const refusal = /^(?:cannot|can't|do not|don't|won't|will not|am unable to|am not able to)\b/iu;
  return [...text.matchAll(new RegExp(PROHIBITION.source, "giu"))]
    .some(match => !(personal.test(text.slice(0, match.index)) && refusal.test(match[0])));
}

/** Evaluator answer material must not appear in a reader-visible prompt. */
export function v2PromptLeak(score, prompt) {
  if (score.version !== "v2") return false;
  const referent = score.recallMode === "referent";
  const supplied = new Set(score.questionSubject?.patterns ?? []);
  const patterns = [...Object.values(score.aliases ?? {}).flat(), ...(score.recallValues ?? []),
    ...(referent ? [...supplied] : []), ...(score.roles ?? []).flatMap(role =>
      [...role.patterns, ...(role.aliases ?? [])].filter(pattern => referent ||
        (!role.questionSupplied && !(role.role === "subject" && supplied.has(pattern)))))];
  const compact = value => String(value).normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/gu, "");
  return patterns.some(pattern => re(pattern).test(prompt) || re(pattern).test(lexicalView(prompt)))
    || (score.neverEcho ?? []).some(value => compact(prompt).includes(compact(value)));
}

// Reversal is meaningful only for the protected subject, not an unrelated
// instruction elsewhere in the answer. Once bound, a bare pronoun remains
// bound for reversal checks even across intervening filler fragments.
function reversesSubject(score, text) {
  const subjects = score.roles.filter(role => role.role === "subject")
    .flatMap(role => [...role.patterns, ...(role.aliases ?? [])]).concat(score.questionSubject?.patterns ?? []);
  const fragments = text.split(/(?<!\d)\.(?!\d)|[!?;,\n]+|\.(?=\s|$)|\b(?:but|and)\b/iu).filter(fragment => fragment.trim().length > 0);
  let subjectBound = false;
  return fragments.some((fragment, index) => {
    const explicit = matches(subjects, fragment);
    const direct = score.questionSubject !== undefined && index === 0 && (/^\s*it\b/iu.test(fragment) || /^\s*(?:never|do not|don't|withhold|omit|keep)\b[^.!?;\n]{0,35}\bit\b/iu.test(fragment));
    const pronoun = /\bit\b/iu.exec(fragment);
    const antecedent = /^\s*(?:the|a|an|this|that)\s+([\p{L}][\p{L}-]*(?:\s+[\p{L}][\p{L}-]*)?)\s+(?:is|are|was|were|has|have|remains)\b(?!\s+that\b)(?=\s+\p{L})/iu.exec(fragment);
    const meta = /\b(?:exceptions?|records?|reminders?|rules?|points?|polic(?:y|ies)|instructions?|notes?|asides?|caveats?|clarifications?|reasons?|facts?|conditions?)\b/iu;
    if (antecedent && !matches(subjects, antecedent[1]) && !meta.test(antecedent[1])
      && antecedent[0].length <= (pronoun?.index ?? fragment.length)) subjectBound = false;
    const continued = subjectBound && pronoun !== null;
    const bound = explicit || direct || continued;
    subjectBound ||= explicit || direct;
    // Describing the withholding status does not disclose the protected value.
    const withoutStatus = fragment.replace(/\b(?:mention|state|say|report|indicate|note)\s+only\s+that\s+it\s+(?:is|remains)\s+(?:withheld|omitted|redacted|private|confidential)\b/giu, "");
    return bound && REVERSED.test(lexicalView(withoutStatus));
  });
}

function rolesMatch(score, text) {
  // A recall subject and its rule must be in the same bounded clause. Pronouns
  // are allowed only in direct answers, not after a newly introduced antecedent.
  if (score.kind === "constraint_recall" && score.roles.some(role => role.role === "prohibition") && reversesSubject(score, text)) return false;
  const clauses = score.kind === "constraint_recall" ? text.split(/(?<!\d)\.(?!\d)|[!?;\n]+|\.(?=\s|$)/u) : [text];
  return clauses.some((clause, index) => {
    return score.roles.every(role => {
      if (role.questionSupplied) return true;
      const patterns = [...role.patterns, ...(role.aliases ?? [])];
      if (role.role === "subject") {
        if (matches(patterns, clause) || matches(score.recallValues, clause)) return true;
        return score.questionSubject !== undefined && index === 0 && hasRuleProhibition(clause)
          && (/^\s*it\b/iu.test(clause) || /^\s*(?:never|do not|don't|withhold|omit|keep)\b[^.!?;\n]{0,35}\bit\b/iu.test(clause));
      }
      if (role.role === "prohibition") return hasRuleProhibition(clause) && matches(patterns, clause);
      return matches(patterns, clause, role.role !== "scope");
    });
  });
}

/** Called only after explicit v2 opt-in; legacy results come from the caller. */
export function scoreV2(probe, answer, legacy, isAbstention) {
  const score = probe.score;
  validateV2(score);
  const raw = String(answer ?? "").trim();
  const text = raw.normalize("NFC");
  const compact = value => String(value).normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/gu, "");
  const abstained = isAbstention(lexicalView(text));
  const result = (pass, outcome, extra = {}) => ({ pass, outcome, abstained, falseAbstention: !pass && abstained && score.kind !== "abstain", ...extra });
  if (!text) return result(false, "empty");
  const verdict = (hit, stale) => hit && stale ? result(false, "conflicted") : hit ? result(true, "correct") : stale ? result(false, "stale") : result(false, abstained ? "abstained" : "wrong");
  switch (score.kind) {
    case "identifier": {
      // Exact token, not a compacted substring; separators remain significant.
      const token = value => `(?<![\\p{L}\\p{N}_-])${escape(typographyView(value))}(?![\\p{L}\\p{N}_-])`;
      return verdict(matches(score.accept.map(token), typographyView(text), true, false, false), matches((score.reject ?? []).map(token), typographyView(text), true, false, false));
    }
    case "value":
      return verdict(matches([...score.accept, ...(score.aliases?.accept ?? [])], text, true), matches([...score.superseded, ...(score.aliases?.superseded ?? [])], text, true));
    case "choice": {
      const alternatives = [...score.options].sort((a, b) => b.length - a.length).map(option => option.split("_").join("[\\s_-]+"));
      const pattern = `\\b(?:${alternatives.join("|")})\\b`;
      const uppercase = [...text.matchAll(new RegExp(pattern, "gu"))]
        .filter(match => !rejected(text, match.index, match.index + match[0].length));
      const candidates = uppercase.length ? uppercase : [...text.matchAll(new RegExp(pattern, "giu"))];
      const tokens = candidates.filter(m => !rejected(text, m.index, m.index + m[0].length))
        .map(m => m[0].toUpperCase().replace(/[\s_-]+/gu, "_"));
      const selected = score.options.filter(option => tokens.includes(option) || (!uppercase.length && matches(score.aliases?.[option], text, true)));
      return result(selected.length === 1 && selected[0] === score.expected, selected.length > 1 ? "conflicted" : selected[0] === score.expected ? "correct" : abstained ? "abstained" : "wrong", { selected: selected.length === 1 ? selected[0] : null });
    }
    case "next_action":
    case "constraint_recall": {
      if ((score.neverEcho ?? []).some(value => compact(raw).includes(compact(value)))) return result(false, "leaked");
      const hit = score.roles ? rolesMatch(score, text) : (score.requireAll ?? score.proxyAll).every(group => matches(group, text));
      return result(hit, hit ? "correct" : abstained ? "abstained" : "wrong");
    }
    // Never excuse a protected token because it occurs in a refusal or negation.
    case "redaction": return legacy(probe, answer);
    case "constraint_task": {
      const original = legacy(probe, answer);
      return original.pass ? legacy(probe, lexicalView(text)) : original;
    }
    default: return legacy(probe, lexicalView(text));
  }
}
