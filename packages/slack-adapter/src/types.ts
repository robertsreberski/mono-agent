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

/** Parameters for an authenticated download of a private Slack file. */
export interface SlackDownloadFileParams {
  /** The file's `url_private` (or `url_private_download`). */
  url: string;
  /**
   * Stop reading once this many bytes have been received and reject. Lets the
   * caller enforce a hard cap without buffering an unbounded response.
   */
  maxBytes?: number;
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
  /**
   * Download a private Slack file's bytes using the bot token. Slack serves
   * `url_private` only with an `Authorization: Bearer <bot token>` header.
   */
  downloadFile(
    params: SlackDownloadFileParams,
    options?: SlackRequestOptions,
  ): Promise<Uint8Array>;
}

/**
 * A Slack file object as delivered on a message/app_mention event's `files`
 * array. Only the fields the adapter needs are typed; the rest pass through.
 */
export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  [key: string]: unknown;
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
  files?: readonly SlackFile[];
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
