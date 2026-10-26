// @ts-check
"use strict";
/** @param {unknown} value */
function preparedActionId(value) {
  return value !== null &&
    typeof value === "object" &&
    "preparedActionId" in value &&
    typeof value.preparedActionId === "string"
    ? value.preparedActionId
    : undefined;
}
module.exports = { preparedActionId };
