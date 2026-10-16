# zk-pay-starter

Fork this repo, run one setup command, and verify a real ZK proof on
**Stellar testnet**. Then — in 1 to 2 hours, with AI — turn that pipeline into
a private payment (deposit → withdraw to a fresh address).

This is a **learning ground, not a solution**. The hello circuit and both
on-chain verifiers work out of the box. The mixer is eight marked gaps.

📖 **Arquitectura y Funcionamiento Completo:** Lee [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md) para conocer el flujo detallado de depósito, compromisos Poseidon, árbol Merkle, pruebas Circom + Groth16, nullifiers y verificación en Soroban con transacciones reales en Testnet.

**Testnet and local only. Never mainnet.**

## Fork → first proof on Stellar

Do this on **your fork**, not a random clone of someone else's laptop.

1. Click **Fork** on GitHub. Clone *your* fork:

   ```bash
   git clone https://github.com/<you>/zk-pay-starter.git
   cd zk-pay-starter
   ```

2. Install the pinned tools (once per machine), then prove the toolchain:

   ```bash
   ./scripts/install-tools.sh
   # new terminal so PATH updates
   bun run doctor
   ```

3. Deploy the GIVEN pipeline to testnet (Friendbot keys, both verifiers,
   hello proofs):

   ```bash
   bun install
   bun run setup
   ```

4. **Land the circuit.** This sends a real testnet transaction. The contract
   you just deployed verifies `x² = y` under UltraHonk:

   ```bash
   bun run verify:hello --path noir --network testnet
   ```

   Success looks like `✅ hello verified on testnet (noir)` plus a
   [stellar.expert](https://stellar.expert/explorer/testnet) tx link. That is a
   working ZK circuit on Stellar.

   Same statement, Groth16 path (optional, cheaper):

   ```bash
   bun run verify:hello --path circom --network testnet
   ```

Printable version of this path: [`docs/HACKER.md`](docs/HACKER.md).

```bash
bun run dev            # /debug UI at http://127.0.0.1:43121
bun run gaps           # eight red rows — the race
```

Write `PRD.md` from `PRD.template.md` **before** you spend the shared OpenRouter
key. Paste `CONTEXT.md` into prompts. Read `AGENTS.md`.

## Two proving paths (both BN254)

| Path | Circuit | Proof | On-chain |
|---|---|---|---|
| Noir | `circuits/noir` | UltraHonk / keccak via bb 0.87.0 | `verifier-ultrahonk` |
| Circom | `circuits/circom` | Groth16 via snarkjs | `verifier-groth16` |

Hello (GIVEN) is `x² = y`. Withdraw (GAP) is the private-payment statement.

## What you build after M1

| Gap | Where | Green test |
|---|---|---|
| GAP-1 | `packages/shared` commitment + nullifierHash | `commitment matches vectors` |
| GAP-2 | Noir `withdraw` | `noir: withdraw proves vector 1` |
| GAP-2c | Circom `withdraw` | `circom: withdraw proves vector 1` |
| GAP-3 | Pool Merkle insert + root history | `insert_matches_shared_root` |
| GAP-4 | Nullifier set | `rejects_reused_nullifier` |
| GAP-5 | Public-input wiring | `withdraw_verifies_vector_proof` |
| GAP-6 | `/app` UI | `app: deposit→withdraw` |
| GAP-7 | OpenRouter in the payment flow | `api: openrouter step logged` |
| GAP-8 | `docs/lessons/UNLINKABILITY.md` | checklist filled |

Hint ladders: `docs/lessons/`. Poseidon trap: `docs/lessons/00-poseidon-trap.md`.

## Pins

| Tool | Pin |
|---|---|
| Stellar CLI | 28.1.0 |
| soroban-sdk | 28.0.0 |
| Rust | 1.92.0, target `wasm32v1-none` |
| nargo | 1.0.0-beta.9 |
| bb | 0.87.0 |
| circom | 2.1.9 |
| snarkjs | 0.7.5 |
| bun | 1.x |

`bun run doctor` refuses mismatches and prints install commands.

## Facilitators

Hosting, inviting forks, and keeping the answer key off GitHub:
[`docs/FACILITATOR.md`](docs/FACILITATOR.md).

## License

Tutorial code: MIT. Vendored UltraHonk verifier: MIT OR Apache-2.0.
See `CREDITS.md`.
