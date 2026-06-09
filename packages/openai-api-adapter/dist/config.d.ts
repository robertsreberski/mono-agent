import type { FieldGroup, SettingsJson } from "@worklab-ai/settings";
export interface OpenAIApiAdapterConfig {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
    readonly basePath: string;
    readonly allowNonLoopback: boolean;
    readonly apiKey?: string;
    readonly modelId: string;
}
export interface RedactedOpenAIApiAdapterConfig extends Omit<OpenAIApiAdapterConfig, "apiKey"> {
    readonly apiKey: {
        readonly present: boolean;
        readonly redacted: true;
    };
}
export interface LoadOpenAIApiAdapterConfigInput {
    readonly env: Record<string, string | undefined>;
    readonly json?: SettingsJson;
    readonly jsonPath?: string;
}
export declare const openAIApiFieldGroup: FieldGroup;
export declare function loadOpenAIApiAdapterConfig(input: LoadOpenAIApiAdapterConfigInput): Promise<OpenAIApiAdapterConfig>;
export declare function redactOpenAIApiAdapterConfig(config: OpenAIApiAdapterConfig): RedactedOpenAIApiAdapterConfig;
//# sourceMappingURL=config.d.ts.map