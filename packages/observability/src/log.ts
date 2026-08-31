/**
 * Structured logging.
 *
 * Two audiences, and they want opposite things. A person tailing a dev server
 * wants one readable line; a log aggregator wants one JSON object with stable
 * field names it can index and alert on. Writing prose to stdout and hoping a
 * regex picks it up later is how "which request was that?" becomes unanswerable
 * at exactly the moment somebody needs the answer.
 *
 * So the same call produces both, chosen by NODE_ENV rather than by the caller —
 * a logger whose shape depends on who is calling it drifts within a week.
 *
 * Deliberately small. This is not a logging framework: it is a function that
 * writes a line, plus the two things a hand-rolled logger always gets wrong —
 * redaction and level filtering.
 */

export const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
export type Level = (typeof LEVELS)[number]

const ORDER: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

/**
 * Field names whose values never reach a log line.
 *
 * Matched on the KEY, case-insensitively, at any depth — not on the value,
 * because a token is just a string and there is no reliable way to recognise
 * one after the fact. Getting this wrong writes a live credential into a file
 * that is, by design, copied to somewhere central and kept for months.
 *
 * The list errs towards over-redaction. A field wrongly hidden costs one
 * debugging session; a field wrongly shown costs a credential rotation.
 */
const SECRET_KEY = /(token|secret|password|passwd|credential|authorization|cookie|apikey|api_key|accesskey|private|signature|encryptionkey)/i

const REDACTED = '[redacted]'

/** Depth limit, so a cyclic or enormous object cannot stall the process. */
const MAX_DEPTH = 6

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[truncated]'

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))

  // An Error does not serialise usefully through JSON.stringify — message and
  // stack are non-enumerable, so a caught error logs as `{}`, which is the
  // least useful possible record of a failure.
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack.split('\n').slice(0, 8).join('\n') } : {}),
    }
  }

  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redact(val, depth + 1)
  }
  return out
}

export type LogFields = Record<string, unknown>

export type Logger = {
  trace: (msg: string, fields?: LogFields) => void
  debug: (msg: string, fields?: LogFields) => void
  info: (msg: string, fields?: LogFields) => void
  warn: (msg: string, fields?: LogFields) => void
  error: (msg: string, fields?: LogFields) => void
  fatal: (msg: string, fields?: LogFields) => void
  /** A logger that carries these fields on every line — a request id, say. */
  child: (fields: LogFields) => Logger
}

type Options = {
  level?: Level
  /** Fields written on every line from this logger. */
  base?: LogFields
  /** JSON when true, human-readable when false. Defaults from NODE_ENV. */
  json?: boolean
  /** Injected so tests can capture output without touching global state. */
  write?: (line: string) => void
}

const GREY = '[90m'
const RESET = '[0m'
const COLOUR: Record<Level, string> = {
  trace: GREY,
  debug: GREY,
  info: '[36m',
  warn: '[33m',
  error: '[31m',
  fatal: '[35m',
}

function pretty(level: Level, msg: string, fields: LogFields): string {
  const time = new Date().toISOString().slice(11, 23)
  const rest = Object.entries(fields)
    .map(([k, v]) => `${GREY}${k}=${RESET}${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
  return `${GREY}${time}${RESET} ${COLOUR[level]}${level.toUpperCase().padEnd(5)}${RESET} ${msg}${rest ? ' ' + rest : ''}`
}

export function createLogger(options: Options = {}): Logger {
  const level = options.level ?? (process.env['LOG_LEVEL'] as Level | undefined) ?? 'info'
  const threshold = ORDER[level] ?? ORDER.info
  const json = options.json ?? process.env['NODE_ENV'] === 'production'
  const write = options.write ?? ((line: string) => process.stdout.write(line + '\n'))
  const base = options.base ?? {}

  function emit(at: Level, msg: string, fields?: LogFields): void {
    if (ORDER[at] < threshold) return

    const merged = redact({ ...base, ...fields }) as LogFields

    if (json) {
      // Field order is deliberate: time, level and msg first, so a truncated
      // line in a viewer still says what happened and when.
      write(JSON.stringify({ time: new Date().toISOString(), level: at, msg, ...merged }))
    } else {
      write(pretty(at, msg, merged))
    }
  }

  const logger: Logger = {
    trace: (m, f) => emit('trace', m, f),
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    fatal: (m, f) => emit('fatal', m, f),
    child: (fields) =>
      createLogger({
        ...options,
        level,
        base: { ...base, ...fields },
        json,
        write,
      }),
  }

  return logger
}

/** The process-wide logger. Most callers want a `child` of this. */
export const log = createLogger()
