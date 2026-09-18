import HID from "node-hid";
import {DMXCommand, IDMXInterface} from "./IDMXInterface";
import modeToString from "../helpers/modeToString";
import {describeInterfaceReturnCode, pipelineLog, pipelineWarn} from "../helpers/pipelineLog";

/*
Return codes
* 0: OK
* 1: invalid channel
* 2: invalid value
* 3: invalid mode
* 4: invalid array size
* 5: other error
*/

/**
 * Represents a connected DMX interface and handles all communication with it
 */
class DMXInterface implements IDMXInterface {

    path: string;
    serial: string;
    manufacturer: string | undefined;
    product: string | undefined;
    currentMode = 0;
    hidDevice: HID.HID;
    dmxout: number[];
    debug = false;

    usbdmxInputCallback: (start: number, values: number[]) => void;

    constructor(
        path: string,
        serial: string,
        manufacturer: string | undefined = undefined,
        product: string | undefined = undefined
    ) {
        this.path = path;
        this.serial = serial;
        this.manufacturer = manufacturer;
        this.product = product;

        this.hidDevice = new HID.HID(path);
        this.hidDevice.on("data", (data: Buffer) => {
            // received buffer contains 33 bytes, the first one (data[0]) is the page and the rest are the dmx channel values
            // this means we get 32 dmx channels in one package

            const values: number[] = [];
            for (let i = 1; i < 33; i++) {
                values.push(data[i]);
            }
            pipelineLog(this.debug, "HID-IN", `page=${data[0]} (channels ${data[0] * 32 + 1}-${data[0] * 32 + 32}) values=[${values.join(",")}]`);
            this.usbdmxInputCallback(data[0] * 32, values);

        })
        this.dmxout = Array(512).fill(0);
    }

    /**
     * Opens the interface and returns {@link DMXInterface}
     * @param path HID path of the interface
     * @param serial Serial number
     * @param manufacturer Manufacturer ID
     * @param product Product ID
     */
    static open = (
        path: string,
        serial: string,
        manufacturer: string | undefined = undefined,
        product: string | undefined = undefined
    ): Promise<DMXInterface> => {
        return new Promise<DMXInterface>((resolve) => {
            resolve(new DMXInterface(path, serial, manufacturer, product));
        });
    }

    /**
     * Closes the HID connection to the interface
     */
    close = () => {
        pipelineLog(this.debug, "LIFECYCLE", `closing HID interface ${this.serial} (${this.path})`);
        this.setMode(0);
        this.hidDevice.close();
    }

    /*
    Description of how DMX + HID works:
    Each HID buffer sent contains 33 bytes.
    The first byte (buffer[0]) is the "page", the rest are 32 DMX channels.
    To get to the other DMX channels, increase the first byte
    e.g. DMX channel = 33 -> buffer[0] = 1; buffer[1] = value for ch. 33

    * Buffer values
    * Index 0 (buffer[0])
    *   - 0-15: DMX?
    *   - 16: Mode
    *   - 17: Config?
    *
    */

    /*
    * Modes:
        * 0: Do nothing - Standby
        * 1: DMX In -> DMX Out
        * 2: PC Out -> DMX Out
        * 3: DMX In + PC Out -> DMX Out
        * 4: DMX In -> PC In
        * 5: DMX In -> DMX Out & DMX In -> PC In
        * 6: PC Out -> DMX Out & DMX In -> PC In
        * 7: DMX In + PC Out -> DMX Out & DMX In -> PC In
    */

    /**
     * Sets the DMX mode of the interface
     * @param mode mode as a number from 0-7
     */
    setMode = (mode: number): number => {
        // check if mode is between 0 and 7
        if (mode > 7 || mode < 0) return 3;

        // create data buffer
        const _buffer = Buffer.alloc(34);
        _buffer[1] = 16;
        _buffer[2] = mode;

        try {
            this.hidDevice.write(_buffer);
            this.currentMode = mode;
            pipelineLog(this.debug, "LIFECYCLE", `set mode to ${mode} (${modeToString(mode)})`);
            return 0;
        }
        catch (err) {
            console.log(err);
            return 5;
        }
    }

    /**
     * Returns a human-readable description of the interface's current mode
     */
    getModeDescription = (): string => {
        return modeToString(this.currentMode);
    }

    /**
     * Sends the given 32-channel "pages" (0-15) of {@link dmxout} to the interface, one HID
     * report per page. node-hid's write() is a synchronous/blocking call, so only sending pages
     * that actually changed (rather than always sending all 16) matters a lot for output latency
     * during fast-changing content like a chase.
     */
    private sendPages = (pages: Iterable<number>): void => {
        for (const page of pages) {
            const _buffer = Buffer.alloc(34);
            // first byte needs to be 0 according to node-hid documentation (reportId)
            _buffer[0] = 0x00;
            // set second byte to page number
            _buffer[1] = page;
            for (let j = 2; j < 34; j++) {
                // get value for corresponding channel (page * 32 for the page)
                _buffer[j] = this.dmxout[(page * 32) + j - 2];
            }
            this.hidDevice.write(_buffer);
        }
    }

    /**
     * Writes DMX data to the interface
     * @param data DMX data object array
     */
    write = (data: DMXCommand[] | undefined): number => {
        let returnStatus = 0;

        if (data !== undefined) {
            // update dmx out array with new values
            for (const _entry of data) {
                if (_entry.channel < 1 || _entry.channel > 512) {
                    pipelineWarn("WRITE", `dropping command for out-of-range channel ${_entry.channel}`);
                    returnStatus = 1;
                    continue;
                }
                if (_entry.value < 0 || _entry.value > 255) {
                    pipelineWarn("WRITE", `dropping out-of-range value ${_entry.value} for channel ${_entry.channel}`);
                    returnStatus = 2;
                    continue;
                }
                this.dmxout[_entry.channel - 1] = _entry.value
            }
        }

        // loop through all 16 "pages" (each write command can hold 32 channels)
        this.sendPages(Array.from({length: 16}, (_, i) => i));
        pipelineLog(this.debug, "WRITE", `wrote 512 channels to HID interface ${this.serial} across 16 pages (status=${describeInterfaceReturnCode(returnStatus)})`);
        return returnStatus;

    }

    /**
     * Writes an entire universe to the interface. Only the 32-channel "page(s)" that actually
     * changed since the last write are resent, since each page is a separate blocking USB write -
     * resending all 16 on every update (regardless of how many channels actually changed) added
     * up to real output latency during fast-changing content like a chase.
     * @param array Array of all DMX values with a length of 512
     */
    writeMap = (array: number[]): number => {
        if (array.length !== 512) {
            pipelineWarn("WRITE", `writeMap called with ${array.length} channels instead of 512 - dropping frame entirely`);
            return 4;
        }

        const dirtyPages = new Set<number>();
        for (let page = 0; page < 16; page++) {
            for (let ch = 0; ch < 32; ch++) {
                const index = page * 32 + ch;
                if (this.dmxout[index] !== array[index]) {
                    dirtyPages.add(page);
                    break;
                }
            }
        }

        this.dmxout = array;

        if (dirtyPages.size === 0) {
            pipelineLog(this.debug, "WRITE", "writeMap called but no channels actually changed - nothing sent to the interface");
            return 0;
        }

        this.sendPages(dirtyPages);
        pipelineLog(this.debug, "WRITE", `wrote ${dirtyPages.size}/16 changed page(s) to HID interface ${this.serial}`);
        return 0;
    }

}

export { DMXInterface };
export type { DMXCommand };