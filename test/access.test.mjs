import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createAccessVerifier, cookie } from "../dist/web/access.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TEAM = "myteam.cloudflareaccess.com", AUD = "aud-123";
function token(payload, key = privateKey, kid = "k1") {
  const h = b64({ alg: "RS256", kid, typ: "JWT" }), p = b64(payload);
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}
const now = Math.floor(Date.now() / 1000);
const good = { aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, email: "me@example.com", sub: "u1" };
const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchJwks: async () => ({ keys: [jwk] }) });

test("accepts a valid Access token", async () => {
  assert.equal((await v(token(good))).email, "me@example.com");
});
test("rejects forged, expired, wrong-app and wrong-team tokens", async () => {
  await assert.rejects(v(token(good, other.privateKey)), /bad signature/);
  await assert.rejects(v(token({ ...good, exp: now - 120 })), /expired/);
  await assert.rejects(v(token({ ...good, aud: ["someone-else"] })), /different application/);
  await assert.rejects(v(token({ ...good, iss: "https://evil.cloudflareaccess.com" })), /different team/);
  await assert.rejects(v(""), /missing/);
  await assert.rejects(v("a.b"), /malformed/);
});
test("reads cookies", () => {
  assert.equal(cookie("a=1; CF_Authorization=xyz; b=2", "CF_Authorization"), "xyz");
  assert.equal(cookie(undefined, "x"), null);
});
