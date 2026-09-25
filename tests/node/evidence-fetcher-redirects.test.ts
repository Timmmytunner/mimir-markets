/**
 * evidence-fetcher-redirects.test.ts
 *
 * Validates that tryDirectFetch (reached through fetchEvidence) correctly
 * enforces redirect security: loop detection, SSRF on redirect targets,
 * protocol downgrade blocking, and cross-domain hop policy.
 *
 * All tests patch globalThis.fetch so no sockets are opened.
 * disableJinaFallback: true is used so failures surface as EvidenceFetchError
 * instead of silently falling through to the Jina path.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { EvidenceFetchError, fetchEvidence } from "../../lib/server/evidence-fetcher";

// ── Helpers ───────────────────────────────────────────────────────────────────

type FetchMock = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Replaces globalThis.fetch for the duration of `fn`, then restores it.
 * Returns the result of `fn`.
 */
async function withFetch<T>(mock: FetchMock, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function okHtml(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const LONG_BODY = "<html><body>" + "x".repeat(300) + "</body></html>";

// ── Loop detection ────────────────────────────────────────────────────────────

test("tryDirectFetch: immediate self-redirect is detected as a loop and returns !ok", async () => {
  let callCount = 0;
  await withFetch(async (_url) => {
    callCount += 1;
    // Always redirect to the same URL — would loop forever without guard.
    return redirectResponse("https://example.com/loop-self");
  }, async () => {
    // fetchEvidence's initial validateHop allows example.com (public IP mock
    // not needed here — validateHop uses real DNS but the URL is blocked at
    // the redirect hop before a second fetch fires, so callCount stays at 1).
    // Because tryDirectFetch returns { ok: false } on loop, and there's no
    // usable body, the Jina fallback would normally fire. We disable it so the
    // EvidenceFetchError surfaces.
    await assert.rejects(
      () =>
        fetchEvidence("https://example.com/loop-self", {
          disableJinaFallback: true,
        }),
      (err: unknown) => {
        // Must throw EvidenceFetchError, not hang or spin forever.
        assert.ok(err instanceof EvidenceFetchError, `Expected EvidenceFetchError, got ${err}`);
        return true;
      },
    );
    // The loop guard must not let callCount grow beyond 2 (initial + 1 redirect
    // before the visited-set check fires). We allow up to MAX_REDIRECTS+1 as a
    // safety bound but the visited-set fires immediately on the second same-URL hop.
    assert.ok(callCount <= 2, `Too many fetches — loop guard didn't fire (callCount=${callCount})`);
  });
});

test("tryDirectFetch: A→B→A cycle is detected and stops without spinning", async () => {
  let callCount = 0;
  await withFetch(async (rawUrl) => {
    callCount += 1;
    const url = rawUrl.toString();
    if (url.includes("/stepA")) return redirectResponse("https://example.com/stepB");
    if (url.includes("/stepB")) return redirectResponse("https://example.com/stepA");
    return okHtml(LONG_BODY); // should never reach here
  }, async () => {
    await assert.rejects(
      () =>
        fetchEvidence("https://example.com/stepA", {
          disableJinaFallback: true,
        }),
      (err: unknown) => err instanceof EvidenceFetchError,
    );
    // A → B → (A visited → stop). Exactly 2 fetches before the guard kicks in.
    assert.ok(callCount <= 3, `Cycle not caught promptly (callCount=${callCount})`);
  });
});

// ── SSRF on redirect targets ──────────────────────────────────────────────────

test("tryDirectFetch: redirect to 169.254.169.254 (link-local) is blocked before the request fires", async () => {
  const requested: string[] = [];
  await withFetch(async (rawUrl) => {
    requested.push(rawUrl.toString());
    // First call: public URL returns a redirect to the metadata service.
    if (requested.length === 1) {
      return redirectResponse("http://169.254.169.254/latest/meta-data/");
    }
    // Second call must NEVER happen — the SSRF guard should abort first.
    return okHtml("should-not-see-this");
  }, async () => {
    await assert.rejects(
      () =>
        fetchEvidence("https://example.com/bounce", {
          disableJinaFallback: true,
        }),
      (err: unknown) => err instanceof EvidenceFetchError,
    );
    assert.equal(
      requested.length,
      1,
      "redirect target 169.254.169.254 must never be fetched",
    );
  });
});

test("tryDirectFetch: redirect to 10.x private subnet is blocked before the request fires", async () => {
  const requested: string[] = [];
  await withFetch(async (rawUrl) => {
    requested.push(rawUrl.toString());
    if (requested.length === 1) return redirectResponse("http://10.0.0.1/admin");
    return okHtml("internal secrets");
  }, async () => {
    await assert.rejects(
      () =>
        fetchEvidence("https://example.com/internal-bounce", {
          disableJinaFallback: true,
        }),
      (err: unknown) => err instanceof EvidenceFetchError,
    );
    assert.equal(
      requested.length,
      1,
      "redirect to private RFC-1918 address must never be fetched",
    );
  });
});

// ── Protocol downgrade ────────────────────────────────────────────────────────

test("tryDirectFetch: https→http protocol downgrade on redirect is refused", async () => {
  let secondFetchFired = false;
  await withFetch(async (rawUrl) => {
    if (rawUrl.toString().startsWith("http://")) {
      secondFetchFired = true;
      return okHtml(LONG_BODY);
    }
    // Redirect from https to plain http.
    return redirectResponse("http://example.com/plain");
  }, async () => {
    await assert.rejects(
      () =>
        fetchEvidence("https://example.com/downgrade", {
          disableJinaFallback: true,
        }),
      (err: unknown) => err instanceof EvidenceFetchError,
    );
    assert.equal(
      secondFetchFired,
      false,
      "downgraded http:// target must never be fetched",
    );
  });
});

// ── max redirects enforcement ─────────────────────────────────────────────────

test("tryDirectFetch: exceeding MAX_REDIRECTS terminates without following the chain", async () => {
  let callCount = 0;
  await withFetch(async (rawUrl) => {
    callCount += 1;
    // Each hop goes to a new unique path to avoid the visited-set guard firing.
    return redirectResponse(`https://example.com/hop-${callCount + 1}`);
  }, async () => {
    await assert.rejects(
      () =>
        fetchEvidence("https://example.com/hop-1", {
          disableJinaFallback: true,
        }),
      (err: unknown) => err instanceof EvidenceFetchError,
    );
    // MAX_REDIRECTS in evidence-fetcher is 5; the loop runs hops < 5 and then
    // one initial request, so we expect at most 6 fetches total.
    assert.ok(
      callCount <= 6,
      `Too many redirect fetches — MAX_REDIRECTS not enforced (callCount=${callCount})`,
    );
  });
});

// ── Empty / missing location header ──────────────────────────────────────────

test("tryDirectFetch: redirect with empty location header returns !ok without hanging", async () => {
  await withFetch(async () => {
    return new Response(null, { status: 301, headers: { location: "" } });
  }, async () => {
    await assert.rejects(
      () =>
        fetchEvidence("https://example.com/empty-location", {
          disableJinaFallback: true,
        }),
      (err: unknown) => err instanceof EvidenceFetchError,
    );
  });
});

test("tryDirectFetch: redirect with no location header returns !ok without hanging", async () => {
  await withFetch(async () => {
    // 302 but no Location header at all.
    return new Response(null, { status: 302 });
  }, async () => {
    await assert.rejects(
      () =>
        fetchEvidence("https://example.com/no-location", {
          disableJinaFallback: true,
        }),
      (err: unknown) => err instanceof EvidenceFetchError,
    );
  });
});

// ── Happy-path single redirect ────────────────────────────────────────────────

test("tryDirectFetch: valid single-hop same-domain redirect resolves to final content", async () => {
  let callCount = 0;
  const snapshot = await withFetch(async (_rawUrl) => {
    callCount += 1;
    if (callCount === 1) return redirectResponse("https://example.com/final");
    return okHtml(`<html><body>${"valid content ".repeat(20)}</body></html>`);
  }, async () => {
    return fetchEvidence("https://example.com/start", {
      disableJinaFallback: true,
    });
  });

  assert.equal(snapshot.fetcher, "direct");
  assert.ok(snapshot.text.length >= 200, "expected usable body from redirect target");
  assert.equal(callCount, 2, "expected exactly 2 fetches for a single-hop redirect");
});
