import type { JsonValue } from './json.js';

export type ContextRole = 'system' | 'user' | 'assistant' | 'tool';

export interface MarkdownContextBlock {
  readonly kind: 'markdown';
  readonly content: string;
  readonly source?: string;
}

export interface JsonContextBlock {
  readonly kind: 'json';
  readonly value: JsonValue;
  readonly source?: string;
}

export type ContextBlockInput = string | MarkdownContextBlock | JsonContextBlock;

export interface HistoryMessage {
  readonly role: ContextRole;
  readonly content: string;
  readonly name?: string;
  readonly timestamp?: string;
}

export interface SkillIndexEntry {
  readonly name: string;
  readonly description: string;
  readonly mainFile: string;
}

export interface BuildContextInput {
  readonly identity: ContextBlockInput;
  readonly userMessage: string;
  readonly core?: ContextBlockInput;
  readonly memory?: ContextBlockInput | readonly ContextBlockInput[];
  readonly history?: readonly HistoryMessage[];
  readonly skills?: readonly SkillIndexEntry[];
}

export type ContextSectionId = 'core' | 'identity' | 'memory' | 'history' | 'skills' | 'user-message';

export interface ContextSection {
  readonly id: ContextSectionId;
  readonly title: string;
  readonly content: string;
  readonly source?: string;
}

export interface BuiltAgentContext {
  readonly prompt: string;
  readonly sections: readonly ContextSection[];
  readonly metadata: {
    readonly usedDefaultCore: boolean;
    readonly skillCount: number;
    readonly historyCount: number;
    readonly sources: readonly string[];
  };
}

export interface FileContextInput {
  readonly identityPath: string;
  readonly userMessage: string;
  readonly soulPath?: string;
  readonly memory?: ContextBlockInput | readonly ContextBlockInput[];
  readonly history?: readonly HistoryMessage[];
  readonly skills?: readonly SkillIndexEntry[];
  readonly skillsRoot?: string;
}
