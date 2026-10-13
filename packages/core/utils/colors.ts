/**
 * @fileoverview Terminal colour, with no dependency and no assumption of a terminal.
 * Reads `process` off globalThis so importing this never breaks a browser or worker host.
 */

const proc = (globalThis as { process?: { env?: Record<string, string | undefined>; stdout?: { isTTY?: boolean } } }).process;
const enabled = !proc?.env?.NO_COLOR && proc?.stdout?.isTTY === true;

const wrap = (open: number, close: number) => (text: string) =>
    enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export const pc = {
    bold: wrap(1, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    white: wrap(37, 39),
    gray: wrap(90, 39),
};
