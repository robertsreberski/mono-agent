/*
 * Experimental local scorer matching snap-research/locomo's pinned
 * task_eval/evaluation.py. The Porter implementation follows NLTK 3.8.1's
 * default NLTK_EXTENSIONS behavior without adding a runtime dependency.
 */

const VOWELS = new Set(["a", "e", "i", "o", "u"]);
const IRREGULAR = new Map(Object.entries({
  sky: "sky", skies: "sky", dying: "die", lying: "lie", tying: "tie", news: "news",
  innings: "inning", inning: "inning", outings: "outing", outing: "outing",
  cannings: "canning", canning: "canning", howe: "howe", proceed: "proceed",
  exceed: "exceed", succeed: "succeed",
}));
const ASCII_PUNCTUATION = new Set(Array.from("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"));

const codePoints = (word) => Array.from(word);
function isConsonant(word, index) {
  const characters = codePoints(word);
  if (VOWELS.has(characters[index])) return false;
  if (characters[index] !== "y") return true;
  return index === 0 || !isConsonant(word, index - 1);
}
function measure(word) {
  let count = 0;
  for (let index = 1; index < codePoints(word).length; index += 1) {
    if (!isConsonant(word, index - 1) && isConsonant(word, index)) count += 1;
  }
  return count;
}
function containsVowel(word) {
  return codePoints(word).some((_character, index) => !isConsonant(word, index));
}
function endsDoubleConsonant(word) {
  const characters = codePoints(word);
  return characters.length >= 2 && characters.at(-1) === characters.at(-2)
    && isConsonant(word, characters.length - 1);
}
function endsCvc(word) {
  const characters = codePoints(word);
  return (characters.length >= 3
    && isConsonant(word, characters.length - 3)
    && !isConsonant(word, characters.length - 2)
    && isConsonant(word, characters.length - 1)
    && !["w", "x", "y"].includes(characters.at(-1)))
    || (characters.length === 2 && !isConsonant(word, 0) && isConsonant(word, 1));
}
function replaceSuffix(word, suffix, replacement) {
  return suffix.length === 0 ? word + replacement : word.slice(0, -suffix.length) + replacement;
}
function applyRules(word, rules) {
  for (const [suffix, replacement, condition] of rules) {
    if (suffix === "*d" && endsDoubleConsonant(word)) {
      const stem = word.slice(0, -2);
      return condition === null || condition(stem) ? stem + replacement : word;
    }
    if (word.endsWith(suffix)) {
      const stem = replaceSuffix(word, suffix, "");
      return condition === null || condition(stem) ? stem + replacement : word;
    }
  }
  return word;
}
const positiveMeasure = (word) => measure(word) > 0;

function step1a(word) {
  if (word.endsWith("ies") && codePoints(word).length === 4) return replaceSuffix(word, "ies", "ie");
  return applyRules(word, [["sses", "ss", null], ["ies", "i", null], ["ss", "ss", null], ["s", "", null]]);
}
function step1b(word) {
  if (word.endsWith("ied")) return replaceSuffix(word, "ied", codePoints(word).length === 4 ? "ie" : "i");
  if (word.endsWith("eed")) {
    const stem = replaceSuffix(word, "eed", "");
    return measure(stem) > 0 ? stem + "ee" : word;
  }
  let stem;
  for (const suffix of ["ed", "ing"]) {
    if (word.endsWith(suffix) && containsVowel(replaceSuffix(word, suffix, ""))) {
      stem = replaceSuffix(word, suffix, "");
      break;
    }
  }
  if (stem === undefined) return word;
  return applyRules(stem, [
    ["at", "ate", null], ["bl", "ble", null], ["iz", "ize", null],
    ["*d", stem.at(-1), () => !["l", "s", "z"].includes(stem.at(-1))],
    ["", "e", (value) => measure(value) === 1 && endsCvc(value)],
  ]);
}
function step1c(word) {
  return applyRules(word, [["y", "i", (stem) => codePoints(stem).length > 1
    && isConsonant(stem, codePoints(stem).length - 1)]]);
}
function step2(word) {
  if (word.endsWith("alli") && positiveMeasure(replaceSuffix(word, "alli", ""))) {
    return step2(replaceSuffix(word, "alli", "al"));
  }
  return applyRules(word, [
    ["ational", "ate", positiveMeasure], ["tional", "tion", positiveMeasure],
    ["enci", "ence", positiveMeasure], ["anci", "ance", positiveMeasure],
    ["izer", "ize", positiveMeasure], ["bli", "ble", positiveMeasure],
    ["alli", "al", positiveMeasure], ["entli", "ent", positiveMeasure],
    ["eli", "e", positiveMeasure], ["ousli", "ous", positiveMeasure],
    ["ization", "ize", positiveMeasure], ["ation", "ate", positiveMeasure],
    ["ator", "ate", positiveMeasure], ["alism", "al", positiveMeasure],
    ["iveness", "ive", positiveMeasure], ["fulness", "ful", positiveMeasure],
    ["ousness", "ous", positiveMeasure], ["aliti", "al", positiveMeasure],
    ["iviti", "ive", positiveMeasure], ["biliti", "ble", positiveMeasure],
    ["fulli", "ful", positiveMeasure],
    ["logi", "log", () => positiveMeasure(word.slice(0, -3))],
  ]);
}
function step3(word) {
  return applyRules(word, [
    ["icate", "ic", positiveMeasure], ["ative", "", positiveMeasure],
    ["alize", "al", positiveMeasure], ["iciti", "ic", positiveMeasure],
    ["ical", "ic", positiveMeasure], ["ful", "", positiveMeasure],
    ["ness", "", positiveMeasure],
  ]);
}
function step4(word) {
  const gt1 = (stem) => measure(stem) > 1;
  return applyRules(word, [
    ["al", "", gt1], ["ance", "", gt1], ["ence", "", gt1], ["er", "", gt1],
    ["ic", "", gt1], ["able", "", gt1], ["ible", "", gt1], ["ant", "", gt1],
    ["ement", "", gt1], ["ment", "", gt1], ["ent", "", gt1],
    ["ion", "", (stem) => measure(stem) > 1 && ["s", "t"].includes(stem.at(-1))],
    ["ou", "", gt1], ["ism", "", gt1], ["ate", "", gt1], ["iti", "", gt1],
    ["ous", "", gt1], ["ive", "", gt1], ["ize", "", gt1],
  ]);
}
function step5a(word) {
  if (!word.endsWith("e")) return word;
  const stem = replaceSuffix(word, "e", "");
  return measure(stem) > 1 || (measure(stem) === 1 && !endsCvc(stem)) ? stem : word;
}
function step5b(word) {
  return applyRules(word, [["ll", "l", () => measure(word.slice(0, -1)) > 1]]);
}

export function nltkPorterStem(word) {
  let stem = word.toLowerCase();
  if (IRREGULAR.has(stem)) return IRREGULAR.get(stem);
  if (codePoints(stem).length <= 2) return stem;
  stem = step1a(stem);
  stem = step1b(stem);
  stem = step1c(stem);
  stem = step2(stem);
  stem = step3(stem);
  stem = step4(stem);
  stem = step5a(stem);
  return step5b(stem);
}

export function normalizeOfficialLocomoAnswer(value) {
  const lower = value.replaceAll(",", "").toLowerCase();
  const withoutPunctuation = Array.from(lower).filter((character) => !ASCII_PUNCTUATION.has(character)).join("");
  return withoutPunctuation.replace(/\b(?:a|an|the|and)\b/gu, " ").replace(/\s+/gu, " ").trim();
}

function tokenF1(prediction, reference) {
  const predicted = normalizeOfficialLocomoAnswer(prediction).split(" ").filter(Boolean).map(nltkPorterStem);
  const expected = normalizeOfficialLocomoAnswer(reference).split(" ").filter(Boolean).map(nltkPorterStem);
  const counts = new Map();
  for (const token of expected) counts.set(token, (counts.get(token) ?? 0) + 1);
  let overlap = 0;
  for (const token of predicted) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) { overlap += 1; counts.set(token, remaining - 1); }
  }
  if (overlap === 0) return 0;
  const precision = overlap / predicted.length;
  const recall = overlap / expected.length;
  return (2 * precision * recall) / (precision + recall);
}

function multiAnswerF1(prediction, reference) {
  const predictions = prediction.split(",").map((value) => value.trim());
  const references = reference.split(",").map((value) => value.trim());
  return references.reduce((sum, expected) => sum + Math.max(...predictions.map((value) => tokenF1(value, expected))), 0)
    / references.length;
}

/** Exact local port of the pinned evaluator's per-question QA score. */
export function officialLocomoScore(prediction, reference, category) {
  if (typeof prediction !== "string" || !Number.isSafeInteger(category) || category < 1 || category > 5) {
    throw new Error("locomo_official_score_invalid_input");
  }
  if (category === 5) {
    const output = prediction.toLowerCase();
    return output.includes("no information available") || output.includes("not mentioned") ? 1 : 0;
  }
  if (typeof reference !== "string" || reference.trim().length === 0) throw new Error("locomo_official_score_missing_reference");
  if (category === 1) return multiAnswerF1(prediction, reference);
  const expected = category === 3 ? reference.split(";")[0].trim() : reference;
  return tokenF1(prediction, expected);
}
