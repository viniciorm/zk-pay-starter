// node client/withdraw.js <nota> <recipient G...> [signer=carol]
// Reconstruye el árbol desde eventos, genera la prueba Groth16 y llama withdraw firmando con `signer`.
const path = require("path");
const snarkjs = require("snarkjs");
const tree = require("./tree");
const { recipientFr } = require("./addr");
const { privacyAdvisor } = require("./openrouter");
const { g1, g2 } = require("./encode");
const { loadDeploy, keypair, u256, bytes, addr, invoke, simulate, fetchDeposits, explorer } = require("./stellar");

(async () => {
  const [note, recipient, signer = "carol"] = process.argv.slice(2);
  if (!note || !recipient) { console.error("uso: node client/withdraw.js <nota> <recipient> [signer]"); process.exit(2); }
  const m = /^veil-([0-9a-f]+)-([0-9a-f]+)$/.exec(note.trim());
  if (!m) throw new Error("nota inválida");
  const nullifier = BigInt("0x" + m[1]), secret = BigInt("0x" + m[2]);
  const { contractId, startLedger } = loadDeploy();
  await tree.init();
  const commitment = tree.commitment(nullifier, secret);
  const nullifierHash = tree.nullifierHash(nullifier);

  const deposits = await fetchDeposits(contractId, startLedger);
  console.error(`[withdraw] ${deposits.length} depósitos on-chain`);
  const t = new tree.MerkleTree(tree.LEVELS, deposits.map((d) => d.commitment));
  const idx = deposits.findIndex((d) => d.commitment === commitment);
  if (idx < 0) throw new Error("el commitment de la nota no está en el árbol (¿depósito no confirmado?)");
  const root = t.root();
  const kp = keypair(signer);
  const onchainRoot = await simulate(contractId, "root", [], kp.publicKey());
  if (BigInt(onchainRoot) !== root) throw new Error(`raíz local ${root} != raíz on-chain ${onchainRoot}`);

  // Paso de IA (OpenRouter) en el flujo de pago: asesor de privacidad antes de retirar.
  const advice = await privacyAdvisor({ deposits: deposits.length, leafIndex: idx });
  console.error("[withdraw] asesor de privacidad: " + advice);

  const { pathElements, pathIndices } = t.path(idx);
  const input = {
    root: root.toString(), nullifierHash: nullifierHash.toString(), recipient: recipientFr(recipient).toString(),
    nullifier: nullifier.toString(), secret: secret.toString(),
    pathElements: pathElements.map(String), pathIndices: pathIndices.map(String),
  };
  const B = path.join(__dirname, "../circuits/build");
  console.error("[withdraw] generando prueba Groth16...");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, path.join(B, "withdraw_js/withdraw.wasm"), path.join(B, "withdraw_final.zkey"));
  const vk = require(path.join(B, "verification_key.json"));
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error("la prueba no verifica localmente");

  console.error(`[withdraw] ${signer} (${kp.publicKey()}) -> withdraw a ${recipient}`);
  const r = await invoke(contractId, "withdraw", [
    bytes(g1(proof.pi_a)), bytes(g2(proof.pi_b)), bytes(g1(proof.pi_c)),
    u256(root), u256(nullifierHash), addr(recipient),
  ], kp);
  console.error(`[withdraw] OK tx=${r.hash}\n[withdraw] ${explorer(r.hash)}`);
  console.log(r.hash);
  process.exit(0); // snarkjs deja workers vivos
})().catch((e) => { console.error("[withdraw] ERROR", e.message || e); process.exit(1); });
