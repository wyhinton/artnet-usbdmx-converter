import chalk from "chalk";

/**
 * Named stages of the ArtNet <-> USBDMX data pipeline, in roughly the order data passes
 * through them. Kept as distinct tags (rather than one generic "debug" log) so the two
 * directions of travel - ArtNet-In -> USBDMX-Out and USBDMX-In -> ArtNet-Out - and the
 * interface lifecycle can be told apart and filtered/grepped for independently.
 */
export type PipelineStage =
    | "ARTNET-IN"
    | "DEDUP"
    | "WRITE"
    | "HID-IN"
    | "SERIAL-IN"
    | "USBDMX-IN"
    | "ARTNET-OUT"
    | "LIFECYCLE";

const stageColors: Record<PipelineStage, (text: string) => string> = {
    "ARTNET-IN": chalk.cyan,
    "DEDUP": chalk.gray,
    "WRITE": chalk.magenta,
    "HID-IN": chalk.blue,
    "SERIAL-IN": chalk.blue,
    "USBDMX-IN": chalk.blueBright,
    "ARTNET-OUT": chalk.green,
    "LIFECYCLE": chalk.yellow,
};

/**
 * Prints a tagged, timestamped trace line for one stage of the pipeline. Only prints
 * when `enabled` is true (callers pass their own/the shared `debug` flag) so this stays
 * silent outside of --debug mode.
 */
export function pipelineLog(enabled: boolean, stage: PipelineStage, message: string): void {
    if (!enabled) return;
    console.log(chalk.gray(`[${new Date().toISOString()}]`), stageColors[stage](`[${stage}]`), message);
}

/**
 * Human-readable meaning of the return codes shared by every {@link IDMXInterface}
 * implementation's write()/writeMap()/setMode() (see the codes documented in DMXInterface.ts).
 */
export function describeInterfaceReturnCode(code: number): string {
    switch (code) {
        case 0: return "OK";
        case 1: return "invalid channel";
        case 2: return "invalid value";
        case 3: return "invalid mode";
        case 4: return "invalid array size";
        default: return "other error";
    }
}

/**
 * Always-visible (not gated behind --debug) warning for pipeline failures that would
 * otherwise fail silently, e.g. a non-512-length write being dropped.
 */
export function pipelineWarn(stage: PipelineStage, message: string): void {
    console.log(chalk.gray(`[${new Date().toISOString()}]`), chalk.red(`[${stage}] ⚠`), message);
}
