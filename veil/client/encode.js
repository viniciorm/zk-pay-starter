// Serialización snarkjs -> host functions BN254 de Soroban (formato EIP-197, big-endian).
// G1: be32(x) || be32(y).  G2: be32(x.c1) || be32(x.c0) || be32(y.c1) || be32(y.c0).
const be32 = (x) => Buffer.from(BigInt(x).toString(16).padStart(64, "0"), "hex");
const g1 = (p) => Buffer.concat([be32(p[0]), be32(p[1])]);
const g2 = (p) => Buffer.concat([be32(p[0][1]), be32(p[0][0]), be32(p[1][1]), be32(p[1][0])]);
module.exports = { be32, g1, g2 };
