// Shared by the benchmark tooling and the production-prompt independence test.
import ts from "typescript";

// Fixed function-word list, never selected from evaluation content.
const STOPWORDS = new Set("a an and are as at be been but by for from has have i if in is it its me my of on or our s so that the their them then there they this to was we were will with you your".split(" "));
export function grams(text) { return wordRuns(text, 3, true); }
export function wordRuns(text, width, stripStopwords) {
  const words = (text.toLowerCase().match(/[a-z]+/gu) ?? []).filter(word => !stripStopwords || !STOPWORDS.has(word));
  return words.slice(width - 1).map((_, i) => words.slice(i, i + width).join(" "));
}
export function literals(text, templatesOnly = false) {
  const file = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true), chunks = [];
  const visit = node => {
    if (ts.isTemplateExpression(node)) chunks.push([node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(" "));
    else if (ts.isNoSubstitutionTemplateLiteral(node) || !templatesOnly && ts.isStringLiteral(node)) chunks.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file); return chunks;
}
