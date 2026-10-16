// Incremental Merkle tree (Tornado pattern) with Poseidon from circomlibjs.
// Convention matches circuits/withdraw.circom: pathIndices[i]=0 => leaf is LEFT.
const { buildPoseidon } = require("circomlibjs");

const LEVELS = 16;
let poseidon, F;

async function init() {
  if (!poseidon) { poseidon = await buildPoseidon(); F = poseidon.F; }
  return { poseidon, F };
}
function hash2(a, b) { return F.toObject(poseidon([a, b])); }
function hash1(a) { return F.toObject(poseidon([a])); }

function zeros(levels = LEVELS) {
  const z = [0n];
  for (let i = 1; i <= levels; i++) z.push(hash2(z[i - 1], z[i - 1]));
  return z; // z[i] = zero hash at level i (z[0] = leaf-level zero = 0)
}

class MerkleTree {
  constructor(levels = LEVELS, leaves = []) {
    this.levels = levels;
    this.zeros = zeros(levels);
    this.layers = [leaves.map(BigInt)];
    this._rebuild();
  }
  _rebuild() {
    for (let l = 0; l < this.levels; l++) {
      const prev = this.layers[l], next = [];
      for (let i = 0; i < prev.length; i += 2) {
        const left = prev[i];
        const right = i + 1 < prev.length ? prev[i + 1] : this.zeros[l];
        next.push(hash2(left, right));
      }
      this.layers[l + 1] = next;
    }
  }
  insert(leaf) { this.layers[0].push(BigInt(leaf)); this._rebuild(); return this.layers[0].length - 1; }
  root() { return this.layers[this.levels][0] ?? this.zeros[this.levels]; }
  path(index) {
    const pathElements = [], pathIndices = [];
    let idx = index;
    for (let l = 0; l < this.levels; l++) {
      const sib = idx ^ 1;
      pathElements.push(this.layers[l][sib] ?? this.zeros[l]);
      pathIndices.push(idx & 1);
      idx >>= 1;
    }
    return { pathElements, pathIndices };
  }
}

function randomField() {
  return BigInt("0x" + require("crypto").randomBytes(31).toString("hex"));
}
function commitment(nullifier, secret) { return hash2(nullifier, secret); }
function nullifierHash(nullifier) { return hash1(nullifier); }

module.exports = { init, hash1, hash2, zeros, MerkleTree, randomField, commitment, nullifierHash, LEVELS };

// CLI: node tree.js  -> prints test vector + sample input.json for the circuit
if (require.main === module) {
  (async () => {
    await init();
    console.log("Poseidon(1,2) =", "0x" + hash2(1n, 2n).toString(16));
    const { recipientFr } = require("./addr");
    const RECIPIENT = process.argv[2] || "CBBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEE5XW"; // fixture: C-address (sin trustline en test env)
    const nullifier = randomField(), secret = randomField();
    const c = commitment(nullifier, secret);
    const t = new MerkleTree();
    t.insert(hash2(7n, 8n)); // filler leaf
    const idx = t.insert(c);
    const { pathElements, pathIndices } = t.path(idx);
    const input = {
      root: t.root().toString(), nullifierHash: nullifierHash(nullifier).toString(),
      recipient: recipientFr(RECIPIENT).toString(), nullifier: nullifier.toString(), secret: secret.toString(),
      pathElements: pathElements.map(String), pathIndices: pathIndices.map(String),
    };
    require("fs").writeFileSync(__dirname + "/../circuits/build/input.json", JSON.stringify(input, null, 2));
    require("fs").writeFileSync(__dirname + "/../circuits/build/fixture.json", JSON.stringify({
      recipient: RECIPIENT, leaves: t.layers[0].map(String), root: input.root, nullifierHash: input.nullifierHash }, null, 2));
    console.log("wrote circuits/build/input.json + fixture.json; root =", input.root);
  })();
}
