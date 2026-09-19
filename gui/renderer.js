/* global converter */

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {idle: "Stopped", starting: "Starting…", running: "Running"};

let interfaces = [];
let state = {status: "idle", error: undefined, rates: {artnetIn: 0, usbdmxOut: 0, usbdmxIn: 0, artnetOut: 0}};
let preferredSerial;

function selectedInterface() {
    return interfaces.find((i) => i.serial === $("interface").value);
}

function renderInterfaces() {
    const select = $("interface");
    const previous = select.value || preferredSerial;
    select.replaceChildren();

    if (interfaces.length === 0) {
        select.append(new Option("No interface found", ""));
    }
    for (const i of interfaces) {
        select.append(new Option(i.label, i.serial));
    }
    if (interfaces.some((i) => i.serial === previous)) {
        select.value = previous;
    }
    render();
}

function render() {
    const running = state.status === "running";
    const idle = state.status === "idle";
    const selected = selectedInterface();
    // Enttec-protocol interfaces have no HID-style modes and no DMX input
    const isEnttec = selected?.protocol === "enttec-serial";

    $("status").dataset.state = state.status;
    $("status-text").textContent = STATUS_TEXT[state.status];

    $("interface").disabled = !idle || interfaces.length === 0;
    $("rescan").disabled = !idle;
    $("mode").disabled = !idle;
    $("mode-group").hidden = isEnttec;
    for (const el of document.querySelectorAll(".input-only")) {
        el.hidden = isEnttec;
    }

    const toggle = $("toggle");
    toggle.textContent = running ? "Stop" : state.status === "starting" ? "Starting…" : "Start";
    toggle.disabled = state.status === "starting" || (idle && !selected);

    $("error").hidden = !state.error;
    $("error").textContent = state.error ?? "";

    $("rate-artnet-in").textContent = state.rates.artnetIn;
    $("rate-usbdmx-out").textContent = state.rates.usbdmxOut;
    $("rate-usbdmx-in").textContent = state.rates.usbdmxIn;
    $("rate-artnet-out").textContent = state.rates.artnetOut;
}

async function main() {
    converter.onState((newState) => {
        state = newState;
        render();
    });

    const initial = await converter.init();
    interfaces = initial.interfaces;
    state = initial.state;
    preferredSerial = initial.settings.serial;

    for (const mode of initial.modes) {
        $("mode").append(new Option(mode.label, mode.value));
    }
    $("mode").value = initial.settings.mode ?? initial.defaultMode;
    $("auto-start").checked = initial.settings.autoStart === true;
    $("receiver-address").textContent = `Listening for Art-Net on ${initial.receiverAddress}`;
    $("version").textContent = `v${initial.version}`;
    renderInterfaces();

    $("interface").addEventListener("change", render);
    $("rescan").addEventListener("click", async () => {
        interfaces = await converter.scan();
        renderInterfaces();
    });
    $("auto-start").addEventListener("change", (event) => {
        converter.setAutoStart(event.target.checked);
    });
    $("toggle").addEventListener("click", () => {
        if (state.status === "running") {
            converter.stop();
        }
        else if (state.status === "idle" && selectedInterface()) {
            converter.start($("interface").value, $("mode").value);
        }
    });
}

main();
