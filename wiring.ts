// Gắn hook prompt/context của OpenCode vào logic recall. Không import SDK, nên test được trực tiếp.
// Khóa trạng thái theo sessionID: hai phiên không lẫn kết quả của nhau.
import {
  CONTEXT_WAIT_MS,
  PENDING_TTL_MS,
  RECALL_TIMEOUT_MS,
  buildMemoryBlock,
  loadConfig,
  runRecall,
  withTimeout,
  type FetchLike,
  type RecallResult,
} from "./core.ts"
import { extractQuery, makeLogger, shortId } from "./log.ts"

export interface Deps {
  env: Record<string, string | undefined>
  fetchImpl: FetchLike
  contextWaitMs?: number
  recallTimeoutMs?: number
  logMaxBytes?: number
}

export interface HookRegistrar {
  session: { hook(name: string, fn: (event: any) => any): any }
}

type Entry = {
  promise: Promise<RecallResult>
  startedAt: number
  request: number
  resolved?: RecallResult
}

export function sessionKey(event: any): string {
  return typeof event?.sessionID === "string" && event.sessionID ? event.sessionID : ""
}

// Chèn khối memory vào system của request hiện tại. Trả về true nếu chèn được.
export function insertSystem(event: any, text: string): boolean {
  if (!event || !Array.isArray(event.system)) return false
  event.system.push({ type: "text", text })
  return true
}

export async function attach(ctx: HookRegistrar, deps: Deps): Promise<boolean> {
  const log = makeLogger(deps.env.HINDSIGHT_RECALL_LOG, deps.logMaxBytes)
  const cfg = loadConfig(deps.env)
  if (!cfg) {
    log({ event: "disabled", reason: "config_missing" })
    return false
  }
  const contextWaitMs = deps.contextWaitMs ?? CONTEXT_WAIT_MS
  const recallTimeoutMs = deps.recallTimeoutMs ?? RECALL_TIMEOUT_MS
  const pending = new Map<string, Entry>()
  let seq = 0
  log({ event: "loaded" })

  await ctx.session.hook("prompt", (event: any) => {
    try {
      for (const [k, v] of pending) if (Date.now() - v.startedAt > PENDING_TTL_MS) pending.delete(k)
      const sid = sessionKey(event)
      const request = ++seq
      if (!sid) {
        log({ event: "recall", status: "skipped", reason: "no_session", request })
        return
      }
      const query = extractQuery(event)
      if (!query) {
        pending.delete(sid)
        log({ event: "recall", status: "skipped", reason: "no_query", session: shortId(sid), request })
        return
      }
      const promise = runRecall(cfg, query, deps.fetchImpl, undefined, recallTimeoutMs).catch(
        (): RecallResult => ({ status: "error", text: "" }),
      )
      pending.set(sid, { promise, startedAt: Date.now(), request })
      log({ event: "recall_start", session: shortId(sid), request })
    } catch {
      log({ event: "hook_error", hook: "prompt" })
    }
  })

  await ctx.session.hook("context", async (event: any) => {
    const sid = sessionKey(event)
    const entry = sid ? pending.get(sid) : undefined
    if (!entry) {
      log({ event: "context", status: "no_pending", injected: false, session: shortId(sid) })
      return
    }
    try {
      const t0 = Date.now()
      if (!entry.resolved) {
        const r = await withTimeout(entry.promise, contextWaitMs)
        entry.resolved = r === "timeout" ? { status: "timeout", text: "" } : r
      }
      const result = entry.resolved
      const count = result.text ? result.text.split("\n---\n").length : 0
      const block = buildMemoryBlock(result)
      const injected = insertSystem(event, block)
      log({
        event: "context",
        status: result.status,
        results: count,
        block_chars: block.length,
        injected,
        waited_ms: Date.now() - t0,
        total_ms: Date.now() - entry.startedAt,
        session: shortId(sid),
        request: entry.request,
      })
    } catch {
      log({ event: "hook_error", hook: "context" })
    }
  })
  return true
}
