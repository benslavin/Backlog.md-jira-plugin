import pino from "pino";

// Use pino-pretty transport only in development to avoid bundling issues
// In production/bundled mode, use basic pino logger
// Note: Redact feature is disabled to avoid bundling compatibility issues
const isDevelopment = process.env.NODE_ENV === "development";

// Error objects have no enumerable properties, so without a serializer an
// `{ error }` binding is logged as `{}`. Serialize both pino's `err` key and the
// `error` key used throughout the plugin with the standard error serializer.
export const serializers = {
	err: pino.stdSerializers.err,
	error: pino.stdSerializers.err,
};

export const logger = isDevelopment
	? pino({
			level: process.env.LOG_LEVEL || "info",
			serializers,
			transport: {
				target: "pino-pretty",
				options: {
					colorize: true,
					translateTime: "HH:MM:ss",
					ignore: "pid,hostname",
				},
			},
		})
	: pino({
			level: process.env.LOG_LEVEL || "info",
			serializers,
		});

/**
 * Set the logger level dynamically
 * Useful for temporarily suppressing logs in commands
 */
export function setLogLevel(
	level: "trace" | "debug" | "info" | "warn" | "error" | "fatal",
) {
	logger.level = level;
}

/**
 * Get the current logger level
 */
export function getLogLevel(): string {
	return logger.level;
}
