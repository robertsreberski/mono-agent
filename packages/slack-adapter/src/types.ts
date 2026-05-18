export type SlackChannelId = string;
export type SlackUserId = string;
export type SlackMessageTs = string;

export interface SlackRequestOptions {
  signal?: AbortSignal;
}

export interface SlackAuthTestResult {
  ok: true;
  url?: string;
  team?: string;
  user?: string;
  team_id?: string;
  user_id?: string;
  bot_id?: string;
  [key: string]: unknown;
}

export interface SlackAppsConnectionsOpenResult {
  ok: true;
  url: string;
}

export interface SlackChatPostMessageParams {
  channel: SlackChannelId;
  text: string;
  thread_ts?: SlackMessageTs;
  mrkdwn?: boolean;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

export interface SlackChatPostMessageResult {
  ok: true;
  channel: SlackChannelId;
  ts: SlackMessageTs;
  message?: unknown;
  [key: string]: unknown;
}

export interface SlackChatUpdateParams {
  channel: SlackChannelId;
  ts: SlackMessageTs;
  text: string;
  mrkdwn?: boolean;
}

export interface SlackChatUpdateResult {
  ok: true;
  channel: SlackChannelId;
  ts: SlackMessageTs;
  text?: string;
  message?: unknown;
  [key: string]: unknown;
}

export interface SlackWebApi {
  authTest(options?: SlackRequestOptions): Promise<SlackAuthTestResult>;
  appsConnectionsOpen(options?: SlackRequestOptions): Promise<SlackAppsConnectionsOpenResult>;
  chatPostMessage(
    params: SlackChatPostMessageParams,
    options?: SlackRequestOptions,
  ): Promise<SlackChatPostMessageResult>;
  chatUpdate(
    params: SlackChatUpdateParams,
    options?: SlackRequestOptions,
  ): Promise<SlackChatUpdateResult>;
}

export type SlackEventType = "app_mention" | "message" | string;

export interface SlackEventBase {
  type?: SlackEventType;
  subtype?: string;
  channel?: SlackChannelId;
  user?: SlackUserId;
  text?: string;
  ts?: SlackMessageTs;
  thread_ts?: SlackMessageTs;
  event_ts?: SlackMessageTs;
  channel_type?: string;
  bot_id?: string;
  [key: string]: unknown;
}

export interface SlackEventCallback {
  type: "event_callback";
  token?: string;
  team_id?: string;
  api_app_id?: string;
  event_id: string;
  event_time?: number;
  event: SlackEventBase;
  authorizations?: readonly unknown[];
  [key: string]: unknown;
}

export interface SlackSocketModeEnvelope {
  envelope_id?: string;
  type?: string;
  accepts_response_payload?: boolean;
  payload?: unknown;
  reason?: string;
  [key: string]: unknown;
}
