// @ts-check
"use strict";
/** @typedef {import('../../../packages/workbench/client/desktop-contract/shared.cjs').Configuration} Configuration */
/** @typedef {import('../../../packages/workbench/client/desktop-contract/shared.cjs').Inspection} Inspection */
const {
  isConfiguration,
  readInspection,
  readConfigured,
} = require("../../../packages/workbench/client/desktop-contract/shared.cjs");
module.exports = { isConfiguration, readInspection, readConfigured };
