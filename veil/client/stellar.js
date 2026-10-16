// Helpers para invocar el contrato en testnet con @stellar/stellar-sdk (rpc.Server + TransactionBuilder).
const S = require("@stellar/stellar-sdk");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RPC_URL = process.env.RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK = S.Networks.TESTNET;
const STELLAR_BIN = process.env.STELLAR_BIN || path.join(__dirname, "../tools/stellar.exe");
const server = new S.rpc.Server(RPC_URL);

function loadDeploy() {
  const p = path.join(__dirname, "../deploy.json");
  if (!fs.existsSync(p)) throw new Error("falta deploy.json: corre scripts/deploy.sh");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Acepta un secreto S... o un alias de `stellar keys` (alice, carol, ...).
function keypair(nameOrSecret) {
  if (/^S[A-Z2-7]{55}$/.test(nameOrSecret)) return S.Keypair.fromSecret(nameOrSecret);
  const secret = execFileSync(STELLAR_BIN, ["keys", "show", nameOrSecret]).toString().trim();
  return S.Keypair.fromSecret(secret);
}

const u256 = (x) => S.nativeToScVal(BigInt(x), { type: "u256" });
const bytes = (b) => S.nativeToScVal(b, { type: "bytes" });
const addr = (a) => new S.Address(a).toScVal();
const i128 = (x) => S.nativeToScVal(BigInt(x), { type: "i128" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function simulate(contractId, method, args, source) {
  const acct = await server.getAccount(source);
  const tx = new S.TransactionBuilder(acct, { fee: "100", networkPassphrase: NETWORK })
    .addOperation(new S.Contract(contractId).call(method, ...args)).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) throw new Error("simulación falló: " + sim.error);
  return S.scValToNative(sim.result.retval);
}

async function invoke(contractId, method, args, kp) {
  const acct = await server.getAccount(kp.publicKey());
  let tx = new S.TransactionBuilder(acct, { fee: "1000000", networkPassphrase: NETWORK })
    .addOperation(new S.Contract(contractId).call(method, ...args)).setTimeout(120).build();
  tx = await server.prepareTransaction(tx); // simula + footprint + fees
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error("sendTransaction ERROR: " + JSON.stringify(sent.errorResult));
  let r;
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    r = await server.getTransaction(sent.hash);
    if (r.status !== "NOT_FOUND") break;
  }
  if (r.status !== "SUCCESS") throw new Error(`tx ${sent.hash} ${r.status}`);
  return { hash: sent.hash, ledger: r.ledger, result: r.returnValue ? S.scValToNative(r.returnValue) : undefined };
}

// Lee todos los eventos `deposit` del contrato y devuelve [{commitment, index}] ordenados por index.
async function fetchDeposits(contractId, startLedger) {
  const topic = S.xdr.ScVal.scvSymbol("deposit").toXDR("base64");
  const out = [];
  let cursor;
  for (;;) {
    const req = { filters: [{ type: "contract", contractIds: [contractId], topics: [[topic]] }], limit: 1000 };
    if (cursor) req.cursor = cursor; else req.startLedger = startLedger;
    const res = await server.getEvents(req);
    for (const ev of res.events) {
      const [commitment, index] = S.scValToNative(ev.value);
      out.push({ commitment: BigInt(commitment), index: Number(index) });
    }
    if (!res.events.length || res.events.length < 1000) break;
    cursor = res.cursor;
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

const explorer = (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

module.exports = { S, server, NETWORK, loadDeploy, keypair, u256, bytes, addr, i128, simulate, invoke, fetchDeposits, explorer };
