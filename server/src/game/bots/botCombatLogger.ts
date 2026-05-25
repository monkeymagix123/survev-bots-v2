import fs from "fs";
import path from "path";
import { Config } from "../../config";

const enabled = Config.bots.debugCombat;
const logPath = path.join(process.cwd(), "logs/bot-combat.log");

function toPrintable(value: unknown): string {
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "nan";
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (value === undefined) return "-";
    if (value === null) return "null";
    return String(value);
}

function buildSummary(fields: Record<string, unknown>): string {
    return [
        `brain=${toPrintable(fields.brainType)}`,
        `state=${toPrintable(fields.state)}`,
        `why=${toPrintable(fields.stateReason)}`,
        `danger=${toPrintable(fields.danger)}`,
        `hp=${toPrintable(fields.hp)}`,
        `dist=${toPrintable(fields.dist)}`,
        `visible=${toPrintable(fields.visible)}`,
        `reload=${toPrintable(fields.needsReload)}`,
        `gas=${toPrintable(fields.gasEmergency)}`,
    ].join(" ");
}

export function logBotCombat(fields: Record<string, unknown>): void {
    if (!enabled) return;

    const payload = {
        time: new Date().toISOString(),
        summary: buildSummary(fields),
        ...fields,
    };

    try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`);
    } catch {
        // Best-effort debug logging only.
    }
}

export function getBotCombatLogPath(): string {
    return logPath;
}
