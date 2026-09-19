import {contextBridge, ipcRenderer} from "electron";

/**
 * The only thing the window can do: talk to the converter through these calls.
 * Everything else stays in the main process.
 */
contextBridge.exposeInMainWorld("converter", {
    init: () => ipcRenderer.invoke("init"),
    scan: () => ipcRenderer.invoke("scan"),
    start: (serial: string, mode: string) => ipcRenderer.invoke("start", serial, mode),
    stop: () => ipcRenderer.invoke("stop"),
    setAutoStart: (autoStart: boolean) => ipcRenderer.invoke("set-auto-start", autoStart),
    onState: (callback: (state: unknown) => void) => {
        ipcRenderer.on("state", (_event, state) => callback(state));
    }
});
