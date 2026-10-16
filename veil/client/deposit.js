// node client/deposit.js [alice]  -> deposita 10 XLM y devuelve la nota secreta.
const tree = require("./tree");
const { loadDeploy, keypair, u256, addr, invoke, explorer } = require("./stellar");

(async () => {
  const who = process.argv[2] || "alice";
  const { contractId } = loadDeploy();
  await tree.init();
  const nullifier = tree.randomField(), secret = tree.randomField();
  const commitment = tree.commitment(nullifier, secret);
  const note = `veil-${nullifier.toString(16).padStart(62, "0")}-${secret.toString(16).padStart(62, "0")}`;
  const kp = keypair(who);
  console.error(`[deposit] ${who} (${kp.publicKey()}) -> commitment ${commitment.toString(16).slice(0, 16)}...`);
  const r = await invoke(contractId, "deposit", [addr(kp.publicKey()), u256(commitment)], kp);
  console.error(`[deposit] OK leaf_index=${r.result} tx=${r.hash}\n[deposit] ${explorer(r.hash)}`);
  console.log(note); // stdout: solo la nota (para scripts)
})().catch((e) => { console.error("[deposit] ERROR", e.message || e); process.exit(1); });
