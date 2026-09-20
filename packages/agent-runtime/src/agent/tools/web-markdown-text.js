// @ts-check
// Shared visible-text projection; fenced code is content, destinations are not.
export function markdownToText(value) {
  const source = String(value || "").replace(/\r\n?/gu, "\n");
  const { text, codeBlocks } = protectFencedCode(source);
  let output = collapseDocumentText(text
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^ {0,3}(?:[*_-][ \t]*){3,}$/gmu, "")
    .replace(/^ {0,3}#{1,6}[ \t]+/gmu, "")
    .replace(/^ {0,3}>[ \t]+/gmu, "")
    .replace(/^ {0,3}[*+-][ \t]+/gmu, "")
    .replace(/~~(?=\S)([^~\n]*?\S)~~/gu, "$1")
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/gu, "$1")
    .replace(/__(?=\S)([^_\n]*?\S)__/gu, "$1")
    .replace(/(?<!\*)\*(?=\S)([^*\n]*?\S)\*(?!\*)/gu, "$1")
    .replace(/(?<![\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, "$1")
    .replace(/`([^`\n]+)`/gu, "$1"));
  for (const block of codeBlocks) output = output.replace(block.token, block.body);
  return output;
}

function protectFencedCode(value) {
  const lines = value.split("\n");
  const output = [];
  const codeBlocks = [];
  let fence;
  let code = [];
  for (const line of lines) {
    if (fence !== undefined) {
      const containerContent = stripFenceContainer(line, fence, fence.containerIndent);
      const closing = containerContent.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1];
      if (closing !== undefined && closing[0] === fence.marker[0] && closing.length >= fence.marker.length) {
        const token = uniqueCodeToken(value, codeBlocks.length);
        codeBlocks.push({ token, body: code.join("\n") });
        output.push(token);
        fence = undefined;
        code = [];
      } else {
        code.push(stripFenceContainer(line, fence, fence.contentIndent));
      }
      continue;
    }
    const opening = readFenceOpening(line);
    if (opening !== undefined) {
      fence = opening;
      continue;
    }
    output.push(line);
  }
  if (fence !== undefined) {
    const token = uniqueCodeToken(value, codeBlocks.length);
    codeBlocks.push({ token, body: code.join("\n") });
    output.push(token);
  }
  return { text: output.join("\n"), codeBlocks };
}

function readFenceOpening(line) {
  let candidate = line;
  let quoteDepth = 0;
  for (;;) {
    const quote = candidate.match(/^ {0,3}>[ \t]?/u)?.[0];
    if (quote === undefined) break;
    quoteDepth += 1;
    candidate = candidate.slice(quote.length);
  }
  const list = candidate.match(/^ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]+/u)?.[0];
  const listIndent = list?.length ?? 0;
  if (list !== undefined) candidate = candidate.slice(list.length);
  const indentation = candidate.match(/^ {0,3}/u)?.[0].length ?? 0;
  candidate = candidate.slice(indentation);
  const match = candidate.match(/^(`{3,}|~{3,})([^\n]*)$/u);
  if (match === null || (match[1][0] === "`" && match[2].includes("`"))) return undefined;
  return {
    marker: match[1],
    quoteDepth,
    containerIndent: listIndent,
    contentIndent: listIndent + indentation,
  };
}

function stripFenceContainer(line, fence, indentation) {
  let candidate = line;
  for (let depth = 0; depth < fence.quoteDepth; depth += 1) {
    const quote = candidate.match(/^ {0,3}>[ \t]?/u)?.[0];
    if (quote === undefined) return line;
    candidate = candidate.slice(quote.length);
  }
  let remainingIndent = indentation;
  while (remainingIndent > 0 && candidate.startsWith(" ")) {
    candidate = candidate.slice(1);
    remainingIndent -= 1;
  }
  return candidate;
}

function uniqueCodeToken(source, index) {
  let token = `\u0000MONOAGENTFENCE${index}\u0000`;
  while (source.includes(token)) token = `\u0000${token}\u0000`;
  return token;
}

export function collapseDocumentText(value) {
  return String(value || "").replace(/\r/gu, "").replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").replace(/[ \t]{2,}/gu, " ").trim();
}
