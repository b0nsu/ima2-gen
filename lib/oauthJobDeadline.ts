type OAuthAbortKind = "cancel" | "request-timeout" | "job-timeout";

/** One OAuth image job owns its deadline; reasons are safe to surface to clients. */
export class OAuthJobAbort extends Error {
  override readonly name = "AbortError";
  readonly status: number;
  readonly code: string;
  constructor(kind: OAuthAbortKind) {
    super(kind !== "cancel" ? "OAuth image generation timed out" : "Generation canceled");
    this.status = kind === "cancel" ? 499 : 504;
    this.code = kind === "cancel" ? "GENERATION_CANCELED"
      : kind === "job-timeout" ? "OAUTH_IMAGE_TIMEOUT" : "RESPONSES_IMAGE_TIMEOUT";
  }
}

export function normalizeOAuthTimeout(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.ceil(value)) : 0;
}

export function oauthAbortError(signal?: AbortSignal | null): OAuthJobAbort {
  return signal?.reason instanceof OAuthJobAbort ? signal.reason : new OAuthJobAbort("cancel");
}

export function throwIfOAuthAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw oauthAbortError(signal);
}

function createDeadline(timeoutMs: number, parent: AbortSignal | null | undefined, kind: OAuthAbortKind) {
  const controller = new AbortController();
  const onCancel = () => controller.abort(oauthAbortError(parent));
  if (parent?.aborted) onCancel();
  else parent?.addEventListener("abort", onCancel, { once: true });
  const duration = normalizeOAuthTimeout(timeoutMs);
  const timer = duration && !controller.signal.aborted
    ? setTimeout(() => controller.abort(new OAuthJobAbort(kind)), duration)
    : undefined;
  return {
    signal: controller.signal,
    timeoutMs: duration,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onCancel);
    },
  };
}

export function createOAuthJobDeadline(timeoutMs: number, parent?: AbortSignal | null) {
  return createDeadline(timeoutMs, parent, "job-timeout");
}

export function createOAuthRequestDeadline(timeoutMs: number, parent?: AbortSignal | null) {
  return createDeadline(timeoutMs, parent, "request-timeout");
}

/** Observe late settlement even when abort wins; do not race irreversible local writes. */
export async function withOAuthAbort<T>(run: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
  throwIfOAuthAborted(signal);
  if (!signal) return run();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(oauthAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => { throwIfOAuthAborted(signal); return run(); }),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
