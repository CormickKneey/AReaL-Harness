// @ts-check
"use strict";
const {
  isDesktopSnapshot,
} = require("../../../packages/workbench/client/desktop-contract/shared.cjs");
const { sameOwner } = require("./application-owner.cjs");

/** @typedef {import('../../../packages/workbench/client/desktop-contract/shared.cjs').ServiceThread} ServiceThread */
/** @typedef {import('../../../packages/workbench/client/desktop-contract/shared.cjs').ServiceProject} ServiceProject */
/** @typedef {import('../../../packages/workbench/client/desktop-contract/shared.cjs').DesktopSnapshot} ServiceSnapshot */
/** @typedef {{connected:true,busy:boolean,providerUpdating:boolean,clients:number,activeCommands:number,starting:number,pid:number,applicationOwner?:unknown,browserCore?:Record<string,string|null>,browserControlEndpoints?:string[],[key:string]:unknown}} ServiceState */
/** @typedef {{sequence:number,snapshot:ServiceSnapshot,service:ServiceState,[key:string]:unknown}} ServicePacket */

/** @type {(packet:unknown,metadata:unknown)=>asserts packet is ServicePacket} */
const validateServicePacket = (packet, metadata) => {
  if (!servicePacket(packet, metadata)) {
    throw Object.assign(
      new Error("后台服务快照不受支持，原后台保持运行。请安全重启后使用本次配置。"),
      { code: "SERVICE_SNAPSHOT_INVALID" },
    );
  }
};
/** @param {unknown} packet @param {unknown} metadata @returns {packet is ServicePacket} */
function servicePacket(packet, metadata) {
  if (!record(packet) || !record(metadata)) return false;
  const snapshot = packet.snapshot,
    service = packet.service;
  if (!record(snapshot) || !record(snapshot.library) || !record(service)) return false;
  return (
    count(packet.sequence) &&
    isDesktopSnapshot(snapshot) &&
    (service.browserCore === undefined ||
      (record(service.browserCore) &&
        Object.values(service.browserCore).every(
          (value) => value === null || typeof value === "string",
        ))) &&
    (service.browserControlEndpoints === undefined ||
      (Array.isArray(service.browserControlEndpoints) &&
        service.browserControlEndpoints.every((value) => typeof value === "string"))) &&
    service.connected === true &&
    typeof service.busy === "boolean" &&
    typeof service.providerUpdating === "boolean" &&
    count(service.clients) &&
    count(service.activeCommands) &&
    count(service.starting) &&
    typeof service.pid === "number" &&
    Number.isSafeInteger(service.pid) &&
    service.pid > 1 &&
    service.pid === metadata.pid &&
    ((metadata.applicationOwner === undefined && service.applicationOwner === undefined) ||
      sameOwner(metadata.applicationOwner, service.applicationOwner))
  );
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is number} */
function count(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** @param {unknown} packet @param {unknown} metadata @returns {ServicePacket} */
function readServicePacket(packet, metadata) {
  validateServicePacket(packet, metadata);
  return packet;
}

module.exports = { validateServicePacket, readServicePacket };
