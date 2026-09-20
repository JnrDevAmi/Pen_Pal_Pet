"use strict";
/*
 * The only bridge between the sandboxed page and the privileged main process.
 *
 * Everything here is deliberate and used. Nothing that opens external
 * programs, writes the clipboard or moves the window is exposed, because the
 * page has no need of it - and an unused capability is only ever a liability.
 * Every argument is coerced here as well as re-validated on the other side.
 */
const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED_COMMANDS = ["write", "mailbag", "friends", "pet"];

contextBridge.exposeInMainWorld("penpal", {
  platform: process.platform,

  // reads
  getState: () => ipcRenderer.invoke("state:get"),

  // one narrow door for every action, dispatched against a whitelist in main
  call: (action, payload) => ipcRenderer.invoke("do", {
    action: String(action || ""),
    payload: payload && typeof payload === "object" ? payload : {},
  }),

  // tray text and unread count
  setStatus: (text, badge) => ipcRenderer.send("status", {
    text: String(text == null ? "" : text).slice(0, 200),
    badge: Number(badge) || 0,
  }),

  quit: () => ipcRenderer.send("app:quit"),

  // pushes from main; the payload is handed over untouched but the page treats
  // it as data, never as markup
  onState: (fn) => { ipcRenderer.on("state", (_e, s) => fn(s)); },
  onEvent: (fn) => { ipcRenderer.on("net-event", (_e, ev) => fn(ev)); },
  onCommand: (fn) => {
    ipcRenderer.on("command", (_e, c) => {
      if (ALLOWED_COMMANDS.includes(c)) fn(c);
    });
  },
});
