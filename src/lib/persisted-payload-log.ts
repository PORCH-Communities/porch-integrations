import { put } from "@vercel/blob";

type PersistPayloadLogInput = {
  receivedAt: string;
  event: string;
  rawBody: string;
  summary: unknown;
};

type PersistedPayloadLog =
  | {
      ok: true;
      pathname: string;
      url: string;
    }
  | {
      ok: false;
      reason: "disabled" | "missing_blob_token" | "persist_failed" | "persist_timeout";
    };

export async function persistPayloadLog(input: PersistPayloadLogInput): Promise<PersistedPayloadLog> {
  if (process.env.ENABLE_PERSISTED_GIVEBUTTER_PAYLOAD_LOG !== "true") {
    return { ok: false, reason: "disabled" };
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return { ok: false, reason: "missing_blob_token" };
  }

  try {
    const pathname = buildPayloadLogPath(input.receivedAt);
    const body = JSON.stringify({
      source: "givebutter-webhook-payload",
      receivedAt: input.receivedAt,
      event: input.event,
      summary: input.summary,
      payload: JSON.parse(input.rawBody),
    });
    const blob = await withTimeout(
      put(pathname, body, {
        access: "private",
        contentType: "application/json",
      }),
      5000,
    );

    return {
      ok: true,
      pathname,
      url: blob.url,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "persist_timeout") {
      return { ok: false, reason: "persist_timeout" };
    }

    return { ok: false, reason: "persist_failed" };
  }
}

function buildPayloadLogPath(receivedAt: string): string {
  const date = receivedAt.slice(0, 10);
  const safeTimestamp = receivedAt.replace(/[:.]/g, "-");
  const nonce = crypto.randomUUID();

  return `givebutter-payload-logs/${date}/${safeTimestamp}-${nonce}.json`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("persist_timeout")), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === "persist_timeout") {
      throw error;
    }

    throw new Error("persist_failed");
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
