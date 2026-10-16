# SOLUTION.md — Veil (NovaCorp AI)

**Hacker:** Anael Casanova · **Fecha:** 2026-10-16 · **Red:** Stellar testnet (nunca mainnet)

## Qué está desplegado
| Qué | Dónde |
|-----|-------|
| Pool (Soroban) | `CA4D3V4DB6FPXM4K7WAOG4LHOI5L7Q6R2EI4CENKZKQGER5VUG3CL6QQ` · [explorer](https://stellar.expert/explorer/testnet/contract/CA4D3V4DB6FPXM4K7WAOG4LHOI5L7Q6R2EI4CENKZKQGER5VUG3CL6QQ) |
| deposit alice → pool (10 XLM) | [4b1a171b…](https://stellar.expert/explorer/testnet/tx/4b1a171b06f72494819c53daeca290a513af76d5f7c776b230c04ffb84cff213) |
| withdraw carol → dave (prueba Groth16 verificada on-chain) | [188ac2f9…](https://stellar.expert/explorer/testnet/tx/188ac2f97bd036eb23db15955ed3db0211d1cd36ad3a6a6aecdb39f748268347) |
| doble retiro con la misma nota | rechazado: `Error(Contract, #5) NullifierSpent` |
| **corrida 2 (con OpenRouter en el flujo)** deposit alice | [b54d05bb…](https://stellar.expert/explorer/testnet/tx/b54d05bb7d2672e1592c4dd2c05b7b2c1172f515bf3798f8c75478b790a4bdea) |
| corrida 2 · OpenRouter `gen-1792187402-GNxDx9D4WlFacPD6RAOz` (gpt-4.1-nano, 202 tokens) → "riesgo medio, esperar más depósitos" | log de `withdraw.js` |
| corrida 2 · withdraw carol → dave | [b5297ecc…](https://stellar.expert/explorer/testnet/tx/b5297eccf3783bff3cd1614b9ad3cc430b4d61c9039a0c1889fc6b7be2f08482) |
| corrida 2 · doble retiro | rechazado: `Error(Contract, #5) NullifierSpent` |
| Demo web | https://veil.agentposhq.com |
| Código | https://github.com/NovaCorpAI/veil |

## Cobertura de los 8 GAPs del starter (implementación propia, misma semántica)
| GAP | Veil |
|-----|------|
| 1 commitment + nullifierHash | `client/tree.js`: `Poseidon(nullifier, secret)`, `Poseidon(nullifier)` con circomlibjs |
| 2c circuito withdraw (Circom) | `circuits/withdraw.circom`, Groth16/BN254, 16 niveles, públicos `root, nullifierHash, recipient` |
| 3 Merkle insert + historial de raíces | `contracts/veil_pool/src/lib.rs::deposit` (filled_subtrees, zeros, ring de 30 raíces) |
| 4 nullifier set | `DataKey::Nullifier(U256)` persistente; test `full_flow_deposit_withdraw_double_spend` |
| 5 wiring de inputs públicos | `groth16_verify`: `vk_x = IC0 + Σ IC[i+1]·pub[i]`, `pairing_check([-A, α, vk_x, C], [B, β, γ, δ])` |
| 6 app | CLI `client/deposit.js` / `client/withdraw.js` + página `web/` con feed on-chain |
| 7 OpenRouter en el flujo de pago | `client/openrouter.js::privacyAdvisor`, llamado en `withdraw.js` antes de generar la prueba (modelo `openai/gpt-4.1-nano`, 200 tokens; key en `.env`, nunca en frontend) |
| 8 unlinkability | sección "Qué sigue filtrando" abajo |

## Trampas resueltas
- **Poseidon**: `soroban-poseidon` 28.0.0 con `poseidon_hash::<3, Bn254Fr>`; `Poseidon(1,2) = 0x115cc0f5…189a` igual que circomlib (test).
- **G2 snarkjs → Soroban**: cada Fp2 como `be32(c1) || be32(c0)`. Pairing OK al primer intento (test con prueba real).
- **recipient como Fr**: `sha256(XDR ScVal Address)[0..31]`, idéntico en cliente y contrato (test).

## Qué sigue filtrando (checklist de unlinkability)
- **Anonymity set pequeño**: con 1 depósito, el retiro es trivialmente vinculable. El asesor de OpenRouter lo advierte.
- **Timing**: retirar minutos después de depositar correlaciona ambas txs.
- **Fees de B**: carol paga la fee del retiro; si carol fue fondeada por alice, hay vínculo. Mitigación: relayer (fuera de alcance).
- **Montos fijos** ayudan; pools de una sola denominación no mezclan entre denominaciones.
- **Metadatos off-chain**: IP del RPC, hora de envío, misma máquina.

## Cómo reproducir
```bash
npm i && cp .env.example .env   # poner OPENROUTER_API_KEY
bash scripts/build-circuit.sh && node client/export-rs.js && (cd contracts && cargo test)
bash scripts/deploy.sh && bash scripts/demo.sh
```
