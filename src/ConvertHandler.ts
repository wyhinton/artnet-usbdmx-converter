import {dmxnet, receiver, sender} from "dmxnet";
import {DetectedInterface, DMXInterface, EnttecProInterface, getConnectedInterfaces, IDMXInterface} from "./usbdmx";
import {clearInterval} from "timers";
import {defaultConfigStorage} from "./index";
import chalk from "chalk";
import {describeInterfaceReturnCode, pipelineLog, pipelineWarn} from "./helpers/pipelineLog";

/**
 * Responsible for converting incoming Art-Net data to an USBDMX output
 */
export default class ConvertHandler {
    dmxnetManager: dmxnet;
    artNetReceiver: receiver;
    artNetSender: sender;

    recentDMXArray: number[] = Array(512).fill(0);

    availableInterfaces: DetectedInterface[] = [];

    dmxInterface: IDMXInterface | undefined;
    outputAllowed = false;

    /** When true, prints the DMX values as they are written to the interface */
    debug = false;

    dataPerSecTimer: NodeJS.Timeout;

    private artnetInCounter = 0;
    private artnetOutCounter = 0;
    private usbdmxInCounter = 0;
    private usbdmxOutCounter = 0;

    artnetInCountHistory: number[] = [];
    artnetOutCountHistory: number[] = [];
    usbdmxInCountHistory: number[] = [];
    usbdmxOutCountHistory: number[] = [];

    /**
     * Starts up the Art-Net receiver
     * @param enableSender Whether to also start the Art-Net sender used for the USBDMX-In -> Art-Net-Out
     * direction. dmxnet's sender broadcasts a keep-alive ArtDmx frame once a second even when there's nothing
     * to send, which other Art-Net nodes (e.g. consoles) can flag as an address conflict - so this should stay
     * off for interfaces that don't support DMX input, such as {@link EnttecProInterface}.
     */
    startArtNetReceiver = (enableSender = true) => {
        this.dmxnetManager = new dmxnet(defaultConfigStorage.getDmxNetConfig());
        this.artNetReceiver = this.dmxnetManager.newReceiver(defaultConfigStorage.getDmxNetReceiverConfig());
        pipelineLog(this.debug, "LIFECYCLE", `ArtNet receiver started (${JSON.stringify(defaultConfigStorage.getDmxNetReceiverConfig())})`);
        if (enableSender) {
            this.artNetSender = this.dmxnetManager.newSender(defaultConfigStorage.getDmxNetSenderConfig());
            pipelineLog(this.debug, "LIFECYCLE", `ArtNet sender started (${JSON.stringify(defaultConfigStorage.getDmxNetSenderConfig())})`);
        }
        else {
            pipelineLog(this.debug, "LIFECYCLE", "ArtNet sender disabled for this interface - USBDMX-In -> ArtNet-Out is off");
        }
        this.artNetReceiver.on("data", this.handleIncomingArtNetData);
    }

    /**
     * Handles incoming Art-Net data and writes it to the DMX interface.
     * @param data Art-Net data
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleIncomingArtNetData = (data: any) => {
        this.artnetInCounter++;
        pipelineLog(this.debug, "ARTNET-IN", `frame #${this.artnetInCounter} received (${data.length} channels)`);

        if (JSON.stringify(data) != JSON.stringify(this.recentDMXArray)) {
            pipelineLog(this.debug, "DEDUP", `frame #${this.artnetInCounter} differs from last frame - forwarding`);
            if (this.dmxInterface && this.outputAllowed) {
                this.usbdmxOutCounter++;
                if (this.debug) {
                    this.printDMXDebug(data);
                }
                const writeResult = this.dmxInterface.writeMap(data);
                if (writeResult !== 0) {
                    pipelineWarn("WRITE", `frame #${this.artnetInCounter} was not written to the interface (${describeInterfaceReturnCode(writeResult)})`);
                }
            }
            else {
                pipelineLog(this.debug, "DEDUP", `frame #${this.artnetInCounter} dropped - dmxInterface=${!!this.dmxInterface} outputAllowed=${this.outputAllowed}`);
            }
            this.recentDMXArray = data;
        }
        else {
            pipelineLog(this.debug, "DEDUP", `frame #${this.artnetInCounter} identical to last frame - skipping`);
        }
    }

    /**
     * Prints every DMX channel value about to be written to the interface
     * @param data DMX data about to be written to the interface
     */
    private printDMXDebug = (data: number[]) => {
        const values = data.map((value, i) => `Ch${i + 1}=${value}`);
        console.log(chalk.magenta(`[${new Date().toISOString()}]`), chalk.magenta("[WRITE]"), values.join(" "));
    }

    /**
     * Handles incoming data from the interface and sends it out via Art-Net.
     * @param startChannel first channel number of the data array
     * @param data Array with dmx values
     */
    sendIncomingUSBDMXData = (startChannel: number, data: number[]) => {
        this.usbdmxInCounter++;
        pipelineLog(this.debug, "USBDMX-IN", `received ${data.length} channels starting at ${startChannel + 1} (frame #${this.usbdmxInCounter})`);

        if (this.outputAllowed && this.artNetSender) {
            let skipped = 0;
            for (let i = 0; i < data.length; i++) {
                if ((startChannel + i) >= 0 && (startChannel + i) < 512 && data[i] >= 0 && data[i] < 256) {
                    this.artNetSender.prepChannel(startChannel + i, data[i]);
                }
                else {
                    skipped++;
                }
            }
            if (skipped > 0) {
                pipelineWarn("USBDMX-IN", `skipped ${skipped} out-of-range channel(s) starting at ${startChannel + 1}`);
            }
            this.artnetOutCounter++;
            this.artNetSender.transmit();
            pipelineLog(this.debug, "ARTNET-OUT", `transmitted universe (frame #${this.artnetOutCounter}, ${data.length - skipped} channel(s) updated from channel ${startChannel + 1})`);
        }
        else {
            pipelineLog(this.debug, "USBDMX-IN", `frame dropped - outputAllowed=${this.outputAllowed} artNetSender=${!!this.artNetSender}`);
        }
    }

    /**
     * Gets available DMX interfaces connected to the computer
     */
    scanForInterfaces = async (): Promise<DetectedInterface[]> => {
        this.availableInterfaces = await getConnectedInterfaces();
        pipelineLog(this.debug, "LIFECYCLE", `found ${this.availableInterfaces.length} interface(s): ${this.availableInterfaces.map((i) => `${i.serial} (${i.protocol})`).join(", ") || "none"}`);
        return this.availableInterfaces;
    }

    /**
     * Tries to open the connection to a DMX interface
     * @param serial Serial number of the interface
     * @param mode Operating mode
     * @param manufacturer Interface manufacturer ID
     * @param product Interface product ID
     * @returns an empty string if the connection was successful or the error message
     */
    openInterface = async (serial: string, mode: string, manufacturer: string | undefined = undefined, product: string | undefined = undefined): Promise<string> => {
        if (isNaN(parseInt(mode))) return "Invalid mode";

        const interfaceIndex = this.availableInterfaces.findIndex((e) => e.serial == serial);
        if (interfaceIndex === -1) return "Interface not found, please scan again";

        const detectedInterface = this.availableInterfaces[interfaceIndex];
        const interfacePath = detectedInterface.path;

        pipelineLog(this.debug, "LIFECYCLE", `opening ${detectedInterface.protocol} interface ${serial} at ${interfacePath} with mode ${mode}`);

        try {
            this.dmxInterface = detectedInterface.protocol === "enttec-serial"
                ? await EnttecProInterface.open(interfacePath, serial, manufacturer, product)
                : await DMXInterface.open(interfacePath, serial, manufacturer, product);
            this.dmxInterface.debug = this.debug;
            this.dmxInterface.usbdmxInputCallback = this.sendIncomingUSBDMXData;
            return new Promise<string>((resolve) => {
                setTimeout( () => {
                    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                    // @ts-expect-error
                    const response = this.dmxInterface.setMode(parseInt(mode));
                    this.outputAllowed = true;
                    this.dataPerSecTimer = setInterval(this.parseRequestTimer, 1000);
                    pipelineLog(this.debug, "LIFECYCLE", `interface ${serial} ready (${describeInterfaceReturnCode(response)}) - output allowed`);
                    resolve(response === 0 ? "" : `Error Code ${response}`);
                }, 1000);
            })
        }
        catch(err) {
            pipelineWarn("LIFECYCLE", `failed to open interface ${serial}: ${(err as Error).message}`);
            console.log(err);
            return (err as Error).message;
        }
    }

    /**
     * Closes the connection to a DMX interface
     */
    closeInterface = () => {
        if (this.dmxInterface) {
            pipelineLog(this.debug, "LIFECYCLE", `closing interface ${this.dmxInterface.serial}`);
            this.dmxInterface.close();
            this.outputAllowed = false;
            clearInterval(this.dataPerSecTimer);
            this.dmxInterface = undefined;
        }
    }

    /**
     * Processes incoming and sent data history for visualization
     */
    parseRequestTimer = () => {
        this.artnetInCountHistory.push(this.artnetInCounter);
        if (this.artnetInCountHistory.length > 20) {
            this.artnetInCountHistory = this.artnetInCountHistory.slice(1)
        }

        this.artnetOutCountHistory.push(this.artnetOutCounter);
        if (this.artnetOutCountHistory.length > 20) {
            this.artnetOutCountHistory = this.artnetOutCountHistory.slice(1)
        }

        this.usbdmxInCountHistory.push(this.usbdmxInCounter);
        if (this.usbdmxInCountHistory.length > 20) {
            this.usbdmxInCountHistory = this.usbdmxInCountHistory.slice(1)
        }

        this.usbdmxOutCountHistory.push(this.usbdmxOutCounter);
        if (this.usbdmxOutCountHistory.length > 20) {
            this.usbdmxOutCountHistory = this.usbdmxOutCountHistory.slice(1)
        }

        this.artnetInCounter = 0;
        this.artnetOutCounter = 0;
        this.usbdmxInCounter = 0;
        this.usbdmxOutCounter = 0;
    }
}