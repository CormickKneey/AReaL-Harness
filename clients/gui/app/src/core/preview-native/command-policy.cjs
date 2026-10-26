// @ts-check
"use strict";

/** @param {import("@areal/browser-automation").BrowserCommand} command */
function browserCommandMutates(command) {
  if (command.method === "playwright")
    return (
      ![
        "domSnapshot",
        "elementInfo",
        "elementScreenshot",
        "waitForLoadState",
        "waitForURL",
        "waitForEvent",
        "downloadPath",
        "fileChooserSetFiles",
      ].includes(command.action.name) &&
      (command.action.name !== "locator" ||
        ![
          "count",
          "allTextContents",
          "getAttribute",
          "innerText",
          "textContent",
          "isVisible",
          "isEnabled",
          "waitFor",
        ].includes(command.action.operation))
    );
  return !["getState", "snapshot", "screenshot", "elementInfo", "fill", "waitFor"].includes(
    command.method,
  );
}

module.exports = { browserCommandMutates };
