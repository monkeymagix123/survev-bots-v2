import fs from "fs";
import path from "path";
import { Config } from "../../config";

const enabled = Config.bots.debugBotStability;
const logPath = path.join(process.cwd(), "logs/bot-stability.log");

export function logBotStability(event: string, fields: Record<string, unknown>): void {
    if (!enabled) return;

    const payload = {
        time: new Date().toISOString(),
        event,
        ...fields,
    };

    try {
        fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`);
    } catch {
        // Best-effort debug logging only.
    }
}

export function getBotStabilityLogPath(): string {
    return logPath;
}
