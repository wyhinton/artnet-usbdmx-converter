/**
 * Data structure containing a pair of a DMX channel and its value
 */
export interface DMXCommand {
    channel: number;
    value: number;
}

/**
 * Common surface implemented by every supported DMX interface driver, regardless of the
 * underlying transport (HID for {@link DMXInterface}, serial for {@link EnttecProInterface}).
 * {@link ConvertHandler} talks to whichever interface is open only through this contract.
 */
export interface IDMXInterface {
    path: string;
    serial: string;
    manufacturer: string | undefined;
    product: string | undefined;
    currentMode: number;

    /** When true, the interface prints trace messages for data it sends/receives */
    debug: boolean;

    usbdmxInputCallback: (start: number, values: number[]) => void;

    /** Closes the connection to the interface */
    close(): void;

    /** Sets the DMX mode of the interface, if the underlying protocol has such a concept */
    setMode(mode: number): number;

    /** Human-readable description of the interface's current mode, for display purposes */
    getModeDescription(): string;

    /** Writes DMX data to the interface */
    write(data: DMXCommand[] | undefined): number;

    /** Writes an entire universe (512 channels) to the interface */
    writeMap(array: number[]): number;
}
