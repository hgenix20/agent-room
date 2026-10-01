import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accessJwt } from "./access-helpers";

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

async function page(path: string, signedIn = true): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": "10.250.0.2" };
  if (signedIn) headers["cf-access-jwt-assertion"] = await accessJwt();
  return SELF.fetch(`https://room.test${path}`, { headers });
}

describe("the page", () => {
  it("serves the shell with a strict content policy", async () => {
    for (const path of ["/ui", "/ui/"]) {
      const r = await page(path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("content-security-policy")).toBe(CSP);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      const html = await r.text();
      expect(html).toContain('<script type="module" src="/ui/app.js"></script>');
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
      expect(html).not.toContain("style=");
    }
  });

  it("serves the stylesheet and both modules with their types", async () => {
    const css = await page("/ui/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    for (const path of ["/ui/app.js", "/ui/logic.js"]) {
      const r = await page(path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("javascript");
      expect(r.headers.get("content-security-policy")).toBe(CSP);
      await r.text();
    }
  });

  it("gives nothing to a request with no Access header", async () => {
    for (const path of ["/ui", "/ui/app.js", "/ui/logic.js", "/ui/style.css"]) {
      const r = await page(path, false);
      expect(r.status).toBe(403);
      await r.text();
    }
  });

  it("serves only its four files", async () => {
    for (const path of ["/ui/index.html", "/ui/nope.js", "/ui/../wrangler.toml", "/ui/app.js/"]) {
      const r = await page(path);
      expect(r.status).toBe(404);
      await r.text();
    }
    const post = await SELF.fetch("https://room.test/ui", { method: "POST", headers: { "cf-access-jwt-assertion": await accessJwt() } });
    expect(post.status).toBe(405);
  });

  it("never builds HTML from room text", async () => {
    const js = await (await page("/ui/app.js")).text();
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) expect(js).not.toContain(banned);
    expect(js).toContain("textContent");
  });

  it("leaves the public routes as they were", async () => {
    for (const path of ["/", "/health"]) {
      const r = await page(path, false);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ service: "agent-room", ok: true });
    }
  });
});
