// recipient como elemento de campo: sha256(XDR del ScVal Address), primeros 31 bytes (big-endian).
// El contrato hace exactamente lo mismo (addr_to_fr).
const { Address } = require("@stellar/stellar-sdk");
const crypto = require("crypto");
function recipientFr(addr) {
  const xdr = new Address(addr).toScVal().toXDR();
  const h = crypto.createHash("sha256").update(xdr).digest();
  return BigInt("0x" + h.subarray(0, 31).toString("hex"));
}
module.exports = { recipientFr };
