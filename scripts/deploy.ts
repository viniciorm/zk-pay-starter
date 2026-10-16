#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getEnv, readEnvFile, writeEnv } from "./env";
import { ensureWallets } from "./keys";
import { assertNotMainnet, parseNetworkFlag, TESTNET_PASSPHRASE, TESTNET_RPC } from "./network";

const ROOT = join(import.meta.dir, "..");
const network = parseNetworkFlag();
if (network !== "testnet") {
  // local is allowed but this script is wired to public testnet RPC.
  assertNotMainnet(network, "deploy");
}

const argv = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== "testnet");
const only = argv.filter((a) => a !== "deploy.ts");

const env = await readEnvFile();
const rpc = getEnv(env, "STELLAR_RPC_URL", TESTNET_RPC);
const passphrase = getEnv(env, "STELLAR_NETWORK_PASSPHRASE", TESTNET_PASSPHRASE);

const wallets = await ensureWallets(
  ["deployer", "alice", "bob", "fresh-1", "fresh-2"],
  {
    DEPLOYER_SECRET: getEnv(env, "DEPLOYER_SECRET"),
    ALICE_SECRET: getEnv(env, "ALICE_SECRET"),
    BOB_SECRET: getEnv(env, "BOB_SECRET"),
    FRESH_1_SECRET: getEnv(env, "FRESH_1_SECRET"),
    FRESH_2_SECRET: getEnv(env, "FRESH_2_SECRET"),
  },
);
const deployer = wallets.find((w) => w.name === "deployer")!;

function wasm(pkg: string, crate: string) {
  return join(ROOT, "target/wasm32v1-none/release", `${crate}.wasm`);
}

async function deployWasm(label: string, wasmPath: string, ctor: string[] = []): Promise<string> {
  if (!existsSync(wasmPath)) throw new Error(`missing ${wasmPath}; run bun run build`);
  console.log(`Deploying ${label}...`);
  const args = [
    "stellar",
    "contract",
    "deploy",
    "--wasm",
    wasmPath,
    "--source-account",
    deployer.secret,
    "--rpc-url",
    rpc,
    "--network-passphrase",
    passphrase,
  ];
  if (ctor.length) args.push("--", ...ctor);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  const combined = (out + "\n" + err).trim();
  if (code !== 0) {
    console.error(combined);
    throw new Error(`deploy ${label} failed`);
  }
  const match = combined.match(/C[A-Z0-9]{55}/);
  const id = match?.[0] ?? out.trim().split("\n").pop()?.trim();
  if (!id || !id.startsWith("C")) throw new Error(`no contract id in: ${combined}`);
  console.log(`✅ ${label}: ${id}`);
  return id;
}

async function invoke(id: string, fn: string, args: string[]) {
  const cmd = [
    "stellar",
    "contract",
    "invoke",
    "--id",
    id,
    "--source-account",
    deployer.secret,
    "--rpc-url",
    rpc,
    "--network-passphrase",
    passphrase,
    "--send",
    "yes",
    "--",
    fn,
    ...args,
  ];
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`invoke ${fn} failed`);
}

const want = (name: string) => only.length === 0 || only.includes(name);

const ids: Record<string, string> = {};

if (want("verifier-ultrahonk")) {
  const vk = join(ROOT, "artifacts/noir/hello/vk");
  if (!existsSync(vk)) {
    console.log("Generating Noir hello VK first...");
    await $`bun run prove:hello --path noir`.cwd(ROOT);
  }
  ids.verifierUltrahonk = await deployWasm(
    "verifier-ultrahonk",
    wasm("verifier-ultrahonk", "verifier_ultrahonk"),
    ["--vk_bytes-file-path", join(ROOT, "artifacts/noir/hello/vk")],
  );
}

if (want("verifier-groth16")) {
  const vkBin = join(ROOT, "artifacts/circom/hello/vk.bin");
  if (!existsSync(vkBin)) {
    console.log("Generating Circom hello VK first...");
    await $`bun run prove:hello --path circom`.cwd(ROOT);
  }
  ids.verifierGroth16 = await deployWasm(
    "verifier-groth16",
    wasm("verifier-groth16", "verifier_groth16"),
  );
  await invoke(ids.verifierGroth16, "set_vk", ["--vk_bytes-file-path", vkBin]);
}

if (want("hello-gate")) {
  if (!ids.verifierUltrahonk) ids.verifierUltrahonk = getEnv(env, "VERIFIER_ULTRAHONK_ID");
  if (!ids.verifierGroth16) ids.verifierGroth16 = getEnv(env, "VERIFIER_GROTH16_ID");
  if (!ids.verifierUltrahonk || !ids.verifierGroth16) {
    throw new Error("hello-gate needs both verifier IDs");
  }
  ids.helloGate = await deployWasm("hello-gate", wasm("hello-gate", "hello_gate"), [
    "--uh_verifier",
    ids.verifierUltrahonk,
    "--g16_verifier",
    ids.verifierGroth16,
  ]);
}

if (want("pool")) {
  const native = await $`stellar contract id asset --asset native --rpc-url ${rpc} --network-passphrase ${passphrase}`
    .cwd(ROOT)
    .text();
  const token = native.trim();
  const verifier = ids.verifierGroth16 || getEnv(env, "VERIFIER_GROTH16_ID") || ids.verifierUltrahonk || getEnv(env, "VERIFIER_ULTRAHONK_ID");
  ids.pool = await deployWasm("pool", wasm("pool", "pool"), [
    "--admin",
    deployer.publicKey,
    "--token",
    token,
    "--denomination",
    "100000000",
    "--verifier",
    verifier,
  ]);
  ids.nativeToken = token;
}

const alice = wallets.find((w) => w.name === "alice")!;
const bob = wallets.find((w) => w.name === "bob")!;
const f1 = wallets.find((w) => w.name === "fresh-1")!;
const f2 = wallets.find((w) => w.name === "fresh-2")!;

const deployment = {
  network,
  rpcUrl: rpc,
  networkPassphrase: passphrase,
  contracts: {
    "verifier-ultrahonk": ids.verifierUltrahonk ?? getEnv(env, "VERIFIER_ULTRAHONK_ID"),
    "verifier-groth16": ids.verifierGroth16 ?? getEnv(env, "VERIFIER_GROTH16_ID"),
    "hello-gate": ids.helloGate ?? getEnv(env, "HELLO_GATE_ID"),
    pool: ids.pool ?? getEnv(env, "POOL_ID"),
    nativeToken: ids.nativeToken ?? "",
  },
  wallets: Object.fromEntries(wallets.map((w) => [w.name, w.publicKey])),
  deployedAt: new Date().toISOString(),
};
await Bun.write(join(ROOT, "deployment.json"), JSON.stringify(deployment, null, 2) + "\n");

await writeEnv({
  STELLAR_RPC_URL: rpc,
  STELLAR_NETWORK_PASSPHRASE: passphrase,
  STELLAR_NETWORK: "testnet",
  DEPLOYER_SECRET: deployer.secret,
  DEPLOYER_ADDRESS: deployer.publicKey,
  ALICE_SECRET: alice.secret,
  ALICE_ADDRESS: alice.publicKey,
  BOB_SECRET: bob.secret,
  BOB_ADDRESS: bob.publicKey,
  FRESH_1_SECRET: f1.secret,
  FRESH_1_ADDRESS: f1.publicKey,
  FRESH_2_SECRET: f2.secret,
  FRESH_2_ADDRESS: f2.publicKey,
  VERIFIER_ULTRAHONK_ID: deployment.contracts["verifier-ultrahonk"],
  VERIFIER_GROTH16_ID: deployment.contracts["verifier-groth16"],
  HELLO_UH_VERIFIER_ID: deployment.contracts["verifier-ultrahonk"],
  HELLO_G16_VERIFIER_ID: deployment.contracts["verifier-groth16"],
  HELLO_GATE_ID: deployment.contracts["hello-gate"],
  POOL_ID: deployment.contracts.pool,
  NATIVE_TOKEN_ID: deployment.contracts.nativeToken,
  VITE_SOROBAN_RPC_URL: rpc,
  VITE_NETWORK_PASSPHRASE: passphrase,
  VITE_HELLO_GATE_ID: deployment.contracts["hello-gate"],
  VITE_POOL_ID: deployment.contracts.pool,
  VITE_VERIFIER_UH_ID: deployment.contracts["verifier-ultrahonk"],
  VITE_VERIFIER_G16_ID: deployment.contracts["verifier-groth16"],
  OPENROUTER_MODEL: getEnv(env, "OPENROUTER_MODEL", "openai/gpt-4.1-nano"),
  OPENROUTER_MAX_TOKENS: "300",
});

console.log("\n🎉 deploy complete. IDs in deployment.json and .env");
