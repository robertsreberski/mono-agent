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
  /** Optional Block Kit layout; `text` remains the notification/accessibility fallback. */
  blocks?: readonly unknown[];
  thread_ts?: SlackMessageTs;
  // Slack exposes no bot-controlled notification-suppression parameter here.
  // SlackMessageStreamOptions.silent warns rather than inventing one.
  /** Stable UUID used by Slack to suppress duplicate chat.postMessage retries. */
  client_msg_id?: string;
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
  /** Optional replacement Block Kit layout. Pass `[]` to remove interactive controls. */
  blocks?: readonly unknown[];
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

export interface SlackChatDeleteParams {
  channel: SlackChannelId;
  ts: SlackMessageTs;
}

export interface SlackChatDeleteResult {
  ok: true;
  channel: SlackChannelId;
  ts: SlackMessageTs;
  [key: string]: unknown;
}

export interface SlackFilesGetUploadUrlExternalParams {
  filename: string;
  length: number;
}

export interface SlackFilesGetUploadUrlExternalResult {
  ok: true;
  upload_url: string;
  file_id: string;
  [key: string]: unknown;
}

export interface SlackFilesUploadExternalParams {
  uploadUrl: string;
  data: Uint8Array;
}

export interface SlackFilesCompleteUploadExternalParams {
  files: readonly { readonly id: string; readonly title?: string }[];
  channel_id: SlackChannelId;
  thread_ts?: SlackMessageTs;
}

export interface SlackFilesCompleteUploadExternalResult {
  ok: true;
  files?: readonly unknown[];
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

export interface SlackReactionsAddParams {
  channel: SlackChannelId;
  timestamp: SlackMessageTs;
  /** Emoji short name without colons, e.g. "eyes". */
  name: string;
}

/**
 * Params for `assistant.threads.setStatus` — shows an ephemeral "App is <status>"
 * indicator in a Slack AI-assistant thread while the app works. Requires the app
 * to have the Agents & AI Apps feature + the `assistant:write` scope, and only
 * applies inside an assistant thread (the method errors in regular channels/DMs).
 */
export interface SlackSetAssistantStatusParams {
  channelId: SlackChannelId;
  threadTs: SlackMessageTs;
  /** Verb phrase rendered as "App is <status>", e.g. "is thinking…". "" clears it. */
  status: string;
}

/**
 * Params for `views.publish` — sets a user's App Home tab to the given view.
 * `view` is a Block Kit view object (`{ type: "home", blocks: [...] }`); blocks
 * pass through untyped so the adapter can compose any layout.
 */
export interface SlackViewsPublishParams {
  userId: SlackUserId;
  view: { type: "home"; blocks: readonly unknown[]; [key: string]: unknown };
}

/**
 * Params for `conversations.replies` — the messages of one thread.
 *
 * `latest` + `inclusive` are how a caller anchors the returned page at a known
 * message. Slack's docs do not state which end `limit` truncates, so a caller
 * that needs the NEWEST messages should verify the anchor is present in the page
 * rather than assume.
 */
export interface SlackConversationsRepliesParams {
  channelId: SlackChannelId;
  /** The thread root (`thread_ts`). */
  threadTs: SlackMessageTs;
  latest?: SlackMessageTs;
  oldest?: SlackMessageTs;
  inclusive?: boolean;
  /**
   * Objects per request. Slack caps this at 15 for non-Marketplace apps created
   * after 2025-05-29; internal apps keep the Tier 3 ceiling.
   */
  limit?: number;
}

/** Params for `conversations.history` — recent top-level messages in a channel. */
export interface SlackConversationsHistoryParams {
  channelId: SlackChannelId;
  latest?: SlackMessageTs;
  oldest?: SlackMessageTs;
  inclusive?: boolean;
  /** Objects per request; the same non-Marketplace cap as `conversations.replies`. */
  limit?: number;
}

/**
 * One message as returned by `conversations.history` / `conversations.replies`.
 * Only the fields the adapter reads are typed; the rest pass through.
 */
export interface SlackConversationMessage {
  type?: string;
  subtype?: string;
  ts?: SlackMessageTs;
  thread_ts?: SlackMessageTs;
  user?: SlackUserId;
  /** Present when Slack attributes the message to an app rather than a user. */
  bot_id?: string;
  /** Display name Slack attaches to a `bot_message`. */
  username?: string;
  bot_profile?: { id?: string; name?: string; [key: string]: unknown };
  text?: string;
  files?: readonly SlackFile[];
  [key: string]: unknown;
}

/** Shared result shape of `conversations.history` and `conversations.replies`. */
export interface SlackConversationMessagesResult {
  ok: true;
  messages?: readonly SlackConversationMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Params for `users.info` — resolve one workspace member's profile. */
export interface SlackUsersInfoParams {
  userId: SlackUserId;
}

/**
 * Result of `users.info`. Only the name fields the adapter turns into a
 * model-visible speaker label are typed; everything else passes through.
 *
 * Deliberately NOT used: `id`. A Slack user id doubles as a DM channel id, so it
 * is a delivery target rather than a name and never becomes model-visible.
 */
export interface SlackUsersInfoResult {
  ok: true;
  user?: {
    /** Slack handle without a leading `@`. */
    name?: string;
    real_name?: string;
    is_bot?: boolean;
    profile?: {
      display_name?: string;
      real_name?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Params for `conversations.info` — describe one channel, DM, or group. */
export interface SlackConversationsInfoParams {
  channelId: SlackChannelId;
}

/**
 * Result of `conversations.info`. Only the fields that name and classify the
 * surface are typed; everything else passes through.
 *
 * `name` is the channel name WITHOUT a leading `#`, and is absent for a DM (an
 * `im` has no name, only a counterpart). The `is_*` flags are authoritative
 * where an event's `channel_type` is missing — `app_mention` carries none.
 */
export interface SlackConversationsInfoResult {
  ok: true;
  channel?: {
    name?: string;
    is_im?: boolean;
    is_mpim?: boolean;
    is_private?: boolean;
    is_channel?: boolean;
    is_group?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SlackWebApi {
  authTest(options?: SlackRequestOptions): Promise<SlackAuthTestResult>;
  appsConnectionsOpen(options?: SlackRequestOptions): Promise<SlackAppsConnectionsOpenResult>;
  chatPostMessage(
    params: SlackChatPostMessageParams,
    options?: SlackRequestOptions,
  ): Promise<SlackChatPostMessageResult>;
  /** Begin Slack's modern external upload flow. */
  filesGetUploadURLExternal?(
    params: SlackFilesGetUploadUrlExternalParams,
    options?: SlackRequestOptions,
  ): Promise<SlackFilesGetUploadUrlExternalResult>;
  /** Upload raw bytes to the capability URL returned by getUploadURLExternal. */
  filesUploadExternal?(
    params: SlackFilesUploadExternalParams,
    options?: SlackRequestOptions,
  ): Promise<void>;
  /** Confirm and bind an uploaded file to the exact channel/thread. */
  filesCompleteUploadExternal?(
    params: SlackFilesCompleteUploadExternalParams,
    options?: SlackRequestOptions,
  ): Promise<SlackFilesCompleteUploadExternalResult>;
  /**
   * Optional: add an emoji reaction (e.g. 👀 to signal "seen"). Best-effort; the
   * message stream swallows failures (and "already_reacted" is not an error).
   */
  reactionsAdd?(
    params: SlackReactionsAddParams,
    options?: SlackRequestOptions,
  ): Promise<void>;
  /**
   * Optional: set an assistant-thread status ("App is <status>") via
   * `assistant.threads.setStatus`. Best-effort and assistant-thread-only (needs the
   * `assistant:write` scope + the Agents & AI Apps feature); the message stream
   * falls back to a 👀 reaction when this is absent or errors. Slack auto-clears
   * the status when the app posts its next message to the thread.
   */
  setAssistantStatus?(
    params: SlackSetAssistantStatusParams,
    options?: SlackRequestOptions,
  ): Promise<void>;
  chatUpdate(
    params: SlackChatUpdateParams,
    options?: SlackRequestOptions,
  ): Promise<SlackChatUpdateResult>;
  /** Optional for custom clients; built-in clients use it to clear transient status. */
  chatDelete?(
    params: SlackChatDeleteParams,
    options?: SlackRequestOptions,
  ): Promise<SlackChatDeleteResult>;
  /**
   * Download a private Slack file's bytes using the bot token. Slack serves
   * `url_private` only with an `Authorization: Bearer <bot token>` header.
   * Optional: a text-only custom client may omit it (file events then forward
   * metadata only). The adapter guards before calling it.
   */
  downloadFile?(
    params: SlackDownloadFileParams,
    options?: SlackRequestOptions,
  ): Promise<Uint8Array>;
  /**
   * Optional: publish a user's App Home tab via `views.publish`. Used to render a
   * persistent panel of action buttons. A text-only custom client may omit it
   * (the adapter guards before calling it and logs if home-tab publishing is
   * requested without support).
   */
  viewsPublish?(
    params: SlackViewsPublishParams,
    options?: SlackRequestOptions,
  ): Promise<void>;
  /**
   * Optional: read one thread's messages via `conversations.replies` (needs a
   * `*:history` scope). Used only to assemble best-effort turn context; the
   * adapter guards before calling it and drops the context on any failure, so a
   * text-only custom client may omit it.
   */
  conversationsReplies?(
    params: SlackConversationsRepliesParams,
    options?: SlackRequestOptions,
  ): Promise<SlackConversationMessagesResult>;
  /**
   * Optional: read recent top-level channel messages via `conversations.history`.
   * Same scope requirement and same best-effort guarding as
   * {@link SlackWebApi.conversationsReplies}.
   */
  conversationsHistory?(
    params: SlackConversationsHistoryParams,
    options?: SlackRequestOptions,
  ): Promise<SlackConversationMessagesResult>;
  /**
   * Optional: resolve one member's display name/handle via `users.info` (needs the
   * `users:read` scope). Used only to put a model-visible speaker name on a turn;
   * the adapter guards before calling it and falls back to an unnamed speaker on
   * any failure, so a text-only custom client may omit it.
   */
  usersInfo?(
    params: SlackUsersInfoParams,
    options?: SlackRequestOptions,
  ): Promise<SlackUsersInfoResult>;
  /**
   * Optional: name and classify the surface a turn is on via `conversations.info`
   * (needs `channels:read` for public channels, `groups:read` for private ones,
   * `im:read`/`mpim:read` for DMs and group DMs). Used only to put a model-visible
   * surface name on the turn; the adapter guards before calling it and falls back
   * to the kind alone on any failure, so a text-only custom client may omit it.
   */
  conversationsInfo?(
    params: SlackConversationsInfoParams,
    options?: SlackRequestOptions,
  ): Promise<SlackConversationsInfoResult>;
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

export type SlackEventType = "app_mention" | "message" | "app_home_opened" | string;

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
  /** Which App Home tab was opened (`"home"` / `"messages"`), on `app_home_opened`. */
  tab?: string;
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
  retry_attempt?: number;
  retry_reason?: string;
  [key: string]: unknown;
}

/**
 * A workspace-registered Slack slash command delivered through Socket Mode.
 * Slash commands do not carry thread context, so runtime-control commands use
 * a DM-wide or shared-channel-wide selection scope.
 */
export interface SlackSlashCommandPayload {
  command: string;
  text?: string;
  channel_id: SlackChannelId;
  channel_name?: string;
  user_id?: SlackUserId;
  user_name?: string;
  team_id?: string;
  team_domain?: string;
  api_app_id?: string;
  response_url?: string;
  trigger_id?: string;
  [key: string]: unknown;
}

/**
 * A Slack shortcut interactivity payload, delivered over Socket Mode inside a
 * `type: "interactive"` envelope when a user invokes a registered shortcut. A
 * GLOBAL shortcut (the ⚡ menu) is `type: "shortcut"` and carries no channel; a
 * MESSAGE shortcut is `type: "message_action"` and includes the source
 * `channel`/`message`. The adapter routes on `callback_id`. Only the fields it
 * needs are typed; the rest pass through.
 */
export interface SlackShortcutPayload {
  type: "shortcut" | "message_action";
  callback_id?: string;
  trigger_id?: string;
  user?: { id?: SlackUserId; [key: string]: unknown };
  team?: { id?: string; [key: string]: unknown };
  /** Present for message shortcuts (`message_action`); absent for global shortcuts. */
  channel?: { id?: SlackChannelId; [key: string]: unknown };
  message?: {
    ts?: SlackMessageTs;
    thread_ts?: SlackMessageTs;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * One interactive element activation inside a `block_actions` payload (e.g. a
 * clicked button). Only the fields the adapter routes on are typed.
 */
export interface SlackBlockAction {
  action_id?: string;
  block_id?: string;
  value?: string;
  /** Selected static-select option, present for `static_select` actions. */
  selected_option?: {
    value?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * A Block Kit `block_actions` interactivity payload — delivered when a user
 * clicks a button the app rendered. From the **App Home** tab it carries no
 * `channel` (the adapter routes the reply to a configured channel); from a
 * message it includes the source `channel`/`message`. The adapter routes on each
 * action's `action_id`.
 */
export interface SlackBlockActionsPayload {
  type: "block_actions";
  user?: { id?: SlackUserId; [key: string]: unknown };
  channel?: { id?: SlackChannelId; [key: string]: unknown };
  message?: {
    ts?: SlackMessageTs;
    thread_ts?: SlackMessageTs;
    [key: string]: unknown;
  };
  actions?: readonly SlackBlockAction[];
  trigger_id?: string;
  [key: string]: unknown;
}

/** Any interactivity payload the adapter routes (shortcut, message action, or button click). */
export type SlackInteractivityPayload = SlackShortcutPayload | SlackBlockActionsPayload;
