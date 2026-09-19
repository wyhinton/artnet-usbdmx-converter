import {app, BrowserWindow, dialog, ipcMain, nativeTheme, powerSaveBlocker} from "electron";
import * as fs from "fs";
import * as path from "path";
import ConfigStorage from "../config/ConfigStorage";
import ConvertHandler from "../ConvertHandler";
import modeToString from "../helpers/modeToString";
import {DetectedInterface} from "../usbdmx";

/**
 * Desktop (Electron) front end for the converter. Reuses {@link ConvertHandler} as-is; the window only
 * picks the interface and mode, starts/stops the conversion and shows the live frame rates.
 */

type ConverterStatus = "idle" | "starting" | "running";

interface Rates {
    artnetIn: number,
    usbdmxOut: number,
    usbdmxIn: number,
    artnetOut: number
}

/** Snapshot pushed to the window on every status change and once a second */
interface ConverterState {
    status: ConverterStatus,
    error: string | undefined,
    rates: Rates
}

interface Settings {
    serial?: string,
    mode?: string,
    autoStart: boolean
}

/** Mode used for HID interfaces the first time, matches the example in the README (PC Out -> DMX Out & DMX In -> PC In) */
const DEFAULT_MODE = "6";

const configStorage = new ConfigStorage();
const handler = new ConvertHandler(configStorage);

let win: BrowserWindow | undefined;
let status: ConverterStatus = "idle";
let lastError: string | undefined;
let powerBlockerId: number | undefined;
/** Bumped whenever the converter is stopped, so a start that is still awaiting knows it was cancelled */
let generation = 0;
let autoStartHandled = false;
let settings: Settings = {autoStart: false};

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const userConfigPath = () => path.join(app.getPath("userData"), "config.json");

function loadSettings() {
    try {
        settings = {autoStart: false, ...JSON.parse(fs.readFileSync(settingsPath(), "utf-8"))};
    }
    catch {
        settings = {autoStart: false};
    }
}

function saveSettings(patch: Partial<Settings>) {
    settings = {...settings, ...patch};
    try {
        fs.mkdirSync(path.dirname(settingsPath()), {recursive: true});
        fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    }
    catch (err) {
        console.error("Failed to save settings", err);
    }
}

/**
 * Loads the optional config.json from the app's data folder (same format as the CLI's --config file)
 */
function loadUserConfig() {
    if (!fs.existsSync(userConfigPath())) return;
    try {
        // ConfigStorage exits the process on a bad file, so check it first and show a dialog instead
        JSON.parse(fs.readFileSync(userConfigPath(), "utf-8"));
    }
    catch (err) {
        dialog.showErrorBox("Invalid config.json", `${userConfigPath()}\n\n${(err as Error).message}\n\nUsing the default configuration instead.`);
        return;
    }
    configStorage.loadConfig(userConfigPath());
}

function lastRate(history: number[]): number {
    return history.length > 0 ? history[history.length - 1] : 0;
}

function snapshot(): ConverterState {
    const running = status === "running";
    return {
        status,
        error: lastError,
        rates: {
            artnetIn: running ? lastRate(handler.artnetInCountHistory) : 0,
            usbdmxOut: running ? lastRate(handler.usbdmxOutCountHistory) : 0,
            usbdmxIn: running ? lastRate(handler.usbdmxInCountHistory) : 0,
            artnetOut: running ? lastRate(handler.artnetOutCountHistory) : 0
        }
    };
}

function pushState() {
    if (win && !win.isDestroyed()) {
        win.webContents.send("state", snapshot());
    }
}

function setStatus(newStatus: ConverterStatus) {
    status = newStatus;
    pushState();
}

function describeInterface(i: DetectedInterface): string {
    const name = [i.manufacturer, i.product].filter(Boolean).join(" ");
    return name ? `${name} (${i.serial})` : i.serial;
}

function listInterfaces() {
    return handler.availableInterfaces.map((i) => ({
        serial: i.serial,
        label: describeInterface(i),
        protocol: i.protocol
    }));
}

function describeReceiverAddress(): string {
    const receiver = configStorage.getDmxNetReceiverConfig();
    return `Net ${receiver.net ?? 0} · Sub-Net ${receiver.subnet ?? 0} · Universe ${receiver.universe ?? 0}`;
}

/**
 * Closes the interface and returns to idle. Also the shared cleanup path for failed starts and crashes.
 * The Art-Net receiver itself stays up, dmxnet can't close its sockets; frames are dropped while no interface is open.
 * @param error message to show in the window
 */
function stopConverter(error?: string) {
    generation++;
    try {
        handler.closeInterface();
    }
    catch (err) {
        console.error("Failed to close interface", err);
    }
    if (powerBlockerId !== undefined) {
        powerSaveBlocker.stop(powerBlockerId);
        powerBlockerId = undefined;
    }
    lastError = error;
    setStatus("idle");
}

async function startConverter(serial: string, mode: string): Promise<void> {
    if (status !== "idle") return;
    lastError = undefined;
    setStatus("starting");
    const startedGeneration = generation;
    try {
        // re-scan so the HID/serial path is current, in case the interface was replugged since the list was shown
        await handler.scanForInterfaces();
        if (startedGeneration !== generation) return;

        const info = handler.availableInterfaces.find((e) => e.serial === serial);
        if (!info) throw new Error("Interface not found - is it plugged in?");

        // same rule as the CLI: interfaces speaking the Enttec Pro protocol have no DMX input, so don't start the Art-Net sender
        handler.startArtNetReceiver(info.protocol !== "enttec-serial");

        const openError = await handler.openInterface(serial, mode, info.manufacturer, info.product);
        if (startedGeneration !== generation) return;
        if (openError.length > 0) throw new Error(openError);

        saveSettings({serial, mode});
        // keeps the machine (and its timers/network) awake while it's converting
        powerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
        setStatus("running");
    }
    catch (err) {
        if (startedGeneration === generation) {
            stopConverter((err as Error).message);
        }
    }
}

function createWindow() {
    win = new BrowserWindow({
        width: 420,
        height: 520,
        useContentSize: true,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        title: "ArtNet → USBDMX",
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#f5f5f7",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            // this is a converter, it has to keep running while the window is hidden or covered
            backgroundThrottling: false
        }
    });
    // the compiled main file lives in dist/gui, the window's files in gui/ (a sibling of dist/)
    win.loadFile(path.join(__dirname, "..", "..", "gui", "index.html"));
    win.once("ready-to-show", () => win?.show());
    win.on("closed", () => {
        win = undefined;
    });
}

function registerIpc() {
    ipcMain.handle("init", async () => {
        await handler.scanForInterfaces();
        const initialState = {
            version: app.getVersion(),
            receiverAddress: describeReceiverAddress(),
            interfaces: listInterfaces(),
            modes: [0, 1, 2, 3, 4, 5, 6, 7].map((mode) => ({value: String(mode), label: modeToString(mode)})),
            defaultMode: DEFAULT_MODE,
            settings,
            state: snapshot()
        };
        if (!autoStartHandled) {
            autoStartHandled = true;
            if (settings.autoStart && settings.serial) {
                void startConverter(settings.serial, settings.mode ?? DEFAULT_MODE);
            }
        }
        return initialState;
    });

    ipcMain.handle("scan", async () => {
        if (status === "idle") {
            await handler.scanForInterfaces();
        }
        return listInterfaces();
    });

    ipcMain.handle("start", (_event, serial: unknown, mode: unknown) => {
        if (typeof serial !== "string" || typeof mode !== "string") return;
        return startConverter(serial, mode);
    });

    ipcMain.handle("stop", () => {
        stopConverter();
    });

    ipcMain.handle("set-auto-start", (_event, autoStart: unknown) => {
        saveSettings({autoStart: autoStart === true});
    });
}

// a yanked USB cable or a busy Art-Net port surfaces as an exception from inside a driver callback - show it in
// the window instead of Electron's default "JavaScript error in the main process" dialog
process.on("uncaughtException", (err) => {
    console.error(err);
    stopConverter(err.message);
});

if (!app.requestSingleInstanceLock()) {
    // a second copy would fight the first one for the USB interface and the Art-Net port
    app.quit();
}
else {
    app.on("second-instance", () => {
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });

    // single-window utility: closing the window quits, which also closes the interface (in before-quit)
    app.on("window-all-closed", () => app.quit());
    app.on("before-quit", () => stopConverter());

    app.whenReady().then(() => {
        loadSettings();
        loadUserConfig();
        registerIpc();
        createWindow();
        setInterval(pushState, 1000);
    });
}
