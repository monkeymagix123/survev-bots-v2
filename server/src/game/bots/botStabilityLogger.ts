import fs from "fs";
import path from "path";
import { Config } from "../../config";
import type { Game } from "../game";
import { getBotLogDir } from "./botLogPaths";

const enabled = Config.bots.debugBotStability;

function toPrintable(value: unknown): string {
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "nan";
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (value === undefined) return "-";
    if (value === null) return "null";
    return String(value);
}

function buildSummary(event: string, fields: Record<string, unknown>): string {
    switch (event) {
        case "state_change":
            return [
                `bot=${toPrintable(fields.botId)}`,
                `brain=${toPrintable(fields.brainType)}`,
                `${toPrintable(fields.previousState)}->${toPrintable(fields.state)}`,
                `why=${toPrintable(fields.reason)}`,
                `hp=${toPrintable(fields.hp)}`,
                `danger=${toPrintable(fields.danger)}`,
                `dist=${toPrintable(fields.distToTarget)}`,
                `visible=${toPrintable(fields.visible)}`,
                `target=${toPrintable(fields.targetId)}`,
                `loot=${toPrintable(fields.lootTargetId)}`,
                `obj=${toPrintable(fields.objectTargetId)}`,
                `goal=(${toPrintable(fields.goalX)},${toPrintable(fields.goalY)})`,
                `style=${toPrintable(fields.movementStyle)}`,
            ].join(" ");
        case "heal_cancel":
            return [
                `bot=${toPrintable(fields.botId)}`,
                `brain=${toPrintable(fields.brainType)}`,
                `item=${toPrintable(fields.item)}`,
                `hp=${toPrintable(fields.hp)}`,
                `danger=${toPrintable(fields.danger)}`,
                `remaining=${toPrintable(fields.remaining)}`,
                `visible=${toPrintable(fields.hostileVisible)}`,
                `close=${toPrintable(fields.enemyClose)}`,
                `veryClose=${toPrintable(fields.enemyVeryClose)}`,
            ].join(" ");
        case "idle_reason":
            return [
                `bot=${toPrintable(fields.botId)}`,
                `brain=${toPrintable(fields.brainType)}`,
                `idle=${toPrintable(fields.reason)}`,
                `state=${toPrintable(fields.state)}`,
                `why=${toPrintable(fields.stateReason)}`,
                `goal=(${toPrintable(fields.goalX)},${toPrintable(fields.goalY)})`,
                `target=${toPrintable(fields.targetId)}`,
                `loot=${toPrintable(fields.lootTargetId)}`,
                `obj=${toPrintable(fields.objectTargetId)}`,
            ].join(" ");
        default:
            return Object.entries(fields)
                .map(([key, value]) => `${key}=${toPrintable(value)}`)
                .join(" ");
    }
}

export function logBotStability(
    game: Game,
    event: string,
    fields: Record<string, unknown>,
): void {
    if (!enabled) return;

    const logPath = path.join(getBotLogDir(game), "bot-stability.log");

    const payload = {
        time: new Date().toISOString(),
        event,
        summary: buildSummary(event, fields),
        ...fields,
    };

    try {
        fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`);
    } catch {
        // Best-effort debug logging only.
    }
}

export function getBotStabilityLogPath(): string {
    return path.join(process.cwd(), "logs", "<game-create-time>_<game-id>", "bot-stability.log");
}
