import { Keypair, Horizon, StrKey } from "@stellar/stellar-sdk";
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
      const address = body.address?.trim();
      if (!address || !StrKey.isValidEd25519PublicKey(address)) {
        return json({ ok: false, error: "Missing or invalid Stellar public key (must start with G)" }, 400);
      }
      const res = await fetch(`https://friendbot.stellar.org?addr=${address}`);
      log(`friendbot address=${address} status=${res.status}`);
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

    // Secure and retired prove-withdraw: proof generation is now 100% client-side WebAssembly
    if (url.pathname === "/pay/prove-withdraw") {
      log("rejected /pay/prove-withdraw: proving has been migrated client-side");
      return json(
        {
          ok: false,
          error: "Proof generation has been migrated to client-side WebAssembly. The server does not accept private preimages.",
        },
        410
      );
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
        return json({ ok: false, error: "Missing required withdraw parameters" }, 400);
      }
      // Strict parameter validations to avoid arbitrary relayer gas burning
      if (body.proofHex.length !== 512 || !/^[0-9a-fA-F]{512}$/.test(body.proofHex)) {
        return json({ ok: false, error: "Invalid proofHex format (must be 256 bytes hex)" }, 400);
      }
      if (!StrKey.isValidEd25519PublicKey(body.recipient.trim())) {
        return json({ ok: false, error: "Invalid recipient address" }, 400);
      }
      if (!/^\d+$/.test(body.root) || !/^\d+$/.test(body.nullifierHash)) {
        return json({ ok: false, error: "Invalid root or nullifierHash format" }, 400);
      }

      const relayerSecret = process.env.RELAYER_SECRET || process.env.DEPLOYER_SECRET;
      if (!relayerSecret) {
        log("withdraw rejected: RELAYER_SECRET not set in environment");
        return json({ ok: false, error: "Relayer not configured on server. Please set RELAYER_SECRET in environment." }, 500);
      }

      try {
        const poolId = process.env.POOL_ID || "CARO7SWGHRXZPIOL4UNEDST4IQIPMQSWYHMDQMYHX3PE62ZLG2NKUVS4";
        const rpc = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
        const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
        const { rpc: sorobanRpc, Contract, nativeToScVal, scValToNative } = await import("@stellar/stellar-sdk");
        const server = new sorobanRpc.Server(rpc);
        const contract = new Contract(poolId);

        // Pre-flight check: verify nullifier is not already spent without spending gas
        try {
          const simRes = await server.simulateTransaction(
            new (await import("@stellar/stellar-sdk")).TransactionBuilder(
              await server.getAccount(Keypair.fromSecret(relayerSecret).publicKey()),
              { fee: "100", networkPassphrase: passphrase }
            )
              .addOperation(
                contract.call("is_spent", nativeToScVal(BigInt(body.nullifierHash), { type: "u256" }))
              )
              .setTimeout(30)
              .build()
          );
          if (simRes.result?.retval && scValToNative(simRes.result.retval) === true) {
            log(`pre-flight rejected: nullifier ${body.nullifierHash.slice(0, 16)}... already spent`);
            return json({ ok: false, error: "Nullifier already spent on-chain (double-spend rejected)" }, 400);
          }
        } catch (simErr) {
          log(`pre-flight check warning: ${simErr}`);
        }

        const { join } = await import("node:path");
        const { writeFileSync, unlinkSync } = await import("node:fs");
        const tmpProof = join(joinRepo(), `tmp_proof_${Date.now()}.bin`);
        writeFileSync(tmpProof, Buffer.from(body.proofHex, "hex"));

        const relayerKp = Keypair.fromSecret(relayerSecret);
        const relayerAddress = relayerKp.publicKey();

        log(`submitting withdraw tx to pool=${poolId} via relayer=${relayerAddress}...`);
        const proc = Bun.spawn([
          "stellar", "contract", "invoke",
          "--id", poolId,
          "--source-account", relayerSecret,
          "--rpc-url", rpc,
          "--network-passphrase", passphrase,
          "--send", "yes",
          "--",
          "withdraw",
          "--proof-file-path", tmpProof,
          "--root", body.root,
          "--nullifier_hash", body.nullifierHash,
          "--recipient", body.recipient.trim(),
          "--fee", body.fee ?? "0",
          "--relayer", relayerAddress,
        ], { stdout: "pipe", stderr: "pipe" });

        const out = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        try { unlinkSync(tmpProof); } catch {}

        if (code !== 0) {
          log(`withdraw tx failed exit=${code} err=${err}`);
          return json({ ok: false, error: err || out }, 500);
        }

        const match = out.match(/[0-9a-fA-F]{64}/);
        const txHash = match ? match[0] : undefined;
        log(`withdraw tx succeeded! txHash=${txHash ?? "confirmed"}`);
        return json({ ok: true, txHash, out });
      } catch (e: any) {
        log(`withdraw submit error=${e?.message ?? e}`);
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    // Secure broadcast endpoint for client-side signed transactions (e.g. deposits)
    if ((url.pathname === "/pay/broadcast" || url.pathname === "/pay/deposit") && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        signedTxXdr?: string;
        fromSecret?: string;
      };
      if (body.fromSecret) {
        return json({
          ok: false,
          error: "Insecure server-side signing is disabled. Please sign transactions client-side (Freighter or Local Wallet) and submit signedTxXdr.",
        }, 400);
      }
      if (!body.signedTxXdr) {
        return json({ ok: false, error: "Missing signedTxXdr parameter" }, 400);
      }
      try {
        const { rpc: sorobanRpc, Transaction, scValToNative } = await import("@stellar/stellar-sdk");
        const rpcUrl = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
        const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
        const server = new sorobanRpc.Server(rpcUrl);
        const tx = new Transaction(body.signedTxXdr, passphrase);
        const sim = await server.simulateTransaction(tx);
        if (sorobanRpc.Api.isSimulationError(sim)) {
          log(`broadcast pre-flight simulation failed`);
          return json({ ok: false, error: "Transaction simulation failed", details: sim }, 400);
        }
        const sendRes = await server.sendTransaction(tx);
        if (sendRes.status === "ERROR") {
          log(`broadcast error: ${JSON.stringify(sendRes)}`);
          return json({ ok: false, error: "Transaction rejected by Stellar RPC", details: sendRes }, 400);
        }
        log(`broadcast tx submitted hash=${sendRes.hash}`);
        const pollRes = await server.pollTransaction(sendRes.hash);
        const leafIndex = pollRes.returnValue ? scValToNative(pollRes.returnValue) : undefined;
        log(`broadcast tx confirmed status=${pollRes.status} leafIndex=${leafIndex}`);
        return json({
          ok: pollRes.status === "SUCCESS",
          txHash: sendRes.hash,
          status: pollRes.status,
          leafIndex,
        });
      } catch (e: any) {
        log(`broadcast submit error=${e?.message ?? e}`);
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
