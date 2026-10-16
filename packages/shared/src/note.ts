import { fieldFromBe32, fieldToBe32, Fr, parseField } from "./field";

export const DOMAIN_NULLIFIER = 1n;

export type Note = {
  nullifier: bigint;
  secret: bigint;
};

/** Encode a note as 64 bytes: nullifier || secret, each a 32-byte BE field. */
export function encodeNote(note: Note): Uint8Array {
  const out = new Uint8Array(64);
  out.set(fieldToBe32(note.nullifier), 0);
  out.set(fieldToBe32(note.secret), 32);
  return out;
}

export function decodeNote(bytes: Uint8Array | string): Note {
  let buf: Uint8Array;
  if (typeof bytes === "string") {
    const hex = bytes.startsWith("0x") ? bytes.slice(2) : bytes;
    buf = Uint8Array.from(Buffer.from(hex, "hex"));
  } else {
    buf = bytes;
  }
  if (buf.length !== 64) throw new Error("note encoding must be 64 bytes");
  return {
    nullifier: fieldFromBe32(buf.slice(0, 32)),
    secret: fieldFromBe32(buf.slice(32, 64)),
  };
}

export function noteToHex(note: Note): string {
  return Buffer.from(encodeNote(note)).toString("hex");
}

export function parseNoteFields(nullifier: string | bigint, secret: string | bigint): Note {
  return { nullifier: Fr(parseField(nullifier)), secret: Fr(parseField(secret)) };
}

import { hash2 } from "./poseidon";

export function commitment(note: Note): bigint {
  return hash2(note.nullifier, note.secret);
}

export function nullifierHash(nullifier: bigint): bigint {
  return hash2(nullifier, DOMAIN_NULLIFIER);
}
