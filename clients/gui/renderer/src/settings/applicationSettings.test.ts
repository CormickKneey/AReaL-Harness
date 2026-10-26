import { expect, test } from "vite-plus/test";
import { normalizeApplicationSettings } from "./applicationSettings.js";

test("new installations keep the current language, typography and interaction defaults", () => {
  const settings = normalizeApplicationSettings(null);
  expect(settings.locale).toBe("zh-CN");
  expect(settings.contentSize).toBe(12);
  expect(settings.sendShortcut).toBe("enter");
  expect(settings.defaultPermissionPreset).toBe("autoReview");
  expect(settings.reducedMotion).toBe("system");
  expect(settings.terminalLocation).toBe("right");
});

test("legacy global fonts migrate into both palettes while explicit mode fonts win", () => {
  const settings = normalizeApplicationSettings({
    uiFont: "Georgia",
    codeFont: "Menlo",
    dark: { fonts: { uiFont: "Arial", contentFont: "PingFang", codeFont: "Courier" } },
  });
  expect(settings.light.fonts).toEqual({
    uiFont: "Georgia",
    contentFont: "inherit",
    codeFont: "Menlo",
  });
  expect(settings.dark.fonts).toEqual({
    uiFont: "Arial",
    contentFont: "PingFang",
    codeFont: "Courier",
  });
});

test("saved custom themes stay independent and malformed preferences return to supported defaults", () => {
  const settings = normalizeApplicationSettings({
    locale: "en",
    contentSize: 24,
    reducedMotion: "on",
    terminalLocation: "bottom",
    light: { background: "#eeddcc", foreground: "#112233", accent: "#345678", contrast: 0 },
    dark: { background: "javascript:alert(1)", contrast: 101, fonts: { uiFont: "unsupported" } },
  });
  expect(settings.light.background).toBe("#eeddcc");
  expect(settings.light.foreground).toBe("#112233");
  expect(settings.light.contrast).toBe(0);
  expect(settings.dark.background).toBe("#181818");
  expect(settings.dark.contrast).toBe(60);
  expect(settings.dark.fonts.uiFont).toBe("system");
  expect(settings.locale).toBe("en");
  expect(settings.contentSize).toBe(24);
  expect(settings.reducedMotion).toBe("on");
  expect(settings.terminalLocation).toBe("bottom");
});
