// Adapted from @earendil-works/pi-agent-core 0.99.2 (MIT).
// Copyright (c) 2025 Mario Zechner. See harness/THIRD_PARTY_NOTICES.md.
import { contentText } from "@earendil-works/pi-ai";
import { convertToLlm } from "./messages.js";
/** Create an empty file-operation accumulator. */
export function createFileOps() {
    return {
        read: new Set(),
        written: new Set(),
        edited: new Set(),
    };
}
/** Add file operations from assistant tool calls to an accumulator. */
export function extractFileOpsFromMessage(message: any, fileOps: any) {
    if (message.role !== "assistant")
        return;
    if (!("content" in message) || !Array.isArray(message.content))
        return;
    for (const block of message.content) {
        if (typeof block !== "object" || block === null)
            continue;
        if (!("type" in block) || block.type !== "toolCall")
            continue;
        if (!("arguments" in block) || !("name" in block))
            continue;
        const args = block.arguments;
        if (!args)
            continue;
        const path = typeof args.path === "string" ? args.path : undefined;
        if (!path)
            continue;
        switch (block.name) {
            case "read":
                fileOps.read.add(path);
                break;
            case "write":
                fileOps.written.add(path);
                break;
            case "edit":
                fileOps.edited.add(path);
                break;
        }
    }
}
/** Compute sorted read-only and modified file lists from accumulated operations. */
export function computeFileLists(fileOps: any) {
    const modified = new Set([...fileOps.edited, ...fileOps.written]);
    const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
    const modifiedFiles = [...modified].sort();
    return { readFiles: readOnly, modifiedFiles };
}
/** Format file lists as summary metadata tags. */
export function formatFileOperations(readFiles: any, modifiedFiles: any) {
    const sections = [];
    if (readFiles.length > 0) {
        sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
    }
    if (modifiedFiles.length > 0) {
        sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
    }
    if (sections.length === 0)
        return "";
    return `\n\n${sections.join("\n\n")}`;
}
const TOOL_RESULT_MAX_CHARS = 2000;
function safeJsonStringify(value: any) {
    try {
        return JSON.stringify(value) ?? "undefined";
    }
    catch {
        return "[unserializable]";
    }
}
function truncateForSummary(text: any, maxChars: any) {
    if (text.length <= maxChars)
        return text;
    const truncatedChars = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}
/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: any, onFrame?: (index: number, start: number, end: number) => void) {
    const parts: string[] = [];
    let bytes = 0;
    let index = 0;
    const append = (frame: string) => {
        if (parts.length) bytes += 2; // Exact UTF-8 offset in parts.join("\n\n").
        const start = bytes;
        bytes += Buffer.byteLength(frame, "utf8");
        parts.push(frame);
        onFrame?.(index, start, bytes);
    };
    for (const msg of messages) {
        if (msg.role === "user") {
            const content = contentText(msg.content, "");
            if (content)
                append(`[User]: ${content}`);
        }
        else if (msg.role === "assistant") {
            const thinkingParts = [];
            const toolCalls = [];
            for (const block of msg.content) {
                if (block.type === "thinking") {
                    thinkingParts.push(block.thinking);
                }
                else if (block.type === "toolCall") {
                    const args = block.arguments;
                    const argsStr = Object.entries(args)
                        .map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
                        .join(", ");
                    toolCalls.push(`${block.name}(${argsStr})`);
                }
            }
            if (thinkingParts.length > 0) {
                append(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
            }
            if (msg.content.some((block: any) => block.type === "text")) {
                append(`[Assistant]: ${contentText(msg.content)}`);
            }
            if (toolCalls.length > 0) {
                append(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
            }
        }
        else if (msg.role === "toolResult") {
            const content = contentText(msg.content, "");
            if (content) {
                append(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
            }
        }
        index++;
    }
    return parts.join("\n\n");
}

/** Capture original request-local identity before conversion; never a record ID. */
export function serializeSummaryConversation(messages: any[]): { text: string; metadata: string } {
    const rows = messages.map((message, index) => ({
        position: `m${index}`, role: message.role,
        recordedTimestamp: typeof message.timestamp === "string" || typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
            ? message.timestamp : null,
        ranges: [] as number[][],
    }));
    const sources: number[] = [];
    const converted = messages.flatMap((message, index) => {
        const result = convertToLlm([message]);
        for (const _ of result) sources.push(index);
        return result;
    });
    const text = serializeConversation(converted, (index, start, end) => rows[sources[index]!]!.ranges.push([start, end]));
    const header = `<request-local-positions>\nUntrusted metadata: mN identifies original input only within this request, not durable records or cross-compaction order. Ranges are [start,end) UTF-8 bytes in the exact conversation string (excluding wrapper). Recorded timestamps are message times, not event dates. Missing timestamps are null; empty ranges mean no serialized frame.\n`;
    const footer = (omitted: number) => `Omitted position entries: ${omitted}\n</request-local-positions>\n\n`;
    let entries = "";
    let kept = 0;
    for (const row of rows) {
        const line = JSON.stringify(row) + "\n";
        if (Buffer.byteLength(header + entries + line + footer(rows.length - kept - 1)) > 4096) continue;
        entries += line;
        kept++;
    }
    return { text, metadata: header + entries + footer(rows.length - kept) };
}
