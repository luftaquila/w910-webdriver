export const REPORT_ID = 0x06;
export const REPORT_SIZE = 41;
export const MAX_DATA = 32;
export const MAIN_RECORD_COUNT = 160;
export const SCROLL_RECORD_COUNT = 4;
export const ACTION_SIZE = 4;
export const MACRO_MAX_SIZE = 512;

export const BLE_SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb";
export const BLE_CHARACTERISTIC_UUID = "0000fff1-0000-1000-8000-00805f9b34fb";
export const BLE_MANUFACTURER_ID = 0x0006;
export const BLE_MANUFACTURER_PREFIX = Uint8Array.from([0x03, 0x00, 0x80]);

export const DEVICE_FILTERS = [
  { vendorId: 0x36a4, productId: 0x4100, usagePage: 0xff01, usage: 0x0001 },
  { vendorId: 0xb6a4, productId: 0x4100, usagePage: 0xff01, usage: 0x0001 },
  { vendorId: 0x36a4, productId: 0x4101, usagePage: 0xff01, usage: 0x0001 },
  { vendorId: 0xb6a4, productId: 0x4101, usagePage: 0xff01, usage: 0x0001 },
];

export const MAIN_CONTROLS = [
  { id: "key_esc", label: "Esc", index: 0 },
  { id: "key_x", label: "X", index: 1 },
  { id: "rgb_light_switch", label: "RGB light switch", index: 2 },
  { id: "key_b", label: "B", index: 8 },
  { id: "key_v", label: "V", index: 9 },
  { id: "mode_switch_press", label: "Dial press", index: 10 },
  { id: "key_c", label: "C", index: 16 },
  { id: "key_enter", label: "Enter", index: 17 },
  { id: "mode_switch_up", label: "Dial up", index: 18 },
  { id: "key_d", label: "D", index: 24 },
  { id: "key_left_shift", label: "Left Shift", index: 25 },
  { id: "mode_switch_down", label: "Dial down", index: 26 },
  { id: "key_e", label: "E", index: 32 },
  { id: "key_k", label: "K", index: 33 },
  { id: "mode_switch_left", label: "Dial left", index: 34 },
  { id: "key_tab", label: "Tab", index: 40 },
  { id: "key_r", label: "R", index: 41 },
  { id: "mode_switch_right", label: "Dial right", index: 42 },
];

export const SCROLL_CONTROLS = [
  { id: "scroll_up", label: "Scroll up", index: 0 },
  { id: "scroll_down", label: "Scroll down", index: 1 },
];

export const ALL_CONTROLS = [
  ...MAIN_CONTROLS.map((control) => ({ ...control, bank: "main" })),
  ...SCROLL_CONTROLS.map((control) => ({ ...control, bank: "scroll" })),
];

const hexKey = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

export function bytesFromHex(value, expectedLength = null) {
  const compact = value.replace(/[^0-9a-f]/gi, "");
  if (compact.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(compact)) {
    throw new Error("Hex data must contain complete bytes");
  }
  const bytes = Uint8Array.from(compact.match(/.{2}/g)?.map((item) => Number.parseInt(item, 16)) ?? []);
  if (expectedLength !== null && bytes.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} bytes, received ${bytes.length}`);
  }
  return bytes;
}

export function hexFromBytes(bytes, separator = " ") {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0").toUpperCase()).join(separator);
}

export function frameReport(command, sequence, selector = 0, address = 0, data = []) {
  if (data.length > MAX_DATA) throw new Error("Frame payload exceeds 32 bytes");
  const report = new Uint8Array(REPORT_SIZE);
  report.set([REPORT_ID, 0x00, 0x01, command & 0xff, sequence & 0xff, selector & 0xff]);
  report[6] = address & 0xff;
  report[7] = (address >>> 8) & 0xff;
  report[8] = data.length;
  report.set(data, 9);
  return report;
}

export function readRequest(command, sequence, selector = 0, address = 0, length = 0) {
  if (command < 0x80) throw new Error("Read commands must have bit 7 set");
  return frameReport(command, sequence, selector, address, new Uint8Array(length));
}

export function normalizeProtocolReport(view) {
  const source = ArrayBuffer.isView(view)
    ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    : new Uint8Array(view);
  if (source[0] === REPORT_ID && source.length >= 9 && source.length <= REPORT_SIZE) {
    const report = new Uint8Array(REPORT_SIZE);
    report.set(source);
    return report;
  }
  if (source.length !== REPORT_SIZE - 1) throw new Error(`Invalid W910 report length (${source.length} bytes)`);
  const report = new Uint8Array(REPORT_SIZE);
  report[0] = REPORT_ID;
  report.set(source, 1);
  return report;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class WebHIDTransport {
  constructor(device) {
    this.device = device;
    this.sequence = 0;
    this.kind = "usb";
  }

  get productName() { return this.device.productName || "W910 Macro Keyboard"; }

  get description() {
    return `${this.device.vendorId.toString(16).padStart(4, "0")}:${this.device.productId.toString(16).padStart(4, "0")} · WebHID`;
  }

  get transportName() { return "USB / 2.4 GHz · WebHID"; }

  static async request() {
    if (!("hid" in navigator)) {
      throw new Error("WebHID is unavailable. Use current Chrome or Edge over HTTPS or localhost.");
    }
    const devices = await navigator.hid.requestDevice({ filters: DEVICE_FILTERS });
    if (devices.length === 0) throw new Error("No W910 was selected");
    return new WebHIDTransport(devices[0]);
  }

  async open() {
    if (!this.device.opened) await this.device.open();
  }

  nextSequence() {
    this.sequence = (this.sequence + 1) & 0xff;
    return this.sequence;
  }

  async send(report, delayMs = 8) {
    await this.open();
    await this.device.sendFeatureReport(REPORT_ID, report.slice(1));
    if (delayMs > 0) await sleep(delayMs);
  }

  async write(command, selector = 0, address = 0, data = []) {
    const report = frameReport(command, this.nextSequence(), selector, address, data);
    await this.send(report);
  }

  async query(command, selector = 0, address = 0, length = 0) {
    const sequence = this.nextSequence();
    await this.send(readRequest(command, sequence, selector, address, length), 20);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = normalizeProtocolReport(await this.device.receiveFeatureReport(REPORT_ID));
      const responseLength = response[8];
      if (responseLength > 0 && responseLength <= MAX_DATA && response[3] === command && response[4] === sequence) {
        return response.slice(9, 9 + responseLength);
      }
      await sleep(20);
    }
    throw new Error(`No valid response for command 0x${command.toString(16)}`);
  }

  async close() {
    if (this.device.opened) await this.device.close();
  }
}

export function isW910BluetoothName(name) {
  return /^(?:SXS|YXT)-?W910(?:BT)?$/i.test((name ?? "").trim());
}

function bluetoothConnectionError(error) {
  if (error?.name === "NetworkError" && /unsupported device/i.test(error.message)) {
    return new Error("Wrong Bluetooth device. Start pairing and retry.");
  }
  if (error?.name === "NotFoundError") {
    return new Error("W910 not found. Start Bluetooth pairing and retry.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

let rememberedBluetoothDevice = null;

export class WebBluetoothTransport {
  constructor(device) {
    this.device = device;
    this.sequence = 0;
    this.kind = "bluetooth";
    this.server = null;
    this.characteristic = null;
    this.pendingResponses = new Map();
    this.closing = false;
    this.onDisconnect = null;
    this.handleNotification = this.handleNotification.bind(this);
    this.handleDisconnect = this.handleDisconnect.bind(this);
    this.device.addEventListener("gattserverdisconnected", this.handleDisconnect);
  }

  get productName() { return this.device.name || "SXS-W910BT"; }

  get description() { return "Bluetooth LE · Web Bluetooth"; }

  get transportName() { return "Bluetooth LE · Web Bluetooth"; }

  static async request() {
    if (!("bluetooth" in navigator)) {
      throw new Error("Web Bluetooth is unavailable. Use current Chrome or Edge over HTTPS or localhost.");
    }

    const candidates = rememberedBluetoothDevice ? [rememberedBluetoothDevice] : [];
    if (typeof navigator.bluetooth.getDevices === "function") {
      try {
        candidates.push(...await navigator.bluetooth.getDevices());
      } catch {
        // Fall back to an explicit chooser when stored permissions are unavailable.
      }
    }
    const attempted = new Set();
    for (const device of candidates.filter((item) => isW910BluetoothName(item.name))) {
      const identity = device.id || device;
      if (attempted.has(identity)) continue;
      attempted.add(identity);
      const transport = new WebBluetoothTransport(device);
      try {
        await transport.open();
        rememberedBluetoothDevice = device;
        return transport;
      } catch {
        await transport.close();
      }
    }

    let transport = null;
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{
          manufacturerData: [{
            companyIdentifier: BLE_MANUFACTURER_ID,
            dataPrefix: BLE_MANUFACTURER_PREFIX,
          }],
        }],
        optionalServices: [BLE_SERVICE_UUID],
      });
      transport = new WebBluetoothTransport(device);
      await transport.open();
      rememberedBluetoothDevice = device;
      return transport;
    } catch (error) {
      await transport?.close();
      throw bluetoothConnectionError(error);
    }
  }

  async open() {
    if (this.characteristic && this.device.gatt?.connected) return;
    if (!this.device.gatt) throw new Error("The selected Bluetooth entry does not provide GATT access");
    this.closing = false;
    this.device.removeEventListener("gattserverdisconnected", this.handleDisconnect);
    this.device.addEventListener("gattserverdisconnected", this.handleDisconnect);
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(BLE_SERVICE_UUID);
    this.characteristic = await service.getCharacteristic(BLE_CHARACTERISTIC_UUID);
    const properties = this.characteristic.properties;
    if ((!properties?.notify && !properties?.read) || !properties?.writeWithoutResponse) {
      throw new Error("The W910 BLE configuration characteristic has incompatible properties");
    }
    this.characteristic.addEventListener("characteristicvaluechanged", this.handleNotification);
    if (properties.notify) await this.characteristic.startNotifications();
  }

  nextSequence() {
    this.sequence = (this.sequence + 1) & 0xff;
    return this.sequence;
  }

  async send(report, delayMs = 8) {
    await this.open();
    if (report.length !== REPORT_SIZE) throw new Error(`W910 BLE writes must be ${REPORT_SIZE} bytes`);
    await this.characteristic.writeValueWithoutResponse(report);
    if (delayMs > 0) await sleep(delayMs);
  }

  waitForResponse(command, sequence, timeoutMs = 2500) {
    const key = `${command}:${sequence}`;
    if (this.pendingResponses.has(key)) throw new Error("Duplicate W910 BLE request sequence");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(key);
        reject(new Error(`No BLE response for command 0x${command.toString(16)}`));
      }, timeoutMs);
      this.pendingResponses.set(key, { resolve, reject, timer });
    });
  }

  handleNotification(event) {
    this.handleResponseValue(event.target.value);
  }

  handleResponseValue(value) {
    let report;
    try {
      report = normalizeProtocolReport(value);
    } catch {
      return;
    }
    const length = report[8];
    if (length === 0 || length > MAX_DATA) return;
    const key = `${report[3]}:${report[4]}`;
    const pending = this.pendingResponses.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingResponses.delete(key);
    pending.resolve(report.slice(9, 9 + length));
  }

  async write(command, selector = 0, address = 0, data = []) {
    await this.send(frameReport(command, this.nextSequence(), selector, address, data));
  }

  async query(command, selector = 0, address = 0, length = 0) {
    const sequence = this.nextSequence();
    const response = this.waitForResponse(command, sequence);
    try {
      await this.send(readRequest(command, sequence, selector, address, length), 0);
      if (this.characteristic.properties?.read) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const notified = await Promise.race([
            response.then((data) => ({ data })),
            sleep(25).then(() => null),
          ]);
          if (notified) return notified.data;
          try {
            this.handleResponseValue(await this.characteristic.readValue());
          } catch {
            // Notifications remain the primary response path.
          }
        }
      }
      return await response;
    } catch (error) {
      const key = `${command}:${sequence}`;
      const pending = this.pendingResponses.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingResponses.delete(key);
      }
      throw error;
    }
  }

  handleDisconnect() {
    this.device.removeEventListener("gattserverdisconnected", this.handleDisconnect);
    this.characteristic = null;
    this.server = null;
    for (const { reject, timer } of this.pendingResponses.values()) {
      clearTimeout(timer);
      reject(new Error("The W910 Bluetooth connection closed"));
    }
    this.pendingResponses.clear();
    if (!this.closing) this.onDisconnect?.();
  }

  async close() {
    this.closing = true;
    if (this.characteristic) {
      this.characteristic.removeEventListener("characteristicvaluechanged", this.handleNotification);
    }
    for (const { reject, timer } of this.pendingResponses.values()) {
      clearTimeout(timer);
      reject(new Error("The W910 Bluetooth connection closed"));
    }
    this.pendingResponses.clear();
    if (this.device.gatt?.connected) this.device.gatt.disconnect();
    this.device.removeEventListener("gattserverdisconnected", this.handleDisconnect);
    this.characteristic = null;
    this.server = null;
  }
}

function action(bytes, label, group = "General") {
  return { bytes: Uint8Array.from(bytes), label, group };
}

export const SPECIAL_ACTIONS = [
  action([0x00, 0x00, 0x00, 0x00], "No function"),
  action([0x0c, 0x01, 0x00, 0x00], "Fn layer", "Keyboard"),
  action([0x03, 0x01, 0x00, 0x00], "System power", "System"),
  action([0x03, 0x02, 0x00, 0x00], "Sleep", "System"),
  action([0x03, 0x04, 0x00, 0x00], "Wake", "System"),
  action([0x04, 0xea, 0x00, 0x00], "Volume down", "Media"),
  action([0x04, 0xe9, 0x00, 0x00], "Volume up", "Media"),
  action([0x04, 0xe2, 0x00, 0x00], "Mute", "Media"),
  action([0x04, 0xb6, 0x00, 0x00], "Previous track", "Media"),
  action([0x04, 0xb7, 0x00, 0x00], "Stop", "Media"),
  action([0x04, 0xb5, 0x00, 0x00], "Next track", "Media"),
  action([0x04, 0xcd, 0x00, 0x00], "Play / pause", "Media"),
  action([0x04, 0x83, 0x01, 0x00], "Media player", "Applications"),
  action([0x04, 0x8a, 0x01, 0x00], "Mail", "Applications"),
  action([0x04, 0x92, 0x01, 0x00], "Calculator", "Applications"),
  action([0x04, 0x94, 0x01, 0x00], "My computer", "Applications"),
  action([0x04, 0x21, 0x02, 0x00], "Web search", "Browser"),
  action([0x04, 0x23, 0x02, 0x00], "Browser / home", "Browser"),
  action([0x04, 0x24, 0x02, 0x00], "Web back", "Browser"),
  action([0x04, 0x25, 0x02, 0x00], "Web forward", "Browser"),
  action([0x04, 0x26, 0x02, 0x00], "Web stop", "Browser"),
  action([0x04, 0x27, 0x02, 0x00], "Web refresh", "Browser"),
  action([0x04, 0x2a, 0x02, 0x00], "Bookmarks", "Browser"),
  action([0x07, 0x01, 0x00, 0x00], "LED mode loop", "Lighting"),
  action([0x07, 0x02, 0x00, 0x00], "LED speed loop", "Lighting"),
  action([0x07, 0x02, 0x01, 0x00], "LED speed up", "Lighting"),
  action([0x07, 0x02, 0x02, 0x00], "LED speed down", "Lighting"),
  action([0x07, 0x03, 0x00, 0x00], "LED brightness loop", "Lighting"),
  action([0x07, 0x03, 0x01, 0x00], "LED brightness up", "Lighting"),
  action([0x07, 0x03, 0x02, 0x00], "LED brightness down", "Lighting"),
  action([0x07, 0x04, 0x00, 0x00], "LED on / off", "Lighting"),
  action([0x07, 0x06, 0x00, 0x00], "LED color loop", "Lighting"),
  action([0x09, 0x01, 0x00, 0x00], "Next profile", "Profiles"),
  action([0x09, 0x02, 0x00, 0x00], "Previous profile", "Profiles"),
  action([0x09, 0x03, 0x00, 0x00], "Profile loop", "Profiles"),
  action([0x09, 0x04, 0x00, 0x00], "Profile 1", "Profiles"),
  action([0x09, 0x04, 0x01, 0x00], "Profile 2", "Profiles"),
  action([0x0d, 0x01, 0x01, 0x00], "Lock Windows key", "Locks"),
  action([0x0d, 0x01, 0x02, 0x00], "Unlock Windows key", "Locks"),
  action([0x0d, 0x01, 0x03, 0x00], "Toggle Windows key lock", "Locks"),
  action([0x0d, 0x02, 0x01, 0x00], "Lock Alt+F4", "Locks"),
  action([0x0d, 0x02, 0x02, 0x00], "Unlock Alt+F4", "Locks"),
  action([0x0d, 0x02, 0x03, 0x00], "Toggle Alt+F4 lock", "Locks"),
  action([0x0d, 0x03, 0x01, 0x00], "Lock all keys", "Locks"),
  action([0x0d, 0x03, 0x02, 0x00], "Unlock all keys", "Locks"),
  action([0x0d, 0x03, 0x03, 0x00], "Toggle all-key lock", "Locks"),
  action([0x0e, 0x01, 0x00, 0x00], "Windows mode", "System"),
  action([0x0e, 0x02, 0x00, 0x00], "macOS mode", "System"),
  action([0x0e, 0x03, 0x00, 0x00], "Toggle Windows / macOS", "System"),
  action([0x05, 0x01, 0x00, 0x00], "Vertical wheel +", "Mouse"),
  action([0x05, 0x81, 0x00, 0x00], "Vertical wheel −", "Mouse"),
  action([0x0b, 0x01, 0x00, 0x00], "Horizontal wheel +", "Mouse"),
  action([0x0b, 0x81, 0x00, 0x00], "Horizontal wheel −", "Mouse"),
  action([0x04, 0x6f, 0x00, 0x00], "Display brightness down", "System"),
  action([0x04, 0x70, 0x00, 0x00], "Display brightness up", "System"),
];

const SPECIAL_BY_HEX = new Map(SPECIAL_ACTIONS.map((item) => [hexKey(item.bytes), item]));

export const KEYBOARD_USAGES = (() => {
  const result = [];
  for (let usage = 0x04; usage <= 0x1d; usage += 1) {
    result.push({ usage, label: String.fromCharCode(65 + usage - 0x04) });
  }
  "1234567890".split("").forEach((label, index) => result.push({ usage: 0x1e + index, label }));
  [
    [0x28, "Enter"], [0x29, "Escape"], [0x2a, "Backspace"], [0x2b, "Tab"],
    [0x2c, "Space"], [0x2d, "Minus"], [0x2e, "Equal"], [0x2f, "Left bracket"],
    [0x30, "Right bracket"], [0x31, "Backslash"], [0x32, "Non-US #"],
    [0x33, "Semicolon"], [0x34, "Quote"], [0x35, "Backquote"], [0x36, "Comma"],
    [0x37, "Period"], [0x38, "Slash"], [0x39, "Caps Lock"],
  ].forEach(([usage, label]) => result.push({ usage, label }));
  for (let usage = 0x3a; usage <= 0x45; usage += 1) result.push({ usage, label: `F${usage - 0x39}` });
  [
    [0x46, "Print Screen"], [0x47, "Scroll Lock"], [0x48, "Pause"], [0x49, "Insert"],
    [0x4a, "Home"], [0x4b, "Page Up"], [0x4c, "Delete"], [0x4d, "End"],
    [0x4e, "Page Down"], [0x4f, "Right Arrow"], [0x50, "Left Arrow"],
    [0x51, "Down Arrow"], [0x52, "Up Arrow"], [0x53, "Num Lock"],
    [0x54, "Numpad /"], [0x55, "Numpad *"], [0x56, "Numpad −"], [0x57, "Numpad +"],
    [0x58, "Numpad Enter"], [0x59, "Numpad 1"], [0x5a, "Numpad 2"], [0x5b, "Numpad 3"],
    [0x5c, "Numpad 4"], [0x5d, "Numpad 5"], [0x5e, "Numpad 6"], [0x5f, "Numpad 7"],
    [0x60, "Numpad 8"], [0x61, "Numpad 9"], [0x62, "Numpad 0"], [0x63, "Numpad ."],
    [0x65, "Application"], [0x66, "Keyboard Power"], [0x67, "Numpad ="],
  ].forEach(([usage, label]) => result.push({ usage, label }));
  for (let usage = 0x68; usage <= 0x73; usage += 1) result.push({ usage, label: `F${usage - 0x5b}` });
  [
    [0x74, "Execute"], [0x75, "Help"], [0x76, "Menu"], [0x77, "Select"],
    [0x78, "Stop"], [0x79, "Again"], [0x7a, "Undo"], [0x7b, "Cut"],
    [0x7c, "Copy"], [0x7d, "Paste"], [0x7e, "Find"],
    [0xe0, "Left Control"], [0xe1, "Left Shift"], [0xe2, "Left Alt"],
    [0xe3, "Left GUI"], [0xe4, "Right Control"], [0xe5, "Right Shift"],
    [0xe6, "Right Alt"], [0xe7, "Right GUI"],
  ].forEach(([usage, label]) => result.push({ usage, label }));
  return result;
})();

export const USAGE_NAMES = new Map(KEYBOARD_USAGES.map(({ usage, label }) => [usage, label]));

export function keyboardAction(usage) {
  if (!Number.isInteger(usage) || usage < 0 || usage > 0xfe) throw new Error("Keyboard usage must be 0x00..0xFE");
  return Uint8Array.from([0x02, usage, 0x00, 0x00]);
}

export function macroAction(slot, mode) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 0xff) throw new Error("Macro slot must be 0..255");
  if (![0, 1, 2].includes(mode)) throw new Error("Macro mode must be count, hold, or toggle");
  return Uint8Array.from([0x0a, mode, slot, 0x00]);
}

export function decodeAction(record) {
  if (record.length !== ACTION_SIZE) throw new Error("Action records are four bytes");
  if (record[0] === 0x02 && record[1] === 0 && record[2] === 0 && record[3] === 0) {
    return { kind: "special", label: "No function", bytes: Array.from(record) };
  }
  const special = SPECIAL_BY_HEX.get(hexKey(record));
  if (special) return { kind: "special", label: special.label, bytes: Array.from(record) };
  if (record[0] === 0x02 && record[2] === 0 && record[3] === 0) {
    return { kind: "keyboard", usage: record[1], label: USAGE_NAMES.get(record[1]) ?? `HID 0x${record[1].toString(16).padStart(2, "0").toUpperCase()}` };
  }
  if (record[0] === 0x04 && record[3] === 0) {
    const usage = record[1] | (record[2] << 8);
    return { kind: "consumer", usage, label: `Consumer 0x${usage.toString(16).toUpperCase()}` };
  }
  if (record[0] === 0x0a && [0, 1, 2].includes(record[1]) && record[3] === 0) {
    return { kind: "macro", mode: record[1], slot: record[2], label: `Macro ${record[2] + 1}` };
  }
  return { kind: "raw", value: hexFromBytes(record), label: hexFromBytes(record) };
}

function delay24(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) throw new Error("Macro delay exceeds 24 bits");
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

const MOUSE_BUTTON_TAGS = { left: 0xe8, right: 0xea, middle: 0xe9, back: 0xeb, forward: 0xec };
const TAG_MOUSE_BUTTONS = new Map(Object.entries(MOUSE_BUTTON_TAGS).map(([name, tag]) => [tag, name]));

function encodeButtonLike(tag, pressed, delay) {
  if (delay < 0x80) return [tag, delay | (pressed ? 0 : 0x80)];
  if (delay > 0x100007e) throw new Error("Macro button delay is too large");
  return [tag, pressed ? 0x7f : 0xff, 0xff, ...delay24(delay - 0x7f)];
}

export function encodeMacroEvent(event) {
  const delay = Number(event.delay ?? 0);
  if (!Number.isInteger(delay) || delay < 0) throw new Error("Macro delay must be a positive integer");
  if (event.type === "keyboard") {
    if (!Number.isInteger(event.usage) || event.usage < 0x04 || event.usage > 0xec) throw new Error("Macro keyboard usage must be 0x04..0xEC");
    return Uint8Array.from(encodeButtonLike(event.usage, Boolean(event.pressed), delay));
  }
  if (event.type === "mouse_button") {
    const tag = MOUSE_BUTTON_TAGS[event.button];
    if (tag === undefined) throw new Error("Unknown mouse button");
    return Uint8Array.from(encodeButtonLike(tag, Boolean(event.pressed), delay));
  }
  if (event.type === "wheel") {
    const value = Number(event.value);
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error("Wheel value must be 0..255");
    return Uint8Array.from(delay === 0 ? [0xfd, value] : [0xfd, value, 0xff, ...delay24(delay)]);
  }
  if (event.type === "move") {
    const x = Number(event.x);
    const y = Number(event.y);
    if (![x, y].every((value) => Number.isInteger(value) && value >= -0x8000 && value <= 0x7fff)) throw new Error("Mouse movement must fit signed 16 bits");
    if (delay > 0x10000fe) throw new Error("Mouse-move delay is too large");
    const xy = [x & 0xff, (x >> 8) & 0xff, y & 0xff, (y >> 8) & 0xff];
    return Uint8Array.from(delay < 0x100 ? [0xfe, delay, ...xy] : [0xfe, 0xff, ...xy, 0xff, ...delay24(delay - 0xff)]);
  }
  throw new Error(`Unknown macro event type: ${event.type}`);
}

export function encodeMacro(events, repeat = 1) {
  if (!Number.isInteger(repeat) || repeat < 0 || repeat > 0xffff) throw new Error("Macro repeat must be 0..65535");
  const payload = events.flatMap((event) => Array.from(encodeMacroEvent(event)));
  const stream = Uint8Array.from([repeat & 0xff, repeat >>> 8, payload.length & 0xff, payload.length >>> 8, ...payload]);
  if (stream.length > MACRO_MAX_SIZE) throw new Error("Macro exceeds the 512-byte device limit");
  return stream;
}

function uint24(data, offset) {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}

export function decodeMacro(stream) {
  if (stream.length < 4) throw new Error("Macro stream is shorter than its header");
  const repeat = stream[0] | (stream[1] << 8);
  const payloadLength = stream[2] | (stream[3] << 8);
  if (stream.length !== payloadLength + 4) throw new Error("Macro payload length does not match its header");
  const events = [];
  let offset = 4;
  while (offset < stream.length) {
    const tag = stream[offset];
    if (TAG_MOUSE_BUTTONS.has(tag) || (tag >= 0x04 && tag <= 0xec)) {
      if (offset + 2 > stream.length) throw new Error("Truncated macro button event");
      const stateDelay = stream[offset + 1];
      const long = [0x7f, 0xff].includes(stateDelay) && stream[offset + 2] === 0xff;
      if (long && offset + 6 > stream.length) throw new Error("Truncated long macro event");
      const pressed = long ? stateDelay === 0x7f : stateDelay < 0x80;
      const delay = long ? 0x7f + uint24(stream, offset + 3) : stateDelay & 0x7f;
      const button = TAG_MOUSE_BUTTONS.get(tag);
      events.push(button ? { type: "mouse_button", button, pressed, delay } : { type: "keyboard", usage: tag, pressed, delay });
      offset += long ? 6 : 2;
      continue;
    }
    if (tag === 0xfd) {
      if (offset + 2 > stream.length) throw new Error("Truncated wheel event");
      const long = stream[offset + 2] === 0xff;
      if (long && offset + 6 > stream.length) throw new Error("Truncated delayed wheel event");
      events.push({ type: "wheel", value: stream[offset + 1], delay: long ? uint24(stream, offset + 3) : 0 });
      offset += long ? 6 : 2;
      continue;
    }
    if (tag === 0xfe) {
      if (offset + 6 > stream.length) throw new Error("Truncated mouse-move event");
      let delay = stream[offset + 1];
      const x = new DataView(stream.buffer, stream.byteOffset + offset + 2, 2).getInt16(0, true);
      const y = new DataView(stream.buffer, stream.byteOffset + offset + 4, 2).getInt16(0, true);
      const long = delay === 0xff && stream[offset + 6] === 0xff;
      if (long && offset + 10 > stream.length) throw new Error("Truncated long mouse-move event");
      if (long) delay = 0xff + uint24(stream, offset + 7);
      events.push({ type: "move", x, y, delay });
      offset += long ? 10 : 6;
      continue;
    }
    throw new Error(`Unknown macro tag 0x${tag.toString(16).padStart(2, "0")}`);
  }
  return { repeat, events };
}

export const LED_MODES = [
  { code: 0x81, name: "Constant", controls: ["brightness", "color"], palette: "single" },
  { code: 0x82, name: "Flowing water", controls: ["brightness", "speed", "direction", "color"], palette: "multi" },
  { code: 0x83, name: "Horse race", controls: ["brightness", "speed", "direction"], palette: null },
  { code: 0x84, name: "Single-color breathing", controls: ["brightness", "speed", "color"], palette: "single" },
  { code: 0x85, name: "Cycle breathing", controls: ["brightness", "speed", "color"], palette: "multi" },
  { code: 0x86, name: "Tetris blocks", controls: ["brightness", "speed", "color"], palette: "multi" },
  { code: 0x87, name: "Neon", controls: ["brightness", "speed"], palette: null },
  { code: 0x88, name: "Ambilight", controls: ["brightness", "speed", "direction"], palette: null },
  { code: 0x89, name: "Off", controls: [], palette: null },
];

export const DEFAULT_COLORS = ["#FCFF00", "#0000FF", "#FFA500", "#00FF00", "#FF0000", "#00FFFF", "#800080"];

export function decodeLightingRecord(data) {
  if (data.length !== 25) throw new Error("Lighting records are 25 bytes");
  const colors = [];
  for (let offset = 4; offset < 25; offset += 3) {
    colors.push(`#${[data[offset + 1], data[offset], data[offset + 2]].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`);
  }
  return {
    speed: data[0],
    direction: data[1],
    brightness: 6 - data[2],
    enabled: Array.from({ length: 7 }, (_, index) => Boolean(data[3] & (1 << index))),
    colors,
  };
}

export function encodeLightingRecord(record) {
  const brightness = Number(record.brightness);
  if (!Number.isInteger(brightness) || brightness < 1 || brightness > 6) throw new Error("Brightness must be 1..6");
  if (record.colors.length !== 7 || record.enabled.length !== 7) throw new Error("Lighting requires seven colors");
  const data = new Uint8Array(25);
  data[0] = Number(record.speed);
  data[1] = Number(record.direction);
  data[2] = 6 - brightness;
  data[3] = record.enabled.reduce((mask, enabled, index) => mask | (enabled ? 1 << index : 0), 0);
  record.colors.forEach((color, index) => {
    const rgb = bytesFromHex(color, 3);
    data.set([rgb[1], rgb[0], rgb[2]], 4 + index * 3);
  });
  return data;
}

export function blankMainBank() {
  return Array.from({ length: MAIN_RECORD_COUNT }, () => [0x02, 0x00, 0x00, 0x00]);
}

export function blankScrollBank() {
  return Array.from({ length: SCROLL_RECORD_COUNT }, () => [0x02, 0x00, 0x00, 0x00]);
}

const DEFAULT_USAGE = new Map([
  ["key_esc", 0x29], ["key_x", 0x1b], ["key_b", 0x05], ["key_v", 0x19],
  ["key_c", 0x06], ["key_enter", 0x28], ["mode_switch_up", 0x52],
  ["key_d", 0x07], ["key_left_shift", 0xe1], ["mode_switch_down", 0x51],
  ["key_e", 0x08], ["key_k", 0x0e], ["mode_switch_left", 0x50],
  ["key_tab", 0x2b], ["key_r", 0x15], ["mode_switch_right", 0x4f],
]);

export function defaultProfile(slot = 0) {
  const normalMain = blankMainBank();
  const fnMain = blankMainBank();
  for (const control of MAIN_CONTROLS) {
    let record;
    if (control.id === "rgb_light_switch") record = SPECIAL_ACTIONS.find((item) => item.label === "LED mode loop").bytes;
    else if (control.id === "mode_switch_press") record = SPECIAL_ACTIONS.find((item) => item.label === "Profile loop").bytes;
    else record = keyboardAction(DEFAULT_USAGE.get(control.id) ?? 0);
    normalMain[control.index] = Array.from(record);
    fnMain[control.index] = Array.from(record);
  }
  fnMain[2] = [0x02, 0x00, 0x00, 0x00];
  fnMain[10] = [0x02, 0x00, 0x00, 0x00];
  fnMain[40] = [0x0e, 0x03, 0x00, 0x00];
  const normalScroll = blankScrollBank();
  const fnScroll = blankScrollBank();
  normalScroll[0] = [0x04, 0xe9, 0x00, 0x00];
  normalScroll[1] = [0x04, 0xea, 0x00, 0x00];
  fnScroll[0] = [0x04, 0xea, 0x00, 0x00];
  fnScroll[1] = [0x04, 0xe9, 0x00, 0x00];
  const records = {};
  for (let mode = 1; mode <= 8; mode += 1) {
    const enabled = Array(7).fill(true);
    if (mode === 1 || mode === 4) {
      enabled.fill(false);
      enabled[4] = true;
    }
    records[mode] = { speed: 3, direction: 0, brightness: 4, enabled, colors: [...DEFAULT_COLORS] };
  }
  return {
    format: "w910-profile-v1",
    slot,
    banks: { normal: { main: normalMain, scroll: normalScroll }, fn: { main: fnMain, scroll: fnScroll } },
    macros: {},
    lighting: { mode: 0x88, supportedBitmap: 0x01ff, records },
    sleepSeconds: 300,
    powerDownSeconds: 600,
    status: { present: 0, battery: 100, charging: true, identity: 0 },
  };
}

async function readBank(transport, command, selector, byteLength) {
  const bytes = new Uint8Array(byteLength);
  for (let address = 0; address < byteLength; address += MAX_DATA) {
    const length = Math.min(MAX_DATA, byteLength - address);
    const data = await transport.query(command, selector, address, length);
    if (data.length < length) throw new Error(`Short bank read at 0x${address.toString(16)}`);
    bytes.set(data.slice(0, length), address);
  }
  return Array.from({ length: byteLength / ACTION_SIZE }, (_, index) => Array.from(bytes.slice(index * ACTION_SIZE, index * ACTION_SIZE + ACTION_SIZE)));
}

async function readMacroStream(transport, slot) {
  const first = await transport.query(0x88, slot, 0, MAX_DATA);
  if (first.length < 4) throw new Error(`Macro slot ${slot} returned a short header`);
  const total = 4 + first[2] + (first[3] << 8);
  if (total > MACRO_MAX_SIZE) throw new Error(`Macro slot ${slot} reports ${total} bytes`);
  const stream = new Uint8Array(total);
  stream.set(first.slice(0, Math.min(total, first.length)), 0);
  for (let address = MAX_DATA; address < total; address += MAX_DATA) {
    const length = Math.min(MAX_DATA, total - address);
    stream.set((await transport.query(0x88, slot, address, length)).slice(0, length), address);
  }
  return stream;
}

export async function readActiveSlot(transport) {
  const data = await transport.query(0x82, 2, 0, 1);
  if (data[0] > 1) throw new Error(`Device reported invalid onboard slot ${data[0]}`);
  return data[0];
}

function asciiField(data) {
  const bytes = Array.from(data).slice(0, data.indexOf(0) >= 0 ? data.indexOf(0) : data.length);
  return String.fromCharCode(...bytes).trim() || null;
}

export async function readFirmwareInfo(transport) {
  const readAscii = async (command, selector, length) => {
    try {
      return asciiField(await transport.query(command, selector, 0, length));
    } catch {
      return null;
    }
  };
  return {
    firmwareVersion: await readAscii(0xf0, 1, 8),
    firmwareCustomId: await readAscii(0xf0, 2, 16),
    dongleFirmwareVersion: await readAscii(0xf1, 1, 8),
  };
}

export async function readProfile(transport, slot, onProgress = () => {}) {
  if (![0, 1].includes(slot)) throw new Error("W910 has onboard slots 0 and 1");
  onProgress("Selecting onboard profile");
  await transport.write(0x02, 2, 0, [slot]);
  await sleep(50);
  const profile = defaultProfile(slot);
  onProgress("Reading device status");
  const status = await transport.query(0x81, 0, 0, 3);
  profile.status = { present: status[0], battery: status[1] & 0x7f, charging: Boolean(status[1] & 0x80), identity: status[2] };
  Object.assign(profile.status, await readFirmwareInfo(transport));
  const sleepData = await transport.query(0x82, 3, 0, 2);
  const powerData = await transport.query(0x82, 4, 0, 2);
  profile.sleepSeconds = sleepData[0] | (sleepData[1] << 8);
  profile.powerDownSeconds = powerData[0] | (powerData[1] << 8);
  onProgress("Reading Normal layer");
  profile.banks.normal.main = await readBank(transport, 0x84, 0, MAIN_RECORD_COUNT * ACTION_SIZE);
  profile.banks.normal.scroll = await readBank(transport, 0x85, 0, SCROLL_RECORD_COUNT * ACTION_SIZE);
  onProgress("Reading Fn layer");
  profile.banks.fn.main = await readBank(transport, 0x84, 1, MAIN_RECORD_COUNT * ACTION_SIZE);
  profile.banks.fn.scroll = await readBank(transport, 0x85, 1, SCROLL_RECORD_COUNT * ACTION_SIZE);
  onProgress("Reading lighting modes");
  const header = await transport.query(0x89, 0, 0, 25);
  profile.lighting.mode = header[0];
  profile.lighting.supportedBitmap = header[1] | (header[2] << 8);
  for (let mode = 1; mode <= 8; mode += 1) {
    profile.lighting.records[mode] = decodeLightingRecord(await transport.query(0x89, 0, mode * 25, 25));
  }
  const macroSlots = new Set();
  for (const layer of ["normal", "fn"]) {
    for (const bank of ["main", "scroll"]) {
      for (const record of profile.banks[layer][bank]) if (record[0] === 0x0a) macroSlots.add(record[2]);
    }
  }
  profile.macros = {};
  let macroIndex = 0;
  for (const macroSlot of macroSlots) {
    macroIndex += 1;
    onProgress(`Reading macro ${macroIndex} of ${macroSlots.size}`);
    const stream = await readMacroStream(transport, macroSlot);
    profile.macros[macroSlot] = { ...decodeMacro(stream), raw: hexFromBytes(stream, "") };
  }
  onProgress("Read complete");
  return profile;
}

async function writeBank(transport, command, selector, records, individual = false) {
  const bytes = Uint8Array.from(records.flat());
  const step = individual ? ACTION_SIZE : MAX_DATA;
  for (let address = 0; address < bytes.length; address += step) {
    await transport.write(command, selector, address, bytes.slice(address, address + step));
  }
}

function assertReadback(expected, actual, label) {
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw new Error(`${label} readback did not match the value sent to the keyboard`);
  }
}

async function selectOnboardSlot(transport, slot) {
  if (![0, 1].includes(slot)) throw new Error("W910 has onboard slots 0 and 1");
  await transport.write(0x02, 2, 0, [slot]);
  await sleep(50);
}

function littleEndian16(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xffff) throw new Error("Value must fit uint16");
  return [number & 0xff, number >>> 8];
}

export async function writeProfile(transport, profile, onProgress = () => {}) {
  validateProfile(profile);
  onProgress("Selecting onboard profile");
  await transport.write(0x02, 2, 0, [profile.slot]);
  await sleep(50);
  const referencedMacros = new Set();
  for (const layer of ["normal", "fn"]) {
    for (const bank of ["main", "scroll"]) {
      for (const record of profile.banks[layer][bank]) if (record[0] === 0x0a) referencedMacros.add(record[2]);
    }
  }
  let macroIndex = 0;
  for (const slot of referencedMacros) {
    macroIndex += 1;
    const macro = profile.macros[slot];
    if (!macro) throw new Error(`Action references missing macro slot ${slot}`);
    onProgress(`Writing macro ${macroIndex} of ${referencedMacros.size}`);
    const stream = encodeMacro(macro.events, macro.repeat);
    for (let address = 0; address < stream.length; address += MAX_DATA) {
      await transport.write(0x08, slot, address, stream.slice(address, address + MAX_DATA));
    }
  }
  onProgress("Writing Fn scroll controls");
  await writeBank(transport, 0x05, 1, profile.banks.fn.scroll, true);
  onProgress("Writing Normal scroll controls");
  await writeBank(transport, 0x05, 0, profile.banks.normal.scroll, true);
  onProgress("Writing Normal layer");
  await writeBank(transport, 0x04, 0, profile.banks.normal.main);
  onProgress("Writing Fn layer");
  await writeBank(transport, 0x04, 1, profile.banks.fn.main);
  onProgress("Writing lighting modes");
  const header = new Uint8Array(25);
  header[0] = profile.lighting.mode;
  header[1] = profile.lighting.supportedBitmap & 0xff;
  header[2] = profile.lighting.supportedBitmap >>> 8;
  await transport.write(0x09, 0, 0, header);
  for (let mode = 1; mode <= 8; mode += 1) {
    await transport.write(0x09, 0, mode * 25, encodeLightingRecord(profile.lighting.records[mode]));
  }
  onProgress("Writing power settings");
  await transport.write(0x02, 3, 0, littleEndian16(profile.sleepSeconds));
  await transport.write(0x02, 4, 0, littleEndian16(profile.powerDownSeconds));
  onProgress("Write complete");
}

export async function writeControlSetting(transport, profile, layer, control) {
  validateProfile(profile);
  if (!["normal", "fn"].includes(layer)) throw new Error("Unknown W910 layer");
  if (!control || !["main", "scroll"].includes(control.bank)) throw new Error("Unknown W910 control bank");
  const record = Uint8Array.from(getControlRecord(profile, layer, control));
  if (record.length !== ACTION_SIZE) throw new Error("Action records are four bytes");
  await selectOnboardSlot(transport, profile.slot);

  if (record[0] === 0x0a) {
    const macro = profile.macros[record[2]];
    if (!macro) throw new Error(`Action references missing macro slot ${record[2]}`);
    const stream = encodeMacro(macro.events, macro.repeat);
    for (let address = 0; address < stream.length; address += MAX_DATA) {
      await transport.write(0x08, record[2], address, stream.slice(address, address + MAX_DATA));
    }
    assertReadback(stream, await readMacroStream(transport, record[2]), `${control.label} macro`);
  }

  const command = control.bank === "main" ? 0x04 : 0x05;
  const selector = layer === "normal" ? 0 : 1;
  const address = control.index * ACTION_SIZE;
  await transport.write(command, selector, address, record);
  assertReadback(record, await transport.query(command | 0x80, selector, address, ACTION_SIZE), `${control.label} assignment`);
}

export async function writeLightingSelection(transport, profile) {
  validateProfile(profile);
  await selectOnboardSlot(transport, profile.slot);
  const header = new Uint8Array(25);
  header[0] = profile.lighting.mode;
  header[1] = profile.lighting.supportedBitmap & 0xff;
  header[2] = profile.lighting.supportedBitmap >>> 8;
  await transport.write(0x09, 0, 0, header);
  assertReadback(header, await transport.query(0x89, 0, 0, header.length), "Lighting effect");
  const mode = profile.lighting.mode & 0x3f;
  if (mode >= 1 && mode <= 8) {
    const record = encodeLightingRecord(profile.lighting.records[mode]);
    await transport.write(0x09, 0, mode * 25, record);
    assertReadback(record, await transport.query(0x89, 0, mode * 25, record.length), "Lighting settings");
  }
}

export async function writeLightingSetting(transport, profile, mode = profile.lighting.mode & 0x3f) {
  validateProfile(profile);
  if (!Number.isInteger(mode) || mode < 1 || mode > 8) throw new Error("Lighting detail mode must be 1 through 8");
  await selectOnboardSlot(transport, profile.slot);
  const header = new Uint8Array(25);
  header[0] = profile.lighting.mode;
  header[1] = profile.lighting.supportedBitmap & 0xff;
  header[2] = profile.lighting.supportedBitmap >>> 8;
  await transport.write(0x09, 0, 0, header);
  assertReadback(header, await transport.query(0x89, 0, 0, header.length), "Lighting effect");
  const address = mode * 25;
  const record = encodeLightingRecord(profile.lighting.records[mode]);
  await transport.write(0x09, 0, address, record);
  assertReadback(record, await transport.query(0x89, 0, address, record.length), "Lighting settings");
}

export async function writePowerSetting(transport, profile, field) {
  validateProfile(profile);
  const selector = { sleepSeconds: 3, powerDownSeconds: 4 }[field];
  if (!selector) throw new Error("Unknown W910 power setting");
  await selectOnboardSlot(transport, profile.slot);
  const value = Uint8Array.from(littleEndian16(profile[field]));
  await transport.write(0x02, selector, 0, value);
  assertReadback(value, await transport.query(0x82, selector, 0, value.length), field === "sleepSeconds" ? "Sleep timeout" : "Power-down timeout");
}

export function macroSlotFor(profile, layer, control) {
  if (!["normal", "fn"].includes(layer)) throw new Error("Unknown W910 layer");
  if (!ALL_CONTROLS.some((item) => item.id === control.id && item.bank === control.bank && item.index === control.index)) {
    throw new Error("Unknown W910 control");
  }
  const used = new Set();
  for (const otherLayer of ["normal", "fn"]) {
    for (const bank of ["main", "scroll"]) {
      profile.banks[otherLayer][bank].forEach((record, index) => {
        if (otherLayer === layer && bank === control.bank && index === control.index) return;
        if (record[0] === 0x0a) used.add(record[2]);
      });
    }
  }
  // The selector is one byte, but that does not establish device capacity.
  // Keep allocations compact instead of assigning a slot by physical key order.
  for (let slot = 0; slot <= 0xff; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  throw new Error("No free macro slot; remove an existing macro assignment first");
}

export function getControlRecord(profile, layer, control) {
  return profile.banks[layer][control.bank][control.index];
}

export function setControlRecord(profile, layer, control, record) {
  if (record.length !== ACTION_SIZE) throw new Error("Action records are four bytes");
  const previous = getControlRecord(profile, layer, control);
  profile.banks[layer][control.bank][control.index] = Array.from(record);
  if (previous[0] === 0x0a && !["normal", "fn"].some((name) =>
    ["main", "scroll"].some((bank) => profile.banks[name][bank].some((action) => action[0] === 0x0a && action[2] === previous[2])))) {
    delete profile.macros[previous[2]];
  }
}

export function validateProfile(profile) {
  if (profile?.format !== "w910-profile-v1") throw new Error("Not a W910 WebDriver profile");
  if (![0, 1].includes(profile.slot)) throw new Error("Profile slot must be 0 or 1");
  const referencedMacros = new Set();
  for (const layer of ["normal", "fn"]) {
    if (profile.banks?.[layer]?.main?.length !== MAIN_RECORD_COUNT) throw new Error(`${layer} main bank must contain 160 records`);
    if (profile.banks?.[layer]?.scroll?.length !== SCROLL_RECORD_COUNT) throw new Error(`${layer} scroll bank must contain four records`);
    for (const record of [...profile.banks[layer].main, ...profile.banks[layer].scroll]) {
      if (!Array.isArray(record) || record.length !== ACTION_SIZE || record.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error("Invalid action record");
      if (record[0] === 0x0a && [0, 1, 2].includes(record[1]) && record[3] === 0) referencedMacros.add(String(record[2]));
    }
  }
  if (!profile.macros || Array.isArray(profile.macros) || typeof profile.macros !== "object") throw new Error("Profile macros must be an object");
  for (const [slot, macro] of Object.entries(profile.macros)) {
    const slotNumber = Number(slot);
    if (!Number.isInteger(slotNumber) || slotNumber < 0 || slotNumber > 0xff || String(slotNumber) !== slot) throw new Error(`Invalid macro slot ${slot}`);
    if (!macro || !Array.isArray(macro.events)) throw new Error(`Macro slot ${slot} has no event list`);
    encodeMacro(macro.events, macro.repeat);
  }
  for (const slot of referencedMacros) {
    if (!Object.hasOwn(profile.macros, slot)) throw new Error(`Action references missing macro slot ${slot}`);
  }
  if (!LED_MODES.some((mode) => mode.code === profile.lighting?.mode)) throw new Error("Unknown lighting mode");
  for (let mode = 1; mode <= 8; mode += 1) encodeLightingRecord(profile.lighting.records[mode]);
  littleEndian16(profile.sleepSeconds);
  littleEndian16(profile.powerDownSeconds);
  return profile;
}

export function cloneProfile(profile) {
  return structuredClone(profile);
}

export function profilesEqual(expected, actual) {
  const select = (profile) => ({
    slot: profile.slot,
    banks: profile.banks,
    macros: Object.fromEntries(Object.entries(profile.macros).map(([slot, macro]) => [slot, { repeat: macro.repeat, events: macro.events }])),
    lighting: profile.lighting,
    sleepSeconds: profile.sleepSeconds,
    powerDownSeconds: profile.powerDownSeconds,
  });
  return JSON.stringify(select(expected)) === JSON.stringify(select(actual));
}
