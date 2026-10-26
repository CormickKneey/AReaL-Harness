// @ts-check
"use strict";
const { ToolSchema, IconSchema, ContentBlockSchema } = require("@modelcontextprotocol/core");
/** @typedef {ReturnType<typeof ToolSchema.parse>} McpToolMetadata */
/** @typedef {ReturnType<typeof IconSchema.parse>} McpIcon */
/** @typedef {ReturnType<typeof ContentBlockSchema.parse>} McpContentBlock */

/** @param {unknown} value @returns {value is McpToolMetadata} */
function isMcpToolMetadata(value) {
  return ToolSchema.safeParse(value).success;
}
/** @param {unknown} value @returns {value is McpIcon} */
function isMcpIcon(value) {
  return IconSchema.safeParse(value).success;
}
/** @param {unknown} value @returns {value is McpContentBlock} */
function isMcpContentBlock(value) {
  return ContentBlockSchema.safeParse(value).success;
}
module.exports = { isMcpToolMetadata, isMcpIcon, isMcpContentBlock };
