import {SerialPort} from "serialport";
import {DMXCommand, IDMXInterface} from "./IDMXInterface";
import {describeInterfaceReturnCode, pipelineLog, pipelineWarn} from "../helpers/pipelineLog";

/*
Implements the ENTTEC DMX USB PRO API protocol (also spoken by DMXKing and other
"Open DMX USB PRO API" compatible widgets). Unlike {@link DMXInterface}, these widgets
communicate over the FTDI chip's virtual serial port instead of raw HID reports.

Protocol reference: ENTTEC "DMX USB PRO API Specification", cross-checked against
QLC+'s open-source implementation (plugins/dmxusb/src/enttecdmxusbpro.cpp and
qtserial-interface.cpp at https://github.com/mcallegari/qlcplus).

Message framing:
  [0x7E] [label] [data length LSB] [data length MSB] [...data...] [0xE7]

For sending DMX output ("Output Only Send DMX Packet Request"), label 0x06 is used
and the data is a single DMX start code byte (0x00) followed by up to 512 channel values.
*/


const ENTTEC_START_OF_MSG = 0x7E;
const ENTTEC_END_OF_MSG = 0xE7;
const ENTTEC_SEND_DMX_LABEL = 0x06;
const ENTTEC_DMX_START_CODE = 0x00;

/**
 * Represents a connected ENTTEC DMX USB PRO (protocol compatible) interface and handles
 * all communication with it. DMX input is currently not supported for this protocol.
 */
class EnttecProInterface implements IDMXInterface {

    path: string;
    serial: string;
    manufacturer: string | undefined;
    product: string | undefined;
    currentMode = 0;
    dmxout: number[];
    debug = false;

    usbdmxInputCallback: (start: number, values: number[]) => void = () => {
        // DMX input is not implemented for the Enttec Pro protocol yet
    };

    private port: SerialPort;

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
        this.dmxout = Array(512).fill(0);

        this.port = new SerialPort({
            path,
            baudRate: 250000,
            dataBits: 8,
            stopBits: 2,
            parity: "none",
            rtscts: false,
            autoOpen: false
        });
    }

    /**
     * Opens the interface and returns {@link EnttecProInterface}
     * @param path Serial port path of the interface
     * @param serial Serial number
     * @param manufacturer Manufacturer ID
     * @param product Product ID
     */
    static open = (
        path: string,
        serial: string,
        manufacturer: string | undefined = undefined,
        product: string | undefined = undefined
    ): Promise<EnttecProInterface> => {
        return new Promise<EnttecProInterface>((resolve, reject) => {
            const _interface = new EnttecProInterface(path, serial, manufacturer, product);
            _interface.port.open((openErr) => {
                if (openErr) {
                    reject(openErr);
                    return;
                }
                // the widget requires RTS to be cleared before it will accept commands
                _interface.port.set({rts: false}, (setErr) => {
                    if (setErr) {
                        reject(setErr);
                        return;
                    }
                    resolve(_interface);
                });
            });
        });
    }

    /**
     * Closes the serial connection to the interface
     */
    close = () => {
        pipelineLog(this.debug, "LIFECYCLE", `closing serial interface ${this.serial} (${this.path})`);
        if (this.port.isOpen) {
            this.port.close();
        }
    }

    /**
     * The Enttec Pro protocol has no interface "mode" concept like the HID-based
     * interfaces do - it is always in continuous PC Out -> DMX Out operation once opened.
     */
    setMode = (): number => {
        pipelineLog(this.debug, "LIFECYCLE", "setMode is a no-op for the Enttec Pro protocol (always PC Out -> DMX Out)");
        return 0;
    }

    /**
     * Returns a human-readable description of the interface's current mode
     */
    getModeDescription = (): string => {
        return "PC Out -> DMX Out (Enttec DMX USB PRO protocol)";
    }

    /**
     * Writes DMX data to the interface
     * @param data DMX data object array
     */
    write = (data: DMXCommand[] | undefined): number => {
        let returnStatus = 0;

        if (data !== undefined) {
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
                this.dmxout[_entry.channel - 1] = _entry.value;
            }
        }

        // +1 for the DMX start code byte prepended to the channel data
        const dataLength = this.dmxout.length + 1;
        const frame = Buffer.alloc(5 + dataLength);
        frame[0] = ENTTEC_START_OF_MSG;
        frame[1] = ENTTEC_SEND_DMX_LABEL;
        frame[2] = dataLength & 0xff;
        frame[3] = (dataLength >> 8) & 0xff;
        frame[4] = ENTTEC_DMX_START_CODE;
        for (let i = 0; i < this.dmxout.length; i++) {
            frame[5 + i] = this.dmxout[i];
        }
        frame[frame.length - 1] = ENTTEC_END_OF_MSG;

        try {
            this.port.write(frame);
        }
        catch (err) {
            console.log(err);
            return 5;
        }

        pipelineLog(this.debug, "WRITE", `wrote 512 channels to serial interface ${this.serial} (status=${describeInterfaceReturnCode(returnStatus)})`);
        return returnStatus;
    }

    /**
     * Writes an entire universe to the interface
     * @param array Array of all DMX values with a length of 512
     */
    writeMap = (array: number[]): number => {
        if (array.length !== 512) {
            pipelineWarn("WRITE", `writeMap called with ${array.length} channels instead of 512 - dropping frame entirely`);
            return 4;
        }
        this.dmxout = array;
        this.write(undefined);
        return 0;
    }

}

export {EnttecProInterface};
