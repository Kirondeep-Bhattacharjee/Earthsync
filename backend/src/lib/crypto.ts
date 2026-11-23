import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM: encrypts and also detects tampering. The nonce is random per
// message and stored in front of the ciphertext; the 16-byte tag goes at the end.
const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type EncryptedText = { bodyEnc: string; keyVersion: number };

// Read lazily (not at import time) so dotenv has already loaded the .env file.
function keyFor(version: number): Buffer {
    const raw = process.env[`CHAT_ENC_KEY_${version}`];

    if (!raw) {
        throw new Error(`CHAT_ENC_KEY_${version} is not set`);
    }

    const key = Buffer.from(raw, "base64");

    if (key.length !== 32) {
        throw new Error(`CHAT_ENC_KEY_${version} must be 32 bytes (base64)`);
    }

    return key;
}

// Which key encrypts new messages. Old rows keep the version they were written
// with, so you can rotate by adding CHAT_ENC_KEY_2 and bumping this to 2.
export function currentKeyVersion(): number {
    const version = Number(process.env.CHAT_ENC_KEY_VERSION);

    if (!Number.isInteger(version) || version < 1) {
        throw new Error("CHAT_ENC_KEY_VERSION must be a positive integer");
    }

    return version;
}

// Extra data that must match on decrypt. Binds a ciphertext to its thread and
// sender, so a copied row can't be replayed into another conversation.
export function messageAad(conversationId: number, senderId: number): string {
    return `${conversationId}:${senderId}`;
}

export function encryptText(plain: string, aad: string): EncryptedText {
    const keyVersion = currentKeyVersion();
    const nonce = randomBytes(NONCE_BYTES);

    const cipher = createCipheriv(ALGORITHM, keyFor(keyVersion), nonce, {
        authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(aad, "utf8"));

    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
        bodyEnc: Buffer.concat([nonce, data, tag]).toString("base64"),
        keyVersion,
    };
}

// Throws if the key is wrong, the data was changed, or the aad doesn't match.
export function decryptText(
    bodyEnc: string,
    keyVersion: number,
    aad: string
): string {
    const buf = Buffer.from(bodyEnc, "base64");

    if (buf.length < NONCE_BYTES + TAG_BYTES) {
        throw new Error("Encrypted message is malformed");
    }

    const nonce = buf.subarray(0, NONCE_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    const data = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, keyFor(keyVersion), nonce, {
        authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
        "utf8"
    );
}