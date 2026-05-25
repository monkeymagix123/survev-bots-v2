import path from "node:path";
import type { Game } from "../game";

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

function formatLogFolderTime(epochMs: number): string {
    const date = new Date(epochMs);
    return [
        date.getFullYear(),
        pad2(date.getMonth() + 1),
        pad2(date.getDate()),
    ].join("-") +
        "_" +
        [pad2(date.getHours()), pad2(date.getMinutes()), pad2(date.getSeconds())].join("-");
}

export function getBotLogDir(game: Game): string {
    const startedAt = game.start;
    const shortId = game.id.slice(0, 4);
    const folderName = `${formatLogFolderTime(startedAt)}_${shortId}`;
    return path.join(process.cwd(), "logs", folderName);
}
