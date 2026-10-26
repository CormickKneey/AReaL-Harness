// @ts-check
"use strict";
const { ipcMain } = require("electron");
/** @typedef {import('@areal/workbench/desktop-contract').DesktopInvokeArguments} InvokeArguments */
/** @typedef {import('@areal/workbench/desktop-contract').DesktopSendArguments} SendArguments */
/** @typedef {import('@areal/workbench/desktop-contract').DesktopEventArguments} EventArguments */

/** @template {keyof InvokeArguments} N @param {N} channel @param {(event:import('electron').IpcMainInvokeEvent,...args:InvokeArguments[N])=>unknown} listener */
function handleDesktopIpc(channel, listener) {
  ipcMain.handle(channel, listener);
}
/** @template {keyof SendArguments} N @param {N} channel @param {(event:import('electron').IpcMainEvent,...args:SendArguments[N])=>void} listener */
function onDesktopIpc(channel, listener) {
  ipcMain.on(channel, listener);
}
/** @template {keyof EventArguments} N @param {import('electron').WebContents} contents @param {N} channel @param {EventArguments[N]} args */
function sendDesktopEvent(contents, channel, ...args) {
  contents.send(channel, ...args);
}

module.exports = { handleDesktopIpc, onDesktopIpc, sendDesktopEvent };
