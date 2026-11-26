#!/usr/bin/env node
// Sets the password for remote (quick-tunnel) access:  npm run web:password
// Prompts twice without echoing, requires 12+ characters, and stores only a salted scrypt hash in
// .web-password (0600, git-ignored). Restart the panel to use a new password.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { hashPassword, MIN_PASSWORD_LENGTH } = await import(join(ROOT, "dist", "web", "password.js"));

/** Reads a line with the terminal's echo turned off (raw mode), like other password prompts. */
function ask(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) { // piped input: read one line without prompting tricks
      let buf = "";
      stdin.setEncoding("utf8");
      const onData = (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) { stdin.off("data", onData); stdin.pause(); resolve(buf.slice(0, i).replace(/\r$/, "")); } };
      stdin.on("data", onData);
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); } // Ctrl-C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const a = await ask(`New panel password (at least ${MIN_PASSWORD_LENGTH} characters): `);
if (a.length < MIN_PASSWORD_LENGTH) { console.error(`✗ too short: use at least ${MIN_PASSWORD_LENGTH} characters (a passphrase of 3-4 words works well)`); process.exit(1); }
const b = await ask("Repeat it: ");
if (a !== b) { console.error("✗ the two entries don't match"); process.exit(1); }
writeFileSync(join(ROOT, ".web-password"), hashPassword(a) + "\n", { mode: 0o600 });
console.log("✓ saved (only a salted hash is stored, in .web-password). Restart the panel to use it.");
