import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import pino from "pino";
import { logger, serializers } from "./logger.ts";

function capture(): { lines: string[]; log: pino.Logger } {
	const lines: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			lines.push(String(chunk));
			callback();
		},
	});
	return { lines, log: pino({ serializers }, stream) };
}

describe("logger serializers", () => {
	it("logs the message of an Error under the error key instead of {}", () => {
		const { lines, log } = capture();
		log.error({ error: new Error("docker: command not found") }, "failed");
		const entry = JSON.parse(lines[0]);
		expect(entry.error.message).toBe("docker: command not found");
		expect(entry.error.type).toBe("Error");
	});

	it("keeps non-Error values under the error key", () => {
		const { lines, log } = capture();
		log.error({ error: "plain text" }, "failed");
		expect(JSON.parse(lines[0]).error).toBe("plain text");
	});

	it("also serializes the err key", () => {
		const { lines, log } = capture();
		log.error({ err: new TypeError("bad") }, "failed");
		expect(JSON.parse(lines[0]).err.message).toBe("bad");
	});

	it("is used by the plugin logger", () => {
		const configured = (
			logger as unknown as Record<symbol, typeof serializers>
		)[pino.symbols.serializersSym];
		expect(configured.error).toBe(pino.stdSerializers.err);
	});
});
