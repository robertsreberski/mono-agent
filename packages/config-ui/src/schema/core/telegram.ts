import { defineFieldGroup } from "../field-group.js";

export const telegramGroup = defineFieldGroup({
  id: "telegram",
  label: "Telegram",
  description: "Optional Telegram bridge configuration. The token is write-only.",
  fields: [
    {
      id: "telegram.botToken",
      label: "Bot token",
      description:
        "Bot API token. Stored on disk only; never returned to the UI after save.",
      kind: "secret",
      path: ["telegram", "botToken"],
    },
    {
      id: "telegram.allowedChatIds",
      label: "Allowed chat ids",
      description: "Comma-separated list of chat ids the bot will respond to.",
      kind: "csv",
      placeholder: "111111111, 222222222",
      path: ["telegram", "allowedChatIds"],
    },
  ],
});
