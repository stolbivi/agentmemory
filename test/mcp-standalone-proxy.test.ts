import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { handleToolCall, listTools } from "../src/mcp/standalone.js";
import { resetHandleForTests } from "../src/mcp/rest-proxy.js";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";

type FetchMock = ReturnType<typeof vi.fn>;

function installFetch(handler: (url: string, init?: RequestInit) => Response): FetchMock {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(url.toString(), init),
  );
  (globalThis as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

const BASE = "http://localhost:3111";

describe("@agentmemory/mcp standalone — server proxy (issue #159)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetHandleForTests();
    process.env["AGENTMEMORY_URL"] = BASE;
    delete process.env["AGENTMEMORY_TOOLS"];
    delete process.env["AGENTMEMORY_SECRET"];
  });

  afterEach(() => {
    resetHandleForTests();
    globalThis.fetch = originalFetch;
    delete process.env["AGENTMEMORY_URL"];
    delete process.env["AGENTMEMORY_TOOLS"];
  });

  it("lists the full server-provided tool set when proxy is up", async () => {
    process.env["AGENTMEMORY_TOOLS"] = "all";
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/mcp/tools")) {
        return new Response(
          JSON.stringify({
            tools: [
              { name: "memory_save", description: "Save", inputSchema: { type: "object", properties: {} } },
              { name: "memory_consolidate", description: "Consolidate", inputSchema: { type: "object", properties: {} } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const res = await listTools();
    expect(res.tools.map((t) => t.name)).toEqual([
      "memory_save",
      "memory_consolidate",
    ]);
  });

  it("falls back to locally implemented visible tools when proxy is down", async () => {
    process.env["AGENTMEMORY_TOOLS"] = "all";
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    const res = await listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("memory_save");
    expect(names).toContain("memory_audit");
    expect(names).not.toContain("memory_consolidate");
  });

  it("proxies tools that are not implemented by the local fallback", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/mcp/call")) {
        const body = JSON.parse((init?.body as string) || "{}");
        return new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({ proxied: body.name }),
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const res = await handleToolCall("memory_consolidate", {});
    expect(JSON.parse(res.content[0].text)).toEqual({
      proxied: "memory_consolidate",
    });
  });

  it("proxies memory_sessions to GET /agentmemory/sessions when server is up", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    installFetch((url, init) => {
      calls.push({ url, method: init?.method || "GET" });
      if (url.endsWith("/agentmemory/livez")) {
        return new Response("ok", { status: 200 });
      }
      if (url.includes("/agentmemory/sessions")) {
        return new Response(
          JSON.stringify({ sessions: [{ id: "sess-1", observations: 69 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const res = await handleToolCall("memory_sessions", { limit: 5 });
    const body = JSON.parse(res.content[0].text);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe("sess-1");
    expect(calls.find((c) => c.url.includes("/sessions"))).toBeDefined();
  });

  it("proxies memory_smart_search to POST /agentmemory/smart-search", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/smart-search")) {
        const body = JSON.parse((init?.body as string) || "{}");
        return new Response(
          JSON.stringify({
            mode: "compact",
            query: body.query,
            results: [{ id: "m1", score: 0.9 }],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    const res = await handleToolCall("memory_smart_search", { query: "auth bug", limit: 5 });
    const body = JSON.parse(res.content[0].text);
    expect(body.query).toBe("auth bug");
    expect(body.results[0].id).toBe("m1");
  });

  it("local fallback returns the same shape as proxy for memory_smart_search", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const localKv = new InMemoryKV(undefined);
    await handleToolCall("memory_save", { content: "shape-check entry" }, localKv);
    const res = await handleToolCall("memory_smart_search", { query: "shape" }, localKv);
    const body = JSON.parse(res.content[0].text);
    expect(body).toHaveProperty("mode", "compact");
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results[0].content).toBe("shape-check entry");
  });

  it("attaches Bearer token on the proxied tool request, not just the probe", async () => {
    process.env["AGENTMEMORY_SECRET"] = "s3cret";
    const authByPath = new Map<string, string | undefined>();
    installFetch((url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.[
        "authorization"
      ];
      const u = new URL(url);
      authByPath.set(u.pathname, auth);
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    });
    await handleToolCall("memory_sessions", {});
    expect(authByPath.get("/agentmemory/livez")).toBe("Bearer s3cret");
    expect(authByPath.get("/agentmemory/sessions")).toBe("Bearer s3cret");
  });

  it("falls back to local InMemoryKV when server is unreachable", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const localKv = new InMemoryKV(undefined);
    await handleToolCall("memory_save", { content: "local only" }, localKv);
    const recall = await handleToolCall("memory_recall", { query: "local" }, localKv);
    const out = JSON.parse(recall.content[0].text);
    expect(out.mode).toBe("compact");
    expect(out.results).toHaveLength(1);
    expect(out.results[0].content).toBe("local only");
  });

  it("invalidates the handle on proxy failure, so the next call re-probes", async () => {
    let probeCount = 0;
    let serverUp = true;
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) {
        probeCount++;
        return serverUp ? new Response("ok", { status: 200 }) : new Response("", { status: 500 });
      }
      return new Response("boom", { status: 500, statusText: "Internal Server Error" });
    });
    const localKv = new InMemoryKV(undefined);
    await handleToolCall("memory_save", { content: "first fallback" }, localKv);
    expect(probeCount).toBe(1);
    serverUp = false;
    await handleToolCall("memory_save", { content: "second fallback" }, localKv);
    expect(probeCount).toBe(2);
  });

  it("does not retry local after a validation error", async () => {
    const fetchFn = installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const localKv = new InMemoryKV(undefined);
    await expect(
      handleToolCall("memory_save", { content: "" }, localKv),
    ).rejects.toThrow("content is required");
    const remembersCalled = fetchFn.mock.calls.some(([url]) =>
      String(url).endsWith("/agentmemory/remember"),
    );
    expect(remembersCalled).toBe(false);
  });
});
