/**
 * Build-code URL fetcher.
 *
 * Supports:
 *   - pobb.in/<id> and pobb.in/<id>/raw — the standard PoB share host
 *   - Direct raw build-code strings (pass-through)
 *
 * Extensible to maxroll.gg + the official trade site in follow-ups, but those
 * embed builds differently (Maxroll wraps in their own redirect; trade only
 * exports character JSON). Start narrow and grow.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36 pob2-mcp/0.0.1";

export class FetchBuildError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "FetchBuildError";
    if (options?.cause) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

export interface FetchResult {
  /** The raw URL-safe base64 build code, ready for decodeBuildCode(). */
  buildCode: string;
  /** Where we resolved it from. */
  source: string;
  /** Detected host (pobb.in, raw, etc.). */
  host: string;
}

/**
 * Resolve a user-provided string to a build code:
 *   1. If it's already a base64-looking blob: return as-is.
 *   2. If it's a pobb.in URL: fetch <url>/raw.
 *   3. Otherwise: error.
 */
export async function fetchBuild(input: string, opts: { timeoutMs?: number } = {}): Promise<FetchResult> {
  const trimmed = input.trim();
  if (!trimmed) throw new FetchBuildError("Empty input");

  // Heuristic for already-a-build-code: URL-safe base64 chars only, no slashes/dots,
  // and starts with eN (zlib header signature post-base64).
  if (!/^https?:\/\//i.test(trimmed) && /^[A-Za-z0-9_=-]+$/.test(trimmed) && trimmed.length > 100) {
    return { buildCode: trimmed, source: "<raw>", host: "raw" };
  }

  // Accept bare hostnames like 'pobb.in/abc' without protocol — prepend https://.
  let toParse = trimmed;
  if (!/^https?:\/\//i.test(toParse) && /^[a-z0-9.-]+\//i.test(toParse)) {
    toParse = "https://" + toParse;
  }

  let url: URL;
  try {
    url = new URL(toParse);
  } catch {
    throw new FetchBuildError(`Not a URL and not a base64 build code: ${trimmed.slice(0, 50)}...`);
  }

  // Coerce HTTP to HTTPS for known hosts
  if (url.protocol === "http:") url.protocol = "https:";

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "pobb.in") return fetchPobbin(url, opts);

  throw new FetchBuildError(
    `Unsupported host: ${host}. Supported: pobb.in (and direct build codes).`
  );
}

async function fetchPobbin(url: URL, opts: { timeoutMs?: number }): Promise<FetchResult> {
  // pobb.in/<id>/raw returns the raw build code as text.
  // If the user passed pobb.in/<id> we append /raw.
  let rawUrl = url.toString();
  if (!rawUrl.endsWith("/raw")) rawUrl = rawUrl.replace(/\/?$/, "/raw");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000);
  let body: string;
  try {
    const res = await fetch(rawUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/plain" },
      signal: ctl.signal,
    });
    if (!res.ok) {
      throw new FetchBuildError(`pobb.in returned HTTP ${res.status} for ${rawUrl}`);
    }
    body = await res.text();
  } catch (e: unknown) {
    if ((e as { name?: string }).name === "AbortError") {
      throw new FetchBuildError(`Timeout fetching ${rawUrl}`);
    }
    throw e instanceof FetchBuildError ? e : new FetchBuildError(`Fetch failed: ${(e as Error).message}`, { cause: e });
  } finally {
    clearTimeout(timer);
  }

  const buildCode = body.trim();
  if (!buildCode) {
    throw new FetchBuildError(`pobb.in returned empty body for ${rawUrl}`);
  }
  // Sanity-check: expect URL-safe base64
  if (!/^[A-Za-z0-9_=-]+$/.test(buildCode)) {
    throw new FetchBuildError(
      `pobb.in body doesn't look like a build code (first 60 chars: ${buildCode.slice(0, 60)}...)`
    );
  }
  return { buildCode, source: rawUrl, host: "pobb.in" };
}
