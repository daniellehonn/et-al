// Who can reach what: every route needs the API key or the session cookie,
// except health and the sign-in routes, and the cookie is HttpOnly.
import { describe, expect, it } from "vitest";
import { KEY, request } from "./helpers";

describe("open routes", () => {
  it("serves /health and /api/session without a key", async () => {
    expect((await request("/health", { auth: "none" })).status).toBe(200);
    const session = await request("/api/session", { auth: "none" });
    expect(await session.json()).toEqual({ authed: false });
  });
});

describe("reads need a credential", () => {
  it.each([["none", 401], ["wrong", 401], ["key", 200], ["bearer", 200], ["cookie", 200]] as const)(
    "GET /api/notes/tree with %s → %i",
    async (auth, status) => {
      expect((await request("/api/notes/tree", { auth })).status).toBe(status);
    },
  );

  it("gates /files, and with a key reaches R2", async () => {
    expect((await request("/files/missing.png", { auth: "none" })).status).toBe(401);
    expect((await request("/files/missing.png", { auth: "key" })).status).toBe(404);
  });
});

describe("writes need a credential", () => {
  it("refuses an unauthenticated write", async () => {
    const res = await request("/api/notes", { method: "POST", auth: "none", body: JSON.stringify({ title: "nope" }) });
    expect(res.status).toBe(401);
  });
});

describe("session cookie", () => {
  it("rejects a wrong key at login", async () => {
    const res = await request("/api/login", { method: "POST", auth: "none", body: JSON.stringify({ key: "nope" }) });
    expect(res.status).toBe(401);
  });

  it("issues an httpOnly cookie that then authenticates", async () => {
    const res = await request("/api/login", { method: "POST", auth: "none", body: JSON.stringify({ key: KEY }) });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/et_al_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const session = await request("/api/session", { auth: "none", headers: { Cookie: cookie.split(";")[0] } });
    expect(await session.json()).toEqual({ authed: true });
  });
});

describe("MCP", () => {
  it.each([["none", 401], ["wrong", 401], ["bearer", 200]] as const)("POST /mcp with %s → %i", async (auth, status) => {
    const res = await request("/mcp", {
      method: "POST", auth,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(status);
  });
});
