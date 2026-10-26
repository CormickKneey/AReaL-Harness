// @ts-check
"use strict";
const { checkedRecord } = require("./remote-network.cjs");

/** @typedef {{devicePeerId:string,displayName:string,projectIds:string[],capabilities:string[],revision:number,status:'active'|'revoked'|'reviewRequired'}} DeviceGrant */
/** @typedef {{id:string,name:string,projects?:string[]}} LegacyDevice */
/** @typedef {{kind:'tailscale',mapping?:import('./remote-network.cjs').NetworkMapping,visibility?:undefined,publicOrigin?:undefined}|{kind:'organization',publicOrigin:string,visibility:'private'|'public',mapping?:undefined}} RemoteNetwork */
/** @typedef {{schemaVersion?:number,enabled?:boolean,directEnabled?:boolean,directPort?:number,identity?:string,relay?:string,relayProtocol?:string,room?:string,capability?:string,devices?:LegacyDevice[],deviceGrants?:DeviceGrant[],network?:RemoteNetwork|null,[key:string]:unknown}} RemoteConfig */

/** @param {unknown} value @returns {RemoteConfig} */
function parseRemoteConfig(value) {
  if (value == null) return { enabled: false, devices: [] };
  assertRemoteConfig(value);
  return value;
}
/** @param {unknown} value @returns {asserts value is RemoteConfig} */
function assertRemoteConfig(value) {
  if (
    !record(value) ||
    ["enabled", "directEnabled"].some(
      (key) => value[key] !== undefined && typeof value[key] !== "boolean",
    ) ||
    ["identity", "relay", "relayProtocol", "room", "capability"].some(
      (key) => value[key] !== undefined && typeof value[key] !== "string",
    ) ||
    (value.schemaVersion !== undefined &&
      (typeof value.schemaVersion !== "number" || !Number.isSafeInteger(value.schemaVersion))) ||
    (value.directPort !== undefined &&
      (typeof value.directPort !== "number" ||
        !Number.isInteger(value.directPort) ||
        value.directPort < 0 ||
        value.directPort > 65535)) ||
    (value.devices !== undefined &&
      (!Array.isArray(value.devices) || !value.devices.every(legacyDevice))) ||
    (value.deviceGrants !== undefined &&
      (!Array.isArray(value.deviceGrants) || !value.deviceGrants.every(deviceGrant)))
  )
    throw new Error("远程配置格式无效");
  if (value.network != null) {
    if (!record(value.network)) throw new Error("远程网络配置无效");
    if (value.network.kind === "tailscale") {
      if (value.network.visibility !== undefined || value.network.publicOrigin !== undefined)
        throw new Error("远程网络配置无效");
      if (value.network.mapping !== undefined)
        value.network.mapping = checkedRecord(value.network.mapping);
    } else if (
      value.network.kind !== "organization" ||
      value.network.mapping !== undefined ||
      typeof value.network.publicOrigin !== "string" ||
      (value.network.visibility !== "private" && value.network.visibility !== "public")
    )
      throw new Error("远程网络配置无效");
  }
}
/** @param {unknown} value @returns {value is DeviceGrant} */
function deviceGrant(value) {
  return (
    record(value) &&
    typeof value.devicePeerId === "string" &&
    typeof value.displayName === "string" &&
    strings(value.projectIds) &&
    strings(value.capabilities) &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    (value.status === "active" || value.status === "revoked" || value.status === "reviewRequired")
  );
}
/** @param {unknown} value @returns {value is LegacyDevice} */
function legacyDevice(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.projects === undefined || strings(value.projects))
  );
}
/** @param {unknown} value @returns {value is string[]} */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
module.exports = { parseRemoteConfig };
