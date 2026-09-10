import {
  ALL_CONTROLS,
  bytesFromHex,
  cloneProfile,
  decodeAction,
  defaultProfile,
  encodeMacro,
  getControlRecord,
  hexFromBytes,
  KEYBOARD_USAGES,
  LED_MODES,
  macroAction,
  macroSlotFor,
  profilesEqual,
  readActiveSlot,
  readProfile,
  setControlRecord,
  SPECIAL_ACTIONS,
  USAGE_NAMES,
  validateProfile,
  WebBluetoothTransport,
  WebHIDTransport,
  writeControlSetting,
  writeLightingSelection,
  writeLightingSetting,
  writePowerSetting,
  writeProfile,
  keyboardAction,
} from "./protocol.js";
import { appendTimedMacroEvent } from "./macro-recording.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const pageTitles = {
  mapping: "Key mapping",
  lighting: "Lighting",
  device: "Device",
  backups: "Backups",
};

const state = {
  transport: null,
  profile: defaultProfile(0),
  connected: false,
  busy: false,
  busyKind: null,
  busyMessage: "",
  dirty: false,
  layer: "normal",
  page: "mapping",
  editing: null,
  revision: 0,
  savedRevision: 0,
  pendingWrites: 0,
  saveError: null,
  saveState: "idle",
  writeQueue: Promise.resolve(),
  scheduledWrites: new Map(),
};

const macroRecorder = {
  active: false,
  lastTimestamp: null,
  pressedKeys: new Set(),
  pressedButtons: new Set(),
  handlers: null,
};

function toast(title, message = "", error = false) {
  const element = document.createElement("div");
  element.className = `toast${error ? " error" : ""}`;
  element.innerHTML = `<strong></strong><span></span>`;
  $("strong", element).textContent = title;
  $("span", element).textContent = message;
  $("#toastRegion").append(element);
  setTimeout(() => element.remove(), error ? 7000 : 4200);
}

function setBusy(busy, message = "Working…", kind = "reading") {
  state.busy = busy;
  state.busyKind = busy ? kind : null;
  state.busyMessage = busy ? message : "";
  updateConnectionUI();
}

function updateProgress(message) {
  state.busyMessage = message;
  updateConnectionUI();
}

function updateConnectionUI() {
  const badge = $("#connectionBadge");
  badge.classList.toggle("online", state.connected);
  badge.classList.toggle("offline", !state.connected);
  badge.innerHTML = `<span></span>${state.connected ? "Connected" : "Disconnected"}`;
  $("#connectHidButton").textContent = "USB / 2.4 GHz";
  $("#connectHidButton").disabled = state.busy;
  $("#connectBluetoothButton").disabled = state.busy;
  $("#readButton").disabled = !state.connected || state.busy;
  $("#readButton").textContent = "Reload";
  const progress = $("#progressBar");
  const retryable = !state.busy && state.connected && state.saveState === "error" && state.dirty;
  const progressState = state.busy ? "pending"
    : !state.connected ? "offline"
      : state.saveState === "error" ? "error"
        : state.saveState === "saving" ? "pending"
          : state.saveState === "saved" ? "saved" : "ready";
  const progressMessage = state.busy ? state.busyMessage
    : !state.connected ? "Offline"
      : state.saveState === "error" ? retryable ? "Save failed · Retry" : "Save failed"
        : state.saveState === "saving" ? "Saving changes…"
          : state.saveState === "saved" ? "Saved" : "Ready";
  ["offline", "ready", "pending", "saved", "error"].forEach((name) => {
    progress.classList.toggle(`status-${name}`, progressState === name);
  });
  $("p", progress).textContent = progressMessage;
  progress.disabled = !retryable;
  progress.title = retryable ? "Retry saving" : "";
  $$("[data-slot]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.slot) === state.profile.slot);
    button.disabled = !state.connected || state.busy;
  });
  const configurationDisabled = !state.connected || state.busy;
  document.body.classList.toggle("configuration-locked", !state.connected);
  const configurationControls = [
    ...$$("[data-layer]"),
    ...$$("#keyboardGrid button"),
    ...$$("#lightingPage input, #lightingPage select, #lightingPage button"),
    ...$$("#devicePage input, #devicePage select, #devicePage button"),
    $("#importButton"), $("#resetButton"), $("#importFile"),
    ...$$("#snapshotList [data-load]"),
  ].filter(Boolean);
  configurationControls.forEach((control) => { control.disabled = configurationDisabled; });
  const lightingStatus = $("#lightingApplyStatus");
  if (lightingStatus) {
    if (!state.connected) lightingStatus.textContent = "Connect to edit";
    else if (state.pendingWrites > 0) lightingStatus.textContent = "Applying…";
    else if (state.saveError) lightingStatus.textContent = "Apply failed";
    else lightingStatus.textContent = "Applied";
  }
}

function markDirty() {
  state.revision += 1;
  state.dirty = true;
  state.saveState = "saving";
  updateConnectionUI();
  return state.revision;
}

function setProfile(profile, { dirty = false, preserveSaveState = false } = {}) {
  state.profile = validateProfile(profile);
  state.dirty = dirty;
  state.saveError = null;
  if (!preserveSaveState) state.saveState = dirty ? "saving" : "idle";
  if (dirty) {
    state.revision += 1;
    state.savedRevision = state.revision - 1;
  } else {
    state.revision = 0;
    state.savedRevision = 0;
  }
  renderAll();
}

function enqueueDeviceWrite(label, operation) {
  if (!state.connected) return Promise.resolve(false);
  const revision = state.revision;
  state.pendingWrites += 1;
  state.saveState = "saving";
  updateConnectionUI();
  const queued = state.writeQueue.catch(() => {}).then(async () => {
    try {
      if (!state.connected || !state.transport) throw new Error("The keyboard disconnected before the change could be saved");
      await operation();
      state.savedRevision = Math.max(state.savedRevision, revision);
      if (!state.saveError && state.savedRevision >= state.revision) state.dirty = false;
      return true;
    } catch (error) {
      state.saveError = error;
      state.saveState = "error";
      state.dirty = true;
      toast("Could not save change", `${label}: ${error.message}`, true);
      return false;
    } finally {
      state.pendingWrites -= 1;
      if (state.saveError) state.saveState = "error";
      else if (state.pendingWrites === 0 && state.scheduledWrites.size === 0 && !state.dirty) state.saveState = "saved";
      updateConnectionUI();
    }
  });
  state.writeQueue = queued;
  return queued;
}

function scheduleDeviceWrite(key, label, operation, delay = 180) {
  if (!state.connected) {
    updateConnectionUI();
    return;
  }
  const previous = state.scheduledWrites.get(key);
  if (previous) clearTimeout(previous.timer);
  const fire = () => {
    state.scheduledWrites.delete(key);
    enqueueDeviceWrite(label, operation);
    updateConnectionUI();
  };
  const timer = setTimeout(fire, delay);
  state.scheduledWrites.set(key, { timer, fire });
  updateConnectionUI();
}

async function flushPendingWrites() {
  const scheduled = Array.from(state.scheduledWrites.values());
  for (const item of scheduled) {
    clearTimeout(item.timer);
    item.fire();
  }
  await state.writeQueue;
}

function showPage(name) {
  state.page = name;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === name));
  $$(".page").forEach((page) => page.classList.toggle("active", page.id === `${name}Page`));
  $("#pageTitle").textContent = pageTitles[name];
}

function actionClass(decoded) {
  return ["keyboard", "special", "macro", "raw", "consumer"].includes(decoded.kind) ? decoded.kind : "raw";
}

const PHYSICAL_KEYS = [
  ["key_esc", "esc", "1 / 1 / 2 / 5"], ["key_b", "b", "1 / 5 / 2 / 9"],
  ["key_c", "c", "1 / 9 / 2 / 13"], ["key_d", "d", "1 / 13 / 2 / 17"],
  ["key_e", "e", "1 / 17 / 2 / 21"],
  ["key_tab", "tab", "2 / 1 / 3 / 7"], ["key_x", "x", "2 / 7 / 3 / 11"],
  ["key_v", "v", "2 / 11 / 3 / 15"],
  ["key_left_shift", "shift", "3 / 1 / 4 / 8"], ["key_k", "k", "3 / 8 / 4 / 12"],
  ["key_r", "r", "3 / 12 / 4 / 16"], ["key_enter", "enter", "2 / 15 / 4 / 21"],
];

const ENTER_KEYCAP_PATH = "M 10 0.5 H 140 Q 149.5 0.5 149.5 10 V 189.5 Q 149.5 199.5 139.5 199.5 H 38 Q 28 199.5 28 189.5 V 98.75 Q 28 89.75 19 89.75 H 10 Q 0.5 89.75 0.5 80.25 V 10 Q 0.5 0.5 10 0.5 Z";
const KEYCAP_WIDTHS = { esc: 100, b: 100, c: 100, d: 100, e: 100, tab: 150, x: 100, v: 100, shift: 175, k: 100, r: 100 };

function physicalKeycapShape(area, className) {
  if (area === "enter") {
    return `<svg class="${className}" viewBox="0 0 150 200" preserveAspectRatio="none" aria-hidden="true"><path class="keycap-surface" d="${ENTER_KEYCAP_PATH}" /></svg>`;
  }
  const width = KEYCAP_WIDTHS[area];
  return `<svg class="${className}" viewBox="0 0 ${width} 100" preserveAspectRatio="none" aria-hidden="true"><rect class="keycap-surface" x="0.5" y="0.5" width="${width - 1}" height="99" rx="9" /></svg>`;
}

function controlById(id) {
  return ALL_CONTROLS.find((control) => control.id === id);
}

function createControlButton(control, className = "", physicalLabel = control.label) {
  const record = Uint8Array.from(getControlRecord(state.profile, state.layer, control));
  const decoded = decodeAction(record);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `key-control kind-${actionClass(decoded)} ${className}`.trim();
  button.classList.toggle("long-action", decoded.label.length > 14);
  button.dataset.control = control.id;
  button.dataset.bank = control.bank;
  const physicalArea = className.includes("physical-key") ? className.match(/(?:^|\s)key-([^\s]+)/)?.[1] : null;
  button.innerHTML = `${physicalArea ? physicalKeycapShape(physicalArea, "keycap-shape") : ""}<span class="physical-label"></span><strong></strong>`;
  $(".physical-label", button).textContent = physicalLabel;
  $("strong", button).textContent = decoded.label;
  button.title = `${control.label}: ${decoded.label}`;
  button.setAttribute("aria-label", `${control.label}, assigned to ${decoded.label}`);
  button.addEventListener("click", () => openActionDialog(control));
  return button;
}

function renderMapping() {
  const grid = $("#keyboardGrid");
  grid.replaceChildren();
  const board = document.createElement("div");
  board.className = "w910-board";
  const deck = document.createElement("div");
  deck.className = "w910-key-deck";
  for (const [id, area, placement] of PHYSICAL_KEYS) {
    const button = createControlButton(controlById(id), `physical-key key-${area}`);
    button.style.gridArea = placement;
    deck.append(button);
  }

  const modePad = document.createElement("div");
  modePad.className = "mode-pad";
  modePad.setAttribute("aria-label", "Five-way mode switch");
  const modeControls = [
    ["mode_switch_up", "mode-up", "↑"],
    ["mode_switch_left", "mode-left", "←"],
    ["mode_switch_press", "mode-press", "●"],
    ["mode_switch_right", "mode-right", "→"],
    ["mode_switch_down", "mode-down", "↓"],
  ];
  for (const [id, className, glyph] of modeControls) {
    modePad.append(createControlButton(controlById(id), `mode-control ${className}`, glyph));
  }
  const rail = document.createElement("div");
  rail.className = "w910-control-rail";
  const wheel = document.createElement("div");
  wheel.className = "scroll-wheel";
  wheel.append(createControlButton(controlById("scroll_up"), "scroll-control scroll-up", "↑"));
  wheel.append(createControlButton(controlById("scroll_down"), "scroll-control scroll-down", "↓"));
  rail.append(modePad, wheel);

  board.append(deck, rail);
  const backControls = document.createElement("div");
  backControls.className = "back-controls";
  backControls.innerHTML = `
    <span class="back-device" aria-hidden="true"><i></i></span>
    <span class="back-control-label"><small>Bottom control</small><strong>RGB light switch</strong></span>`;
  backControls.append(createControlButton(controlById("rgb_light_switch"), "back-control-action", "Assigned action"));
  grid.append(board, backControls);

  const counts = { keyboard: 0, special: 0, macro: 0, advanced: 0 };
  const physicalControls = ALL_CONTROLS;
  for (const control of physicalControls) {
    const kind = decodeAction(Uint8Array.from(getControlRecord(state.profile, state.layer, control))).kind;
    if (kind === "keyboard") counts.keyboard += 1;
    else if (kind === "macro") counts.macro += 1;
    else if (kind === "special") counts.special += 1;
    else counts.advanced += 1;
  }
  const summary = $("#mappingSummary");
  summary.innerHTML = [
    ["Keyboard", counts.keyboard], ["Commands", counts.special],
    ["Macros", counts.macro], ["Advanced", counts.advanced],
  ].map(([label, count]) => `<div class="summary-row"><span>${label}</span><strong>${count}</strong></div>`).join("") +
    `<div class="summary-total"><span>Inputs</span><strong>${physicalControls.length}</strong></div>`;
  $$("[data-layer]").forEach((button) => button.classList.toggle("active", button.dataset.layer === state.layer));
}

function currentLightingRecord() {
  const mode = state.profile.lighting.mode & 0x3f;
  return mode >= 1 && mode <= 8 ? state.profile.lighting.records[mode] : null;
}

function renderLighting() {
  const mode = LED_MODES.find((item) => item.code === state.profile.lighting.mode) ?? LED_MODES[0];
  $("#lightingMode").value = String(mode.code);
  const record = currentLightingRecord();
  $("#lightingDetailControls").classList.toggle("hidden", !record);
  $("#lightingOffMessage").classList.toggle("hidden", Boolean(record));
  if (!record) {
    return;
  }
  $("#brightness").value = record.brightness;
  $("#brightnessValue").textContent = `${record.brightness} / 6`;
  $("#speed").value = record.speed;
  $("#speedValue").textContent = `${record.speed} / 7`;
  $("#direction").value = record.direction;
  for (const [fieldId, control] of [["brightnessField", "brightness"], ["speedField", "speed"], ["directionField", "direction"], ["colorField", "color"]]) {
    $(`#${fieldId}`).classList.toggle("hidden", !mode.controls.includes(control));
  }
  $("#colorFieldLabel").textContent = mode.palette === "single" ? "Color" : "Palette";
  const palette = $("#colorPalette");
  palette.classList.toggle("single-color", mode.palette === "single");
  palette.replaceChildren();
  const selectedSingleIndex = Math.max(0, record.enabled.findIndex(Boolean));
  const colorIndexes = mode.palette === "single" ? [selectedSingleIndex] : mode.palette === "multi" ? [0, 1, 2, 3, 4, 5, 6] : [];
  colorIndexes.forEach((index) => {
    const color = record.colors[index];
    const chip = document.createElement("label");
    const canDisable = mode.palette === "multi";
    chip.className = `color-chip${canDisable && !record.enabled[index] ? " disabled" : ""}`;
    chip.title = `Color ${index + 1}`;
    chip.innerHTML = `<input type="color" data-color-index="${index}" aria-label="Color ${index + 1}">${canDisable ? `<input type="checkbox" data-color-enabled="${index}" aria-label="Enable color ${index + 1}">` : ""}`;
    $("input[type=color]", chip).value = color;
    if (canDisable) $("input[type=checkbox]", chip).checked = record.enabled[index];
    palette.append(chip);
  });
}

function renderDevice() {
  const status = state.profile.status;
  $("#batteryText").textContent = state.connected ? `${status.battery}%` : "—";
  $("#batteryFill").style.width = state.connected ? `${status.battery}%` : "0%";
  $("#chargingText").textContent = state.connected ? status.charging ? "Charging" : "On battery" : "Not connected";
  $("#transportText").textContent = state.connected ? state.transport.transportName : "—";
  $("#firmwareVersionText").textContent = state.connected ? status.firmwareVersion ?? "Not reported" : "—";
  $("#firmwareCustomText").textContent = state.connected ? status.firmwareCustomId ?? "Not reported" : "—";
  $("#dongleFirmwareText").textContent = state.connected ? status.dongleFirmwareVersion ?? "Not reported" : "—";
  $("#identityText").textContent = state.connected ? `0x${status.identity.toString(16).padStart(2, "0").toUpperCase()}` : "—";
  $("#sleepSeconds").value = state.profile.sleepSeconds;
  $("#powerDownSeconds").value = state.profile.powerDownSeconds;
}

const SNAPSHOT_KEY = "w910-webdriver-snapshots-v1";
const LEGACY_SNAPSHOT_KEY = "w910-studio-snapshots-v1";

function readSnapshots() {
  try {
    const stored = localStorage.getItem(SNAPSHOT_KEY);
    const legacy = stored === null ? localStorage.getItem(LEGACY_SNAPSHOT_KEY) : null;
    if (legacy !== null) localStorage.setItem(SNAPSHOT_KEY, legacy);
    const value = JSON.parse(stored ?? legacy ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeSnapshots(snapshots) {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots.slice(0, 30)));
  renderSnapshots();
  updateConnectionUI();
}

function renderSnapshots() {
  const snapshots = readSnapshots();
  const list = $("#snapshotList");
  list.replaceChildren();
  if (snapshots.length === 0) {
    list.innerHTML = `<div class="empty-state"><strong>No snapshots</strong></div>`;
    return;
  }
  snapshots.forEach((snapshot, index) => {
    const item = document.createElement("div");
    item.className = "snapshot-item";
    item.innerHTML = `<div><strong></strong><span></span></div><button type="button" data-load>Load</button><button type="button" data-delete>Delete</button>`;
    $("strong", item).textContent = snapshot.name;
    $("span", item).textContent = `Slot ${snapshot.profile.slot + 1} · ${new Date(snapshot.createdAt).toLocaleString()}`;
    $("[data-load]", item).addEventListener("click", () => {
      if (!state.connected || state.busy) return;
      try {
        setProfile(cloneProfile(snapshot.profile), { dirty: true });
        if (state.connected) applyProfile();
        toast("Snapshot loaded");
      } catch (error) {
        toast("Invalid snapshot", error.message, true);
      }
    });
    $("[data-delete]", item).addEventListener("click", () => {
      snapshots.splice(index, 1);
      writeSnapshots(snapshots);
    });
    list.append(item);
  });
}

function saveSnapshot(name, profile = state.profile) {
  const snapshots = readSnapshots();
  snapshots.unshift({ name, createdAt: new Date().toISOString(), profile: cloneProfile(profile) });
  writeSnapshots(snapshots);
}

function renderAll() {
  renderMapping();
  renderLighting();
  renderDevice();
  renderSnapshots();
  updateConnectionUI();
}

async function loadSlot(slot) {
  if (!state.connected || state.busy) return;
  await flushPendingWrites();
  if (state.dirty && state.saveError && !confirm(`Discard unsaved changes and reload Slot ${slot + 1}?`)) return;
  setBusy(true, `Reading Slot ${slot + 1}…`, "reading");
  try {
    const profile = await readProfile(state.transport, slot, updateProgress);
    setProfile(profile);
    toast(`Slot ${slot + 1} loaded`);
  } catch (error) {
    toast("Read failed", error.message, true);
  } finally {
    setBusy(false);
  }
}

function handleTransportDisconnect() {
  for (const { timer } of state.scheduledWrites.values()) clearTimeout(timer);
  state.scheduledWrites.clear();
  state.connected = false;
  state.transport = null;
  state.dirty = state.dirty || state.pendingWrites > 0 || state.scheduledWrites.size > 0;
  updateConnectionUI();
  renderDevice();
  toast("Disconnected", "Unsaved changes can still be exported.", true);
}

async function connectDevice(kind = "usb") {
  setBusy(true, "Select W910…", "connecting");
  let nextTransport = null;
  try {
    nextTransport = kind === "bluetooth"
      ? await WebBluetoothTransport.request()
      : await WebHIDTransport.request();
    await flushPendingWrites();
    if (state.transport) await state.transport.close().catch(() => {});
    state.transport = nextTransport;
    state.transport.onDisconnect = handleTransportDisconnect;
    await state.transport.open();
    state.connected = true;
    setBusy(true, "Reading device…", "reading");
    $("#deviceName").textContent = state.transport.productName;
    $("#deviceMeta").textContent = state.transport.description;
    const slot = await readActiveSlot(state.transport);
    const profile = await readProfile(state.transport, slot, updateProgress);
    setProfile(profile);
    toast("Connected", `Slot ${slot + 1} loaded.`);
  } catch (error) {
    await nextTransport?.close().catch(() => {});
    state.connected = false;
    state.transport = null;
    toast("Could not connect", error.message, true);
  } finally {
    setBusy(false);
  }
}

async function applyProfile() {
  if (!state.connected || !state.dirty) return;
  await flushPendingWrites();
  const expected = cloneProfile(state.profile);
  saveSnapshot(`Automatic backup · Slot ${expected.slot + 1}`, expected);
  state.saveError = null;
  state.saveState = "saving";
  setBusy(true, `Writing Slot ${expected.slot + 1}…`, "saving");
  try {
    await writeProfile(state.transport, expected, updateProgress);
    updateProgress("Verifying…");
    const actual = await readProfile(state.transport, expected.slot, updateProgress);
    if (!profilesEqual(expected, actual)) {
      setProfile(actual, { dirty: false, preserveSaveState: true });
      throw new Error("The device readback differs from the requested profile. The editor was refreshed with actual device data.");
    }
    setProfile(actual, { dirty: false, preserveSaveState: true });
    state.saveState = "saved";
    toast("Saved");
  } catch (error) {
    state.saveError = error;
    state.saveState = "error";
    toast("Write failed", error.message, true);
  } finally {
    setBusy(false);
  }
}

function selectActionKind(kind) {
  if (macroRecorder.active && kind !== "macro") stopMacroRecording();
  state.editing.kind = kind;
  $$("[data-action-kind]").forEach((button) => button.classList.toggle("active", button.dataset.actionKind === kind));
  $$("[data-editor]").forEach((editor) => editor.classList.toggle("active", editor.dataset.editor === kind));
  if (kind === "macro") {
    $("#macroRepeat").disabled = Number($("#macroMode").value) !== 0;
    renderMacroEvents();
  }
}

function openActionDialog(control) {
  if (!state.connected || state.busy) return;
  const record = Uint8Array.from(getControlRecord(state.profile, state.layer, control));
  const decoded = decodeAction(record);
  let kind = decoded.kind;
  if (!["keyboard", "special", "macro"].includes(kind)) kind = "raw";
  const macro = decoded.kind === "macro" ? state.profile.macros[decoded.slot] : null;
  state.editing = {
    control,
    layer: state.layer,
    kind,
    events: cloneProfile(macro?.events ?? []),
    repeat: macro?.events?.length ? macro.repeat : 1,
    mode: decoded.kind === "macro" ? decoded.mode : 0,
  };
  $("#actionLayerLabel").textContent = state.layer === "normal" ? "Normal layer" : "Fn layer";
  $("#actionControlLabel").textContent = control.label;
  $("#keyboardSearch").value = "";
  $("#specialSearch").value = "";
  renderKeyboardOptions("", decoded.kind === "keyboard" ? String(decoded.usage) : undefined);
  renderSpecialOptions("", decoded.kind === "special" ? hexFromBytes(record, "") : undefined);
  $("#rawAction").value = hexFromBytes(record);
  $("#macroMode").value = String(state.editing.mode);
  $("#macroRepeat").value = state.editing.repeat;
  selectActionKind(kind);
  $("#actionDialog").showModal();
}

function macroDetailHTML(event, index) {
  const usageOptions = KEYBOARD_USAGES.map(({ usage, label }) => `<option value="${usage}"${usage === event.usage ? " selected" : ""}>${label}</option>`).join("");
  const stateOptions = `<select data-event-index="${index}" data-field="pressed"><option value="1"${event.pressed ? " selected" : ""}>Press</option><option value="0"${!event.pressed ? " selected" : ""}>Release</option></select>`;
  if (event.type === "keyboard") return `<div class="event-details"><select data-event-index="${index}" data-field="usage">${usageOptions}</select>${stateOptions}</div>`;
  if (event.type === "mouse_button") {
    return `<div class="event-details"><select data-event-index="${index}" data-field="button">${["left", "right", "middle", "back", "forward"].map((button) => `<option value="${button}"${button === event.button ? " selected" : ""}>${button[0].toUpperCase() + button.slice(1)}</option>`).join("")}</select>${stateOptions}</div>`;
  }
  if (event.type === "wheel") return `<div class="event-details"><select data-event-index="${index}" data-field="value"><option value="1"${event.value === 1 ? " selected" : ""}>Up / +1</option><option value="255"${event.value === 255 ? " selected" : ""}>Down / −1</option></select><span class="event-caption">Mouse wheel</span></div>`;
  return `<div class="event-details"><input data-event-index="${index}" data-field="x" type="number" min="-32768" max="32767" value="${event.x}"><input data-event-index="${index}" data-field="y" type="number" min="-32768" max="32767" value="${event.y}"></div>`;
}

function renderMacroEvents() {
  const container = $("#macroEvents");
  container.replaceChildren();
  state.editing.events.forEach((event, index) => {
    const row = document.createElement("div");
    row.className = "macro-row";
    row.innerHTML = `
      <span class="drag-handle">${index + 1}</span>
      <select data-event-index="${index}" data-field="type">
        <option value="keyboard"${event.type === "keyboard" ? " selected" : ""}>Keyboard</option>
        <option value="mouse_button"${event.type === "mouse_button" ? " selected" : ""}>Mouse button</option>
        <option value="wheel"${event.type === "wheel" ? " selected" : ""}>Wheel</option>
        <option value="move"${event.type === "move" ? " selected" : ""}>Move</option>
      </select>
      ${macroDetailHTML(event, index)}
      <input data-event-index="${index}" data-field="delay" type="number" min="0" max="16777215" value="${event.delay}" title="Delay in milliseconds">
      <div class="row-actions"><button type="button" data-move-up="${index}" title="Move up" aria-label="Move event up"${index === 0 ? " disabled" : ""}>↑</button><button type="button" data-move-down="${index}" title="Move down" aria-label="Move event down"${index === state.editing.events.length - 1 ? " disabled" : ""}>↓</button><button type="button" class="delete-event" data-remove-event="${index}" title="Delete" aria-label="Delete event">×</button></div>`;
    container.append(row);
  });
  $("#macroEmpty").classList.toggle("hidden", state.editing.events.length > 0);
  $("#clearMacroButton").disabled = macroRecorder.active || state.editing.events.length === 0;
  try {
    const size = encodeMacro(state.editing.events, Number($("#macroRepeat").value || 1)).length;
    $("#macroSize").textContent = `${size} / 512 bytes`;
    $("#macroSize").style.color = size > 512 ? "var(--danger)" : "";
  } catch (error) {
    $("#macroSize").textContent = error.message;
    $("#macroSize").style.color = "var(--danger)";
  }
}

function defaultEvent(type) {
  if (type === "keyboard") return { type, usage: 0x04, pressed: true, delay: 20 };
  if (type === "mouse_button") return { type, button: "left", pressed: true, delay: 20 };
  if (type === "wheel") return { type, value: 1, delay: 0 };
  return { type: "move", x: 10, y: 0, delay: 20 };
}

function finishMacroRecording() {
  if (macroRecorder.handlers) {
    for (const [type, handler] of Object.entries(macroRecorder.handlers)) {
      window.removeEventListener(type, handler, true);
    }
  }
  macroRecorder.active = false;
  macroRecorder.lastTimestamp = null;
  macroRecorder.pressedKeys.clear();
  macroRecorder.pressedButtons.clear();
  macroRecorder.handlers = null;
  const button = $("#recordMacroButton");
  button.textContent = "Record";
  button.classList.remove("recording");
  $("#macroRecordingStatus").classList.add("hidden");
  $("#addMacroEvent").disabled = false;
  $("#macroMode").disabled = false;
  $("#macroRepeat").disabled = Number($("#macroMode").value) !== 0;
  if (state.editing?.kind === "macro") renderMacroEvents();
}

function recordMacroEvent(event, timestamp = performance.now()) {
  try {
    macroRecorder.lastTimestamp = appendTimedMacroEvent(
      state.editing.events,
      event,
      timestamp,
      macroRecorder.lastTimestamp,
      Number($("#macroRepeat").value || 1),
    );
    renderMacroEvents();
    return true;
  } catch (error) {
    finishMacroRecording();
    toast("Recording stopped", error.message, true);
    return false;
  }
}

function stopMacroRecording({ releaseHeld = true } = {}) {
  if (!macroRecorder.active) return;
  if (releaseHeld) {
    const timestamp = performance.now();
    for (const usage of macroRecorder.pressedKeys) {
      if (!recordMacroEvent({ type: "keyboard", usage, pressed: false }, timestamp)) return;
    }
    for (const button of macroRecorder.pressedButtons) {
      if (!recordMacroEvent({ type: "mouse_button", button, pressed: false }, timestamp)) return;
    }
  }
  finishMacroRecording();
}

function startMacroRecording() {
  if (!state.editing || state.editing.kind !== "macro" || macroRecorder.active) return;
  if (state.editing.events.length > 0 && !confirm("Replace existing macro events with a new recording?")) return;
  state.editing.events = [];
  macroRecorder.active = true;
  macroRecorder.lastTimestamp = null;
  macroRecorder.pressedKeys.clear();
  macroRecorder.pressedButtons.clear();

  const ignoreControl = (event) => event.target instanceof Element && Boolean(event.target.closest("button, input, select"));
  const onKeyDown = (event) => {
    if (event.code === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      stopMacroRecording();
      return;
    }
    if (event.repeat || ignoreControl(event)) return;
    const usage = codeToUsage(event.code);
    if (usage === undefined || !USAGE_NAMES.has(usage) || macroRecorder.pressedKeys.has(usage)) return;
    event.preventDefault();
    event.stopPropagation();
    macroRecorder.pressedKeys.add(usage);
    recordMacroEvent({ type: "keyboard", usage, pressed: true }, event.timeStamp);
  };
  const onKeyUp = (event) => {
    const usage = codeToUsage(event.code);
    if (usage === undefined || !macroRecorder.pressedKeys.has(usage)) return;
    event.preventDefault();
    event.stopPropagation();
    macroRecorder.pressedKeys.delete(usage);
    recordMacroEvent({ type: "keyboard", usage, pressed: false }, event.timeStamp);
  };
  const mouseButton = (button) => ({ 0: "left", 1: "middle", 2: "right", 3: "back", 4: "forward" })[button];
  const onPointerDown = (event) => {
    if (ignoreControl(event) || (event.pointerType && event.pointerType !== "mouse")) return;
    const button = mouseButton(event.button);
    if (!button || macroRecorder.pressedButtons.has(button)) return;
    event.preventDefault();
    event.stopPropagation();
    macroRecorder.pressedButtons.add(button);
    recordMacroEvent({ type: "mouse_button", button, pressed: true }, event.timeStamp);
  };
  const onPointerUp = (event) => {
    if (ignoreControl(event) || (event.pointerType && event.pointerType !== "mouse")) return;
    const button = mouseButton(event.button);
    if (!button || !macroRecorder.pressedButtons.has(button)) return;
    event.preventDefault();
    event.stopPropagation();
    macroRecorder.pressedButtons.delete(button);
    recordMacroEvent({ type: "mouse_button", button, pressed: false }, event.timeStamp);
  };
  const onWheel = (event) => {
    if (ignoreControl(event) || event.deltaY === 0) return;
    event.preventDefault();
    event.stopPropagation();
    recordMacroEvent({ type: "wheel", value: event.deltaY < 0 ? 1 : 0xff }, event.timeStamp);
  };
  macroRecorder.handlers = { keydown: onKeyDown, keyup: onKeyUp, pointerdown: onPointerDown, pointerup: onPointerUp, wheel: onWheel };
  for (const [type, handler] of Object.entries(macroRecorder.handlers)) window.addEventListener(type, handler, true);

  $("#recordMacroButton").textContent = "Stop";
  $("#recordMacroButton").classList.add("recording");
  $("#macroRecordingStatus").classList.remove("hidden");
  $("#addMacroEvent").disabled = true;
  $("#macroMode").disabled = true;
  $("#macroRepeat").disabled = true;
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  renderMacroEvents();
}

function saveAction() {
  if (!state.connected || state.busy || !state.editing) return;
  if (macroRecorder.active) stopMacroRecording();
  const { control, layer, kind } = state.editing;
  try {
    let record;
    if (kind === "keyboard") record = keyboardAction(Number($("#keyboardUsage").value));
    else if (kind === "special") record = bytesFromHex($("#specialAction").value, 4);
    else if (kind === "raw") record = bytesFromHex($("#rawAction").value, 4);
    else {
      const slot = macroSlotFor(state.profile, layer, control);
      const mode = Number($("#macroMode").value);
      const repeat = Number($("#macroRepeat").value);
      encodeMacro(state.editing.events, repeat);
      state.profile.macros[slot] = { repeat, events: cloneProfile(state.editing.events) };
      record = macroAction(slot, mode);
    }
    setControlRecord(state.profile, layer, control, record);
    markDirty();
    renderMapping();
    $("#actionDialog").close();
    const profile = cloneProfile(state.profile);
    enqueueDeviceWrite(`Saving ${control.label}`, () => writeControlSetting(state.transport, profile, layer, control));
    toast("Assignment updated");
  } catch (error) {
    toast("Invalid assignment", error.message, true);
  }
}

function codeToUsage(code) {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + code.charCodeAt(3) - 65;
  if (/^Digit[1-9]$/.test(code)) return 0x1e + Number(code.at(-1)) - 1;
  if (code === "Digit0") return 0x27;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) {
    const number = Number(code.slice(1));
    return number <= 12 ? 0x3a + number - 1 : 0x68 + number - 13;
  }
  return {
    Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
    Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30,
    Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
    Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39,
    PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49, Home: 0x4a,
    PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
    ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
    NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56,
    NumpadAdd: 0x57, NumpadEnter: 0x58, Numpad1: 0x59, Numpad2: 0x5a,
    Numpad3: 0x5b, Numpad4: 0x5c, Numpad5: 0x5d, Numpad6: 0x5e,
    Numpad7: 0x5f, Numpad8: 0x60, Numpad9: 0x61, Numpad0: 0x62,
    NumpadDecimal: 0x63, ContextMenu: 0x65, NumpadEqual: 0x67,
    ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
    ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7,
  }[code];
}

function keyboardUsageCode(usage) {
  return `0x${Number(usage).toString(16).padStart(2, "0").toUpperCase()}`;
}

function keyboardActionCode(usage) {
  return hexFromBytes(keyboardAction(Number(usage)));
}

function renderKeyboardOptions(query = "", selected = $("#keyboardUsage").value) {
  const normalized = query.trim().toLowerCase();
  const matches = KEYBOARD_USAGES.filter(({ usage, label }) => {
    const code = keyboardUsageCode(usage);
    return !normalized || label.toLowerCase().includes(normalized) || code.toLowerCase().includes(normalized);
  });
  const select = $("#keyboardUsage");
  select.replaceChildren();
  for (const { usage, label } of matches) {
    const option = document.createElement("option");
    option.value = String(usage);
    option.textContent = label;
    select.append(option);
  }
  if (matches.some(({ usage }) => String(usage) === String(selected))) select.value = String(selected);
  else if (matches.length > 0) select.selectedIndex = 0;
  else {
    const option = document.createElement("option");
    option.disabled = true;
    option.textContent = "No matches";
    select.append(option);
  }
  $("#keyboardUsageCode").textContent = select.value ? keyboardActionCode(select.value) : "—";
}

function renderSpecialOptions(query = "", selected = $("#specialAction").value) {
  const normalized = query.trim().toLowerCase();
  const compactQuery = normalized.replaceAll(" ", "");
  const matches = SPECIAL_ACTIONS.filter((item) => {
    const code = hexFromBytes(item.bytes);
    return !normalized || item.label.toLowerCase().includes(normalized) || item.group.toLowerCase().includes(normalized) || code.toLowerCase().replaceAll(" ", "").includes(compactQuery);
  });
  const select = $("#specialAction");
  select.replaceChildren();
  const groups = new Map();
  for (const item of matches) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  for (const [group, actions] of groups) {
    const optionGroup = document.createElement("optgroup");
    optionGroup.label = group;
    for (const item of actions) {
      const option = document.createElement("option");
      option.value = hexFromBytes(item.bytes, "");
      option.textContent = item.label;
      optionGroup.append(option);
    }
    select.append(optionGroup);
  }
  if (matches.some((item) => hexFromBytes(item.bytes, "") === selected)) select.value = selected;
  else if (matches.length > 0) select.value = hexFromBytes(matches[0].bytes, "");
  else {
    const option = document.createElement("option");
    option.disabled = true;
    option.textContent = "No matches";
    select.append(option);
  }
  $("#specialActionCode").textContent = select.value ? hexFromBytes(bytesFromHex(select.value, 4)) : "—";
}

function initializeOptions() {
  $("#lightingMode").innerHTML = LED_MODES.map((mode) => `<option value="${mode.code}">${mode.name}</option>`).join("");
  renderKeyboardOptions();
  renderSpecialOptions();
}

function initializeEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.page)));
  $$("[data-layer]").forEach((button) => button.addEventListener("click", () => {
    if (!state.connected || state.busy) return;
    state.layer = button.dataset.layer;
    renderMapping();
  }));
  $$("[data-slot]").forEach((button) => button.addEventListener("click", () => {
    const slot = Number(button.dataset.slot);
    if (slot === state.profile.slot) return;
    loadSlot(slot);
  }));
  $("#connectHidButton").addEventListener("click", () => connectDevice("usb"));
  $("#connectBluetoothButton").addEventListener("click", () => connectDevice("bluetooth"));
  $("#readButton").addEventListener("click", () => loadSlot(state.profile.slot));
  $("#progressBar").addEventListener("click", applyProfile);

  $("#lightingMode").addEventListener("change", (event) => {
    if (!state.connected || state.busy) return;
    state.profile.lighting.mode = Number(event.target.value);
    markDirty();
    renderLighting();
    const profile = cloneProfile(state.profile);
    enqueueDeviceWrite("Applying lighting effect", () => writeLightingSelection(state.transport, profile));
  });
  for (const [selector, field] of [["#brightness", "brightness"], ["#speed", "speed"], ["#direction", "direction"]]) {
    $(selector).addEventListener("input", (event) => {
      if (!state.connected || state.busy) return;
      currentLightingRecord()[field] = Number(event.target.value);
      markDirty();
      if (field === "brightness") $("#brightnessValue").textContent = `${event.target.value} / 6`;
      if (field === "speed") $("#speedValue").textContent = `${event.target.value} / 7`;
      const mode = state.profile.lighting.mode & 0x3f;
      scheduleDeviceWrite(`lighting-${mode}`, "Saving lighting settings", () => writeLightingSetting(state.transport, cloneProfile(state.profile), mode));
    });
  }
  $("#colorPalette").addEventListener("input", (event) => {
    if (!state.connected || state.busy) return;
    const record = currentLightingRecord();
    if (event.target.dataset.colorIndex !== undefined) {
      const index = Number(event.target.dataset.colorIndex);
      record.colors[index] = event.target.value.toUpperCase();
      const mode = LED_MODES.find((item) => item.code === state.profile.lighting.mode);
      if (mode?.palette === "single") record.enabled = record.enabled.map((_, colorIndex) => colorIndex === index);
    }
    if (event.target.dataset.colorEnabled !== undefined) {
      record.enabled[Number(event.target.dataset.colorEnabled)] = event.target.checked;
      event.target.closest(".color-chip").classList.toggle("disabled", !event.target.checked);
    }
    markDirty();
    const mode = state.profile.lighting.mode & 0x3f;
    scheduleDeviceWrite(`lighting-${mode}`, "Saving lighting palette", () => writeLightingSetting(state.transport, cloneProfile(state.profile), mode));
  });
  for (const [selector, field] of [["#sleepSeconds", "sleepSeconds"], ["#powerDownSeconds", "powerDownSeconds"]]) {
    $(selector).addEventListener("change", (event) => {
      if (!state.connected || state.busy) return;
      const value = Number(event.target.value);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        event.target.value = state.profile[field];
        toast("Invalid timeout", "Timeouts must be whole seconds from 0 to 65535.", true);
        return;
      }
      state.profile[field] = value;
      markDirty();
      const profile = cloneProfile(state.profile);
      enqueueDeviceWrite(`Saving ${field === "sleepSeconds" ? "sleep" : "power-down"} timeout`, () => writePowerSetting(state.transport, profile, field));
    });
  }

  $("#exportButton").addEventListener("click", () => {
    const blob = new Blob([`${JSON.stringify(state.profile, null, 2)}\n`], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `w910-slot-${state.profile.slot + 1}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
  $("#importButton").addEventListener("click", () => {
    if (!state.connected || state.busy) return;
    $("#importFile").click();
  });
  $("#resetButton").addEventListener("click", () => {
    if (!state.connected || state.busy) return;
    if (!confirm(`Restore factory defaults to Slot ${state.profile.slot + 1}? This writes to the keyboard immediately.`)) return;
    setProfile(defaultProfile(state.profile.slot), { dirty: true });
    if (state.connected) applyProfile();
    toast("Factory defaults loaded");
  });
  $("#importFile").addEventListener("change", async (event) => {
    if (!state.connected || state.busy) return;
    try {
      const profile = JSON.parse(await event.target.files[0].text());
      setProfile(profile, { dirty: true });
      if (state.connected) applyProfile();
      toast("Backup imported");
    } catch (error) {
      toast("Import failed", error.message, true);
    } finally {
      event.target.value = "";
    }
  });
  $("#saveSnapshotButton").addEventListener("click", () => {
    const input = $("#snapshotName");
    const name = input.value.trim();
    if (!name) return toast("Name required", "Enter a snapshot name.", true);
    saveSnapshot(name);
    input.value = "";
    toast("Snapshot saved");
  });

  $$("[data-action-kind]").forEach((button) => button.addEventListener("click", () => selectActionKind(button.dataset.actionKind)));
  $("#saveActionButton").addEventListener("click", saveAction);
  $("#keyboardSearch").addEventListener("input", (event) => renderKeyboardOptions(event.target.value));
  $("#keyboardSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); $("#keyboardUsage").focus(); }
  });
  $("#keyboardUsage").addEventListener("change", (event) => {
    $("#keyboardUsageCode").textContent = keyboardActionCode(event.target.value);
  });
  $("#specialSearch").addEventListener("input", (event) => renderSpecialOptions(event.target.value));
  $("#specialSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); $("#specialAction").focus(); }
  });
  $("#specialAction").addEventListener("change", (event) => {
    $("#specialActionCode").textContent = event.target.value ? hexFromBytes(bytesFromHex(event.target.value, 4)) : "—";
  });
  $("#recordMacroButton").addEventListener("click", () => {
    if (macroRecorder.active) stopMacroRecording();
    else startMacroRecording();
  });
  $("#clearMacroButton").addEventListener("click", () => {
    if (!state.editing || macroRecorder.active) return;
    state.editing.events = [];
    renderMacroEvents();
  });
  $("#actionDialog").addEventListener("close", () => stopMacroRecording());
  $("#captureKeyButton").addEventListener("click", () => {
    const button = $("#captureKeyButton");
    button.textContent = "Press a key…";
    button.classList.add("capturing");
    const handler = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const usage = codeToUsage(event.code);
      if (usage === undefined || !USAGE_NAMES.has(usage)) {
        toast("Key not mapped", `${event.code} has no standard HID mapping in the editor.`, true);
      } else {
        $("#keyboardSearch").value = "";
        renderKeyboardOptions("", String(usage));
      }
      button.textContent = "Capture key";
      button.classList.remove("capturing");
      window.removeEventListener("keydown", handler, true);
    };
    window.addEventListener("keydown", handler, true);
  });
  $("#macroMode").addEventListener("change", (event) => {
    state.editing.mode = Number(event.target.value);
    $("#macroRepeat").disabled = state.editing.mode !== 0;
  });
  $("#macroRepeat").addEventListener("input", renderMacroEvents);
  $("#addMacroEvent").addEventListener("change", (event) => {
    if (!event.target.value) return;
    if (event.target.value === "keystroke") {
      state.editing.events.push({ type: "keyboard", usage: 0x04, pressed: true, delay: 20 }, { type: "keyboard", usage: 0x04, pressed: false, delay: 20 });
    } else state.editing.events.push(defaultEvent(event.target.value));
    event.target.value = "";
    renderMacroEvents();
  });
  $("#macroEvents").addEventListener("change", (event) => {
    const index = Number(event.target.dataset.eventIndex);
    const field = event.target.dataset.field;
    if (!Number.isInteger(index) || !field) return;
    if (field === "type") state.editing.events[index] = defaultEvent(event.target.value);
    else if (["usage", "value", "delay", "x", "y"].includes(field)) state.editing.events[index][field] = Number(event.target.value);
    else if (field === "pressed") state.editing.events[index][field] = event.target.value === "1";
    else state.editing.events[index][field] = event.target.value;
    renderMacroEvents();
  });
  $("#macroEvents").addEventListener("click", (event) => {
    const remove = event.target.dataset.removeEvent;
    const up = event.target.dataset.moveUp;
    const down = event.target.dataset.moveDown;
    if (remove !== undefined) state.editing.events.splice(Number(remove), 1);
    else if (up !== undefined && Number(up) > 0) {
      const index = Number(up); [state.editing.events[index - 1], state.editing.events[index]] = [state.editing.events[index], state.editing.events[index - 1]];
    } else if (down !== undefined && Number(down) < state.editing.events.length - 1) {
      const index = Number(down); [state.editing.events[index + 1], state.editing.events[index]] = [state.editing.events[index], state.editing.events[index + 1]];
    } else return;
    renderMacroEvents();
  });

  if ("hid" in navigator) {
    navigator.hid.addEventListener("disconnect", (event) => {
      if (state.transport?.device === event.device) {
        handleTransportDisconnect();
      }
    });
  }
}

function initialize() {
  const parameters = new URLSearchParams(location.search);
  initializeOptions();
  initializeEvents();
  if (!("hid" in navigator) && !("bluetooth" in navigator)) {
    const notice = $("#compatibilityNotice");
    notice.classList.remove("hidden");
    notice.textContent = "Device access is unavailable. Use Chrome or Edge over HTTPS or localhost.";
  }
  renderAll();
  if (pageTitles[parameters.get("page")]) showPage(parameters.get("page"));
  if (["usb", "bluetooth"].includes(parameters.get("connect"))) connectDevice(parameters.get("connect"));
}

initialize();
