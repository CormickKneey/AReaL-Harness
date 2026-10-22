import { useCallback, useLayoutEffect, type ReactNode } from "react";
import { IntlProvider, useIntl } from "react-intl";
import { useApplicationPreferences } from "../settings/applicationPreferences.js";
import { catalogs, type MessageId } from "./messages.js";

export type { AppLocale, MessageId } from "./messages.js";
export type MessageValues = Record<string, string | number | boolean | Date | null | undefined>;
export type Translate = (id: MessageId, values?: MessageValues) => string;
export type UiMessage = { id: MessageId; values?: MessageValues };

export function ApplicationIntlProvider({ children }: { children: ReactNode }) {
  const { locale } = useApplicationPreferences();
  useLayoutEffect(() => { document.documentElement.lang = locale; }, [locale]);
  return <IntlProvider locale={locale} defaultLocale="zh-CN" messages={catalogs[locale]}>
    {children}
  </IntlProvider>;
}

export function useI18n() {
  const intl = useIntl();
  const { locale } = useApplicationPreferences();
  const t: Translate = useCallback((id, values) => intl.formatMessage({ id }, values), [intl]);
  return { intl, locale, t };
}

export const useZCodeIntl = useI18n;

export class UiMessageError extends Error {
  constructor(public readonly descriptor: UiMessage) {
    super(descriptor.id);
    this.name = "UiMessageError";
  }
}

export function formatUiMessage(t: Translate, value: string | UiMessage | null | undefined): string {
  return typeof value === "string" ? value : value ? t(value.id, value.values) : "";
}
