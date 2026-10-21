import { appMessages } from "./messages/apps.js";
import { commonMessages } from "./messages/common.js";
import { generalMessages } from "./messages/general.js";
import { pluginMessages } from "./messages/plugins.js";
import { remoteMessages } from "./messages/remote.js";

export type AppLocale = "zh-CN" | "en";
export type MessagePair = Record<AppLocale, string>;
export const messages = {
  ...commonMessages,
  ...appMessages,
  ...generalMessages,
  ...pluginMessages,
  ...remoteMessages,
} as const satisfies Record<string, MessagePair>;
export type MessageId = keyof typeof messages;
export const catalogs = Object.fromEntries(
  (["zh-CN", "en"] as const).map(locale => [
    locale,
    Object.fromEntries(Object.entries(messages).map(([id, pair]) => [id, pair[locale]])),
  ]),
) as Record<AppLocale, Record<MessageId, string>>;
