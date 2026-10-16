/**
 * Vendor or legacy aliases for {@link DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST}.
 * Browsers and OS pickers report non-canonical types for the same container
 * (Safari reports a Voice Memo `.m4a` file as `audio/x-m4a`), so alias keys
 * map to the canonical allowlisted type transports already accept.
 */
export const AGENT_ATTACHMENT_MIME_ALIASES: Readonly<Record<string, string>> = {
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-mp4": "audio/mp4",
  "audio/mp3": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mpeg-3": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-pn-wav": "audio/wav",
  "audio/x-aac": "audio/aac",
  "audio/x-flac": "audio/flac",
  "audio/x-ogg": "audio/ogg",
  "audio/vorbis": "audio/ogg",
};
