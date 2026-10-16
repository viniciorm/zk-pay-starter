import { Keypair, Horizon } from "@stellar/stellar-sdk";
import { chat } from "./openrouter";

const PORT = Number(process.env.API_PORT ?? "43122");
const logs: string[] = [];
function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`;
  logs.push(line);
  if (logs.length > 200) logs.shift();
  console.log(line);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

const RATE_LIMIT_WINDOW_MS = 60000;
const MAX_REQUESTS_PER_WINDOW = 30;
const ipRequests = new Map<string, { count: number; expiresAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = ipRequests.get(ip);
  if (!record || record.expiresAt < now) {
    ipRequests.set(ip, { count: 1, expiresAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  record.count++;
  return true;
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req, server) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const clientIp = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "local";
    if (!checkRateLimit(clientIp)) {
      log(`rate-limit exceeded for ip=${clientIp}`);
      return json({ error: "Too many requests. Please slow down." }, 429);
    }

    if (url.pathname === "/health") return json({ ok: true, timestamp: Date.now() });
    if (url.pathname === "/logs") return json({ logs });

    if (url.pathname === "/fund" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { address?: string };
      let address = body.address;
      if (!address) {
        const kp = Keypair.random();
        address = kp.publicKey();
      }
      const res = await fetch(`https://friendbot.stellar.org?addr=${address}`);
      log(`friendbot ${address} status=${res.status}`);
      return json({ address, funded: res.ok, status: res.status });
    }

    if (url.pathname === "/ai/complete" && req.method === "POST") {
      const body = (await req.json()) as { prompt?: string };
      const result = await chat(body.prompt ?? "Say hello in one sentence.");
      log(`openrouter stub model=${result.model} chars=${result.text.length}`);
      return json(result);
    }

    if (url.pathname === "/prove/hello" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { path?: string };
      const provingPath = body.path === "circom" ? "circom" : "noir";
      log(`prove hello path=${provingPath}`);
      const proc = Bun.spawn(["bun", "run", "prove:hello", "--path", provingPath], {
        cwd: joinRepo(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      log(`prove hello exit=${code}`);
      return json({ ok: code === 0, out, err, path: provingPath });
    }

    if (url.pathname === "/verify/hello" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { path?: string };
      const provingPath = body.path === "circom" ? "circom" : "noir";
      log(`verify hello path=${provingPath}`);
      const proc = Bun.spawn(
        ["bun", "run", "verify:hello", "--path", provingPath, "--network", "testnet"],
        { cwd: joinRepo(), stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      log(`verify hello exit=${code}`);
      return json({ ok: code === 0, out, err, path: provingPath });
    }

    // GAP-7: AI step in the payment flow (e.g. analyze payment intent, explain withdrawal or check memo)
    if (url.pathname === "/pay/ai-step" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        action?: "deposit" | "withdraw" | "verify";
        recipient?: string;
        amount?: string;
        memo?: string;
      };
      const action = body.action ?? "withdraw";
      const prompt = `You are a privacy-preserving financial copilot on Stellar Testnet. Briefly verify and summarize the following anonymous payment action in one sentence without asking questions: Action=${action}, Recipient=${body.recipient ?? "anonymous-fresh-address"}, Amount=${body.amount ?? "10 XLM"}.`;
      log(`[openrouter] payment ai-step action=${action} recipient=${body.recipient ?? "fresh"}`);
      try {
        const result = await chat(prompt, { maxTokens: 300 });
        log(`[openrouter] payment ai-step completed model=${result.model} chars=${result.text.length}`);
        return json({ ok: true, result });
      } catch (e: any) {
        log(`[openrouter] payment ai-step error=${e?.message ?? e}`);
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    // GAP-6 / GAP-7: Proving and relaying withdraw requests
    if (url.pathname === "/pay/prove-withdraw" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        secret?: string;
        nullifier?: string;
        leafIndex?: number;
        recipient?: string;
        fee?: string;
      };
      if (!body.secret || !body.nullifier || body.leafIndex === undefined || !body.recipient) {
        return json({ ok: false, error: "Missing required proving arguments" }, 400);
      }
      try {
        const snarkjs = await import("snarkjs");
        const { commitment, nullifierHash, hash2, encodeGroth16Proof, encodeG16PublicSignals, MerkleTree } = await import("@zk-pay/shared");
        const { readFileSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");

        const secretBig = BigInt(body.secret);
        const nullifierBig = BigInt(body.nullifier);
        const cBig = commitment({ secret: secretBig, nullifier: nullifierBig });
        const nfBig = nullifierHash(nullifierBig);

        // Compute recipient field
        const { StrKey, scValToNative, xdr } = await import("@stellar/stellar-sdk");
        const rawRecipientBytes = StrKey.decodeEd25519PublicKey(body.recipient);
        const rScalar = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
        let recipientBig = 0n;
        for (let i = 0; i < 32; i++) {
          recipientBig = (recipientBig << 8n) | BigInt(rawRecipientBytes[i]);
        }
        recipientBig = recipientBig % rScalar;

        const leafIndex = Number(body.leafIndex);
        const poolId = process.env.POOL_ID || "CARO7SWGHRXZPIOL4UNEDST4IQIPMQSWYHMDQMYHX3PE62ZLG2NKUVS4";
        const rpc = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";

        // Query past deposit events from Soroban to construct the live Merkle tree
        let leaves: bigint[] = [];
        try {
          const latestRes = await fetch(rpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
          });
          const latest = (await latestRes.json()).result.sequence;
          const eventsRes = await fetch(rpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "getEvents",
              params: {
                startLedger: latest - 10000,
                filters: [{ type: "contract", contractIds: [poolId] }],
              },
            }),
          });
          const events = (await eventsRes.json()).result?.events ?? [];
          for (const ev of events) {
            try {
              const val = xdr.ScVal.fromXDR(ev.value, "base64");
              const native = scValToNative(val);
              if (native && native.commitment !== undefined) {
                leaves[Number(native.index)] = BigInt(native.commitment.toString());
              }
            } catch {}
          }
        } catch (e) {
          log(`could not fetch events: ${e}`);
        }

        // Ensure our leaf is placed at the specified leafIndex
        leaves[leafIndex] = cBig;

        const tree = new MerkleTree(8);
        for (let i = 0; i < leaves.length; i++) {
          tree.insert(leaves[i] ?? 0n);
        }
        const proofObj = tree.proof(leafIndex);
        const expectedRoot = proofObj.root;
        const elements = proofObj.pathElements.map((x) => x.toString());
        const indices = proofObj.pathIndices;

        const circomDir = join(joinRepo(), "circuits/circom/withdraw");
        const wasmPath = join(circomDir, "withdraw_js/withdraw.wasm");
        const zkeyPath = join(joinRepo(), "artifacts/circom/withdraw/withdraw.zkey");

        const circuitInput = {
          root: expectedRoot.toString(),
          nullifierHash: nfBig.toString(),
          recipient: recipientBig.toString(),
          fee: "0",
          secret: secretBig.toString(),
          nullifier: nullifierBig.toString(),
          pathElements: elements,
          pathIndices: indices,
        };

        log(`executing groth16 proof calculation...`);
        const { writeFileSync, unlinkSync } = await import("node:fs");
        const tmpInput = join(joinRepo(), `tmp_input_${Date.now()}.json`);
        const tmpProof = join(joinRepo(), `tmp_proof_${Date.now()}.json`);
        const tmpPublic = join(joinRepo(), `tmp_public_${Date.now()}.json`);

        writeFileSync(tmpInput, JSON.stringify(circuitInput));
        const proc = Bun.spawn([
          "npx", "snarkjs", "groth16", "fullprove",
          tmpInput,
          wasmPath,
          zkeyPath,
          tmpProof,
          tmpPublic
        ], { cwd: joinRepo(), stdout: "pipe", stderr: "pipe" });

        const out = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;

        if (code !== 0) {
          try { unlinkSync(tmpInput); unlinkSync(tmpProof); unlinkSync(tmpPublic); } catch {}
          log(`snarkjs fullprove failed: ${err || out}`);
          return json({ ok: false, error: err || out }, 500);
        }

        const proof = JSON.parse(readFileSync(tmpProof, "utf-8"));
        const publicSignals = JSON.parse(readFileSync(tmpPublic, "utf-8"));
        try { unlinkSync(tmpInput); unlinkSync(tmpProof); unlinkSync(tmpPublic); } catch {}

        const proofBytes = encodeGroth16Proof(proof);
        const proofHex = Buffer.from(proofBytes).toString("hex");

        log(`groth16 prove complete! nullifierHash=${nfBig.toString().slice(0, 16)}...`);
        return json({
          ok: true,
          root: expectedRoot.toString(),
          nullifierHash: nfBig.toString(),
          recipientBig: recipientBig.toString(),
          fee: "0",
          proofHex,
          publicSignals,
        });
      } catch (e: any) {
        log(`prove-withdraw error=${e?.message ?? e}`);
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    if (url.pathname === "/pay/withdraw" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        proofHex?: string;
        root?: string;
        nullifierHash?: string;
        recipient?: string;
        fee?: string;
      };
      if (!body.proofHex || !body.root || !body.nullifierHash || !body.recipient) {
        return json({ ok: false, error: "Missing withdraw parameters" }, 400);
      }
      try {
        const { join } = await import("node:path");
        const { writeFileSync, unlinkSync } = await import("node:fs");
        const tmpProof = join(joinRepo(), `tmp_proof_${Date.now()}.bin`);
        writeFileSync(tmpProof, Buffer.from(body.proofHex, "hex"));

        const poolId = process.env.POOL_ID || "CARO7SWGHRXZPIOL4UNEDST4IQIPMQSWYHMDQMYHX3PE62ZLG2NKUVS4";
        const deployerSecret = process.env.DEPLOYER_SECRET || "SAIOLVAPZTBSCKLK3LRY7A5FRVYEGV22VPW5CFSWNIN2GAIRZ4AXSAJZ";
        const rpc = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
        const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";

        log(`submitting withdraw tx to pool=${poolId}...`);
        const proc = Bun.spawn([
          "stellar", "contract", "invoke",
          "--id", poolId,
          "--source-account", deployerSecret,
          "--rpc-url", rpc,
          "--network-passphrase", passphrase,
          "--send", "yes",
          "--",
          "withdraw",
          "--proof-file-path", tmpProof,
          "--root", body.root,
          "--nullifier_hash", body.nullifierHash,
          "--recipient", body.recipient,
          "--fee", body.fee ?? "0",
          "--relayer", "GB7PUL34WQHQS2UR7YRHIGFQA34WTBGCS7OZU6RDYYHGBKXP5U2SZTMG",
        ], { stdout: "pipe", stderr: "pipe" });

        const out = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        try { unlinkSync(tmpProof); } catch {}

        if (code !== 0) {
          log(`withdraw tx failed exit=${code} err=${err}`);
          return json({ ok: false, error: err || out }, 500);
        }

        // Parse tx hash if available from stellar contract invoke output
        const match = out.match(/[0-9a-fA-F]{64}/);
        const txHash = match ? match[0] : undefined;
        log(`withdraw tx succeeded! txHash=${txHash ?? "confirmed"}`);
        return json({ ok: true, txHash, out });
      } catch (e: any) {
        log(`withdraw submit error=${e?.message ?? e}`);
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    if (url.pathname === "/pay/deposit" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        commitment?: string;
        fromSecret?: string;
      };
      if (!body.commitment) {
        return json({ ok: false, error: "Missing commitment" }, 400);
      }
      try {
        const poolId = process.env.POOL_ID || "CARO7SWGHRXZPIOL4UNEDST4IQIPMQSWYHMDQMYHX3PE62ZLG2NKUVS4";
        const fromSecret = body.fromSecret || process.env.ALICE_SECRET || "SCOQ7NQW26XEFVG7S5PXO36I7ESBT6ZDMZOT5TX66ZUSBLFTBLXVLOWU";
        const rpc = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
        const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
        const kp = Keypair.fromSecret(fromSecret);

        log(`submitting deposit tx to pool=${poolId} from=${kp.publicKey()}...`);
        const proc = Bun.spawn([
          "stellar", "contract", "invoke",
          "--id", poolId,
          "--source-account", fromSecret,
          "--rpc-url", rpc,
          "--network-passphrase", passphrase,
          "--send", "yes",
          "--",
          "deposit",
          "--from", kp.publicKey(),
          "--commitment", body.commitment,
        ], { stdout: "pipe", stderr: "pipe" });

        const out = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;

        if (code !== 0) {
          log(`deposit tx failed exit=${code} err=${err}`);
          return json({ ok: false, error: err || out }, 500);
        }

        const leafIndex = parseInt(out.trim()) || 0;
        log(`deposit tx succeeded! leafIndex=${leafIndex}`);
        return json({ ok: true, leafIndex, out });
      } catch (e: any) {
        log(`deposit submit error=${e?.message ?? e}`);
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    return json({ error: "not found" }, 404);
  },
});

function joinRepo() {
  const { fileURLToPath } = require("node:url");
  const { resolve } = require("node:path");
  return resolve(fileURLToPath(import.meta.url), "../../../..");
}

log(`api listening on http://127.0.0.1:${PORT}`);
void Horizon;
