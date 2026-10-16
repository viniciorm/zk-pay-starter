# Veil — pago privado no rastreable en Stellar testnet

Privacy pool estilo Tornado en Soroban: depósito fijo de 10 XLM, commitment en un Merkle tree Poseidon
(16 niveles), retiro con prueba Groth16 (BN254) + nullifier. Ver `PRD.md` y `CLAUDE.md`.

## Estado: ✅ desplegado y verificado en testnet

Página de demo: **https://veil.agentposhq.com** (alias: https://veil-lime-alpha.vercel.app) · código: https://github.com/NovaCorpAI/veil

| Qué | Valor |
|-----|-------|
| Contract ID | `CA4D3V4DB6FPXM4K7WAOG4LHOI5L7Q6R2EI4CENKZKQGER5VUG3CL6QQ` · [stellar.expert](https://stellar.expert/explorer/testnet/contract/CA4D3V4DB6FPXM4K7WAOG4LHOI5L7Q6R2EI4CENKZKQGER5VUG3CL6QQ) |
| Token | SAC XLM nativo `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| init tx | [528f08c2…](https://stellar.expert/explorer/testnet/tx/528f08c2890a9af3933586f7bcbdbade60b749b0255d676254f357824bc3c6a9) |
| deposit (alice, 10 XLM) | [4b1a171b…](https://stellar.expert/explorer/testnet/tx/4b1a171b06f72494819c53daeca290a513af76d5f7c776b230c04ffb84cff213) |
| withdraw (carol → dave, prueba ZK) | [188ac2f9…](https://stellar.expert/explorer/testnet/tx/188ac2f97bd036eb23db15955ed3db0211d1cd36ad3a6a6aecdb39f748268347) |
| corrida 2 (con OpenRouter): deposit / withdraw | [b54d05bb…](https://stellar.expert/explorer/testnet/tx/b54d05bb7d2672e1592c4dd2c05b7b2c1172f515bf3798f8c75478b790a4bdea) / [b5297ecc…](https://stellar.expert/explorer/testnet/tx/b5297eccf3783bff3cd1614b9ad3cc430b4d61c9039a0c1889fc6b7be2f08482) · asesor IA: "riesgo medio, esperar más depósitos" |
| segundo withdraw con la misma nota | rechazado en simulación: `Error(Contract, #5)` = `NullifierSpent` |

Un observador ve: alice → pool (10 XLM) y pool → dave (10 XLM) firmado por carol. Nada vincula las dos txs:
el retiro solo expone `root`, `nullifierHash` y `recipient`, y la prueba Groth16 demuestra que existe un
commitment en el árbol sin revelar cuál.

### Cuentas testnet
- alice (depositante): `GAJJUTIVOWTTHL73PFPSBNSNMJJZY3EFTTLW7VLVP4LDVA4KXGKYRMVX`
- carol (firma el retiro): `GACFTWXM6RWGB5PDVFRCTBC5T3K6MS7NHKXMLGO3JPD6YH7IN6KZ3RLD`
- dave (destinatario): `GDN5MJPTUSOEAMXMFD3LTYIG7JP4Z7UI746YQHLPK4QATSHZPDKGO2GA`

## Fases
| Fase | Estado |
|------|--------|
| 1 · Circuito | ✅ `circuits/withdraw.circom` (4396 restricciones no lineales), setup Groth16, prueba verificada con snarkjs |
| 2 · Contrato | ✅ `contracts/veil_pool` — 4 tests: Poseidon(1,2) == circomlib, recipient→Fr, prueba real de snarkjs verifica on-chain (pairing BN254), flujo completo deposit/withdraw/doble-gasto |
| 3 · Cliente | ✅ `client/deposit.js`, `client/withdraw.js` (eventos `getEvents` → árbol → snarkjs → invoke) |
| 4 · Demo | ✅ `scripts/demo.sh` |
| IA (requisito) | ✅ `client/openrouter.js`: asesor de privacidad vía OpenRouter antes de cada retiro (key en `.env`, ver `.env.example`) |

## Decisiones técnicas que había que acertar
- **Poseidon on-chain = circomlib**: crate `soroban-poseidon` 28.0.0 (`poseidon_hash::<3, Bn254Fr>`); test vector
  `Poseidon(1,2) = 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a` ✅ en ambos lados.
- **G2 (snarkjs → host functions)**: cada coordenada Fp2 va `be32(c1) || be32(c0)` (formato EIP-197). snarkjs
  entrega `[c0, c1]`. Implementado en `client/encode.js`; el pairing pasó al primer intento.
- **Verificador**: `pairing_check([-A, alpha, vk_x, C], [B, beta, gamma, delta])` con `env.crypto().bn254()`
  (soroban-sdk 28, sin feature extra). VK pegada como constantes en `src/vk.rs` (generado por `client/export-rs.js`).
- **recipient como Fr**: `sha256(XDR del ScVal Address)[0..31]` (31 bytes para no exceder el campo), idéntico en
  `client/addr.js` y en `addr_to_fr` del contrato.
- **Árbol**: `zeros[0] = 0`, `zeros[i] = H(zeros[i-1], zeros[i-1])`, `filled_subtrees[16]`, ring de 30 raíces.
  Misma convención en `client/tree.js` (pathIndices[i]=0 ⇒ hoja a la izquierda).

## Cómo correr
```bash
npm i
bash scripts/build-circuit.sh   # circom + setup Groth16 + prueba de ejemplo + verify
node client/export-rs.js        # regenera vk.rs y test_fixture.rs del contrato
(cd contracts && cargo test)    # 4 tests
bash scripts/deploy.sh          # build wasm, deploy, init → deploy.json
bash scripts/demo.sh            # deposit (alice) → nota → withdraw (carol→dave) → doble retiro rechazado
```
Uso manual:
```bash
node client/deposit.js alice                    # imprime la nota veil-<nullifier>-<secret>
node client/withdraw.js <nota> <G...dest> carol # genera prueba y retira
```

## Toolchain (Windows, sin MSVC)
- `tools/circom.exe` 2.2.3, `tools/stellar.exe` 28.1.0 (no están en PATH; los scripts los invocan por ruta).
- Rust: toolchain `stable-x86_64-pc-windows-gnu` (el MSVC no está instalado; el GNU trae linker propio) + `wasm32v1-none`.
- soroban-sdk 28.0.0, soroban-poseidon 28.0.0. Testnet corre protocolo 29.
- Powers of tau: los mirrors públicos del `.ptau` 2^16 devuelven 403, así que `ptau/pot14_final.ptau` se generó
  localmente con snarkjs (2^14 basta: < 2^13 restricciones). Solo demo; no es una ceremonia real.

Entrega y checklist de unlinkability: `SOLUTION.md`.

## Fuera de alcance
Association sets, relayer de fees, montos variables, web UI, mainnet.
