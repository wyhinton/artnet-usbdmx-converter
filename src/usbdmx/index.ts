import HID from "node-hid";
import {SerialPort} from "serialport";

/**
 * Array of HID interfaces compatible with this program
 */
const DMX_INTERFACES: HIDObject[] = [
    // Digital Enlightenment USB-DMX Interface
    {vendorId: 0x4B4, productId: 0xF1F},
    // FX5 DMX Interface
    {vendorId: 0x16C0, productId: 0x88B},
    // DMXControl Projects e.V. Nodle U1
    {vendorId: 0x16D0, productId: 0x0830},
    // DMXControl Projects e.V. Nodle R4S
    {vendorId: 0x16D0, productId: 0x0833}
]

/**
 * Array of serial (FTDI) interfaces speaking the ENTTEC DMX USB PRO protocol.
 * This also covers DMXKing widgets, which implement the same open API for compatibility.
 */
const ENTTEC_SERIAL_INTERFACES: HIDObject[] = [
    // FTDI FT245/FT232-based ENTTEC DMX USB PRO (and compatible widgets, e.g. DMXKing)
    {vendorId: 0x0403, productId: 0x6001}
]

/**
 * Which physical/protocol layer an interface communicates over
 */
export type InterfaceProtocol = "hid" | "enttec-serial";

/**
 * A data structure for a connected interface
 */
export interface DetectedInterface {
    vid: number,
    pid: number,
    path: string,
    serial: string,
    manufacturer: string | undefined,
    product: string | undefined,
    protocol: InterfaceProtocol
}

/**
 * Gets all HID interfaces that are defined in {@link DMX_INTERFACES} and connected
 */
const getConnectedHIDInterfaces = (): DetectedInterface[] => {
    const _interfaces: DetectedInterface[] = [];
    const _connectedHIDDevices = HID.devices();
    for (const _device of _connectedHIDDevices) {
        // check for first VID + PID combo
        if (DMX_INTERFACES.find(e => e.vendorId == _device.vendorId && e.productId == _device.productId) != undefined) {
            _interfaces.push({
                vid: _device.vendorId,
                pid: _device.productId,
                path: _device.path!,
                serial: _device.serialNumber ?? "0000000000000000",
                manufacturer: _device.manufacturer,
                product: _device.product,
                protocol: "hid"
            })
        }
    }
    return _interfaces;
}

/**
 * Gets all serial interfaces that are defined in {@link ENTTEC_SERIAL_INTERFACES} and connected
 */
const getConnectedSerialInterfaces = async (): Promise<DetectedInterface[]> => {
    const _interfaces: DetectedInterface[] = [];
    const _connectedSerialDevices = await SerialPort.list();
    for (const _device of _connectedSerialDevices) {
        if (_device.vendorId === undefined || _device.productId === undefined) continue;
        const vid = parseInt(_device.vendorId, 16);
        const pid = parseInt(_device.productId, 16);
        if (ENTTEC_SERIAL_INTERFACES.find(e => e.vendorId === vid && e.productId === pid) != undefined) {
            _interfaces.push({
                vid,
                pid,
                path: _device.path,
                serial: _device.serialNumber ?? "0000000000000000",
                manufacturer: _device.manufacturer,
                product: "USB DMX PRO (Enttec protocol)",
                protocol: "enttec-serial"
            })
        }
    }
    return _interfaces;
}

/**
 * Gets all interfaces (HID and serial) that this program supports and are connected
 */
const getConnectedInterfaces = async (): Promise<DetectedInterface[]> => {
    const _hidInterfaces = getConnectedHIDInterfaces();
    const _serialInterfaces = await getConnectedSerialInterfaces();
    return _hidInterfaces.concat(_serialInterfaces);
}

/**
 * Data structure for a single HID object
 */
interface HIDObject {
    vendorId: number;
    productId: number;
}

export * from "./DMXInterface";
export * from "./EnttecProInterface";
export * from "./IDMXInterface";
export {getConnectedInterfaces}