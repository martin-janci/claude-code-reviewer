export interface LogContext {
  traceId?: string;
  pr?: string;
  phase?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(ctx: LogContext): Logger;
}

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function createLogger(baseCtx: LogContext = {}, minLevel: LogLevel = "info"): Logger {
  const minPriority = LEVEL_PRIORITY[minLevel];

  function emit(level: LogLevel, msg: string, ctx?: LogContext): void {
    if (LEVEL_PRIORITY[level] < minPriority) return;

    const entry: Record<string, unknown> = {
      level,
      ts: new Date().toISOString(),
      msg,
      ...baseCtx,
      ...ctx,
    };

    // Remove undefined values for cleaner output
    for (const key of Object.keys(entry)) {
      if (entry[key] === undefined) delete entry[key];
    }

    const line = JSON.stringify(entry);

    if (level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  return {
    debug: (msg, ctx) => emit("debug", msg, ctx),
    info: (msg, ctx) => emit("info", msg, ctx),
    warn: (msg, ctx) => emit("warn", msg, ctx),
    error: (msg, ctx) => emit("error", msg, ctx),
    child(ctx: LogContext): Logger {
      return createLogger({ ...baseCtx, ...ctx }, minLevel);
    },
  };
}

export function createRootLogger(minLevel?: LogLevel): Logger {
  return createLogger({}, minLevel ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info");
}
