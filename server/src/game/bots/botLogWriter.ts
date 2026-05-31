import fs from "fs";
import path from "path";

const streams = new Map<string, fs.WriteStream>();

function getStream(logPath: string): fs.WriteStream {
    let stream = streams.get(logPath);
    if (stream) {
        return stream;
    }

    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    stream = fs.createWriteStream(logPath, { flags: "a" });
    streams.set(logPath, stream);
    return stream;
}

export function appendBotLogLine(logPath: string, line: string): void {
    try {
        getStream(logPath).write(`${line}\n`);
    } catch {
        // Best-effort debug logging only.
    }
}
