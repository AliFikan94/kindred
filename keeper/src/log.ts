export type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, f?: Record<string, unknown>): void;
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
  error(msg: string, f?: Record<string, unknown>): void;
}

const replacer = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export function createLogger(min: Level = 'info', sink: (line: string) => void = (l) => console.log(l)): Logger {
  const emit = (level: Level, msg: string, f?: Record<string, unknown>) => {
    if (order[level] < order[min]) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level, msg, ...f }, replacer));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
