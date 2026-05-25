import fs from "fs";
import path from "path";
import { Config } from "../../config";
import type { Game } from "../game";
import { getBotLogDir } from "./botLogPaths";

const enabled = Config.bots.debugCombat;

function toPrintable(value: unknown): string {
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "nan";
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (value === undefined) return "-";
    if (value === null) return "null";
    return String(value);
}

function buildSummary(fields: Record<string, unknown>): string {
    return [
        `bot=${toPrintable(fields.botId)}`,
        `brain=${toPrintable(fields.brainType)}`,
        `state=${toPrintable(fields.state)}`,
        `why=${toPrintable(fields.stateReason)}`,
        `danger=${toPrintable(fields.danger)}`,
        `hp=${toPrintable(fields.hp)}`,
        `dist=${toPrintable(fields.dist)}`,
        `visible=${toPrintable(fields.visible)}`,
        `reload=${toPrintable(fields.needsReload)}`,
        `gas=${toPrintable(fields.gasEmergency)}`,
        `target=${toPrintable(fields.targetId)}`,
        `loot=${toPrintable(fields.lootTargetId)}`,
        `obj=${toPrintable(fields.objectTargetId)}`,
        `goal=(${toPrintable(fields.goalX)},${toPrintable(fields.goalY)})`,
        `style=${toPrintable(fields.movementStyle)}`,
    ].join(" ");
}

export function logBotCombat(game: Game, fields: Record<string, unknown>): void {
    if (!enabled) return;

    const logPath = path.join(getBotLogDir(game), "bot-combat.log");

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
    return path.join(process.cwd(), "logs", "<game-create-time>_<game-id>", "bot-combat.log");
}
