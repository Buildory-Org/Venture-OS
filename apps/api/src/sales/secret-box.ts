// Encrypted secrets at rest for Sales connections (mail passwords, Meta access tokens and app secrets): AES-256-GCM under a data key derived
// from BETTER_AUTH_SECRET with HKDF-SHA256 and a per-purpose salt, a fresh 12-byte IV per seal, the GCM tag kept, and what the secret belongs
// to (e.g. "<workspace>:<account>:password") bound in as associated data, so a sealed value copied into another record's slot never opens.
// The same scheme as the company-search keys (search-keys.ts). Opening never throws: a value sealed under another secret, a damaged record or
// an unknown version reads as undefined, and the caller treats the connection as needing attention.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** One sealed secret as stored: ciphertext, IV and tag (base64), the format version, and (for long tokens only) its last four characters. */
export type SealedSecret = { v: number; iv: string; tag: string; data: string; last4?: string; setAt: Date; setBy: string };

const VERSION = 1;

export type SecretBox = {
  /** `keepLast4`: also keep the last four characters in clear (only for long random tokens, never for a password). */
  seal(value: string, boundTo: string, setBy: string, now?: Date, keepLast4?: boolean): SealedSecret;
  open(sealed: unknown, boundTo: string): string | undefined;
};

/**
 * A box for one purpose (`salt`, e.g. "vso-sales-channel-secrets-v1"). Without a server secret nothing can be sealed (seal throws) and
 * nothing opens.
 */
export function secretBox(serverSecret: string | undefined, salt: string): SecretBox {
  const key = serverSecret ? Buffer.from(hkdfSync("sha256", serverSecret, salt, `${salt}: aes-256-gcm`, 32)) : undefined;
  return {
    seal(value, boundTo, setBy, now = new Date(), keepLast4 = false) {
      if (!key) throw new Error("BETTER_AUTH_SECRET is not set: secrets cannot be stored");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(boundTo));
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return { v: VERSION, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64"), ...(keepLast4 && value.length >= 16 ? { last4: value.slice(-4) } : {}), setAt: now, setBy };
    },
    open(sealed, boundTo) {
      if (!key || !isSealed(sealed) || sealed.v !== VERSION) return undefined;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"), { authTagLength: 16 });
        decipher.setAAD(Buffer.from(boundTo));
        decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8") || undefined;
      } catch { return undefined; }
    },
  };
}

function isSealed(value: unknown): value is SealedSecret {
  const sealed = value as Partial<SealedSecret> | null;
  return typeof sealed === "object" && sealed !== null && typeof sealed.v === "number" && typeof sealed.iv === "string" && typeof sealed.tag === "string" && typeof sealed.data === "string";
}
