/*
 * Node's and Electron's modules, on the desktop app only. They're loaded with
 * import() when the plugin starts on a desktop (loadNode, awaited first thing
 * in onload), and the code that needs them uses these bindings, which fill in
 * then. On a phone they stay null and nothing that needs them runs.
 */

import { Platform } from "obsidian";

export let fs = null;
export let path = null;
export let os = null;
export let childProcess = null;
// Electron's remote module: the Settings window's controls (macOS).
export let remote = null;

let loading = null;

export function loadNode() {
  if (!loading) loading = load();
  return loading;
}

async function load() {
  if (Platform.isDesktop) {
    const [fsModule, pathModule, osModule, childProcessModule] = await Promise.all([import("fs"), import("path"), import("os"), import("child_process")]);
    fs = fsModule;
    path = pathModule;
    os = osModule;
    childProcess = childProcessModule;
    try {
      const m = await import("@electron/remote");
      remote = m.default || m;
    } catch {
      // not in this version of Obsidian: the window controls stay where they are
      remote = null;
    }
  }
}
