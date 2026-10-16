# PRD: Veil — pago privado no rastreable en Stellar testnet

**Autor:** Anael Casanova (NovaCorpAI) · **Fecha:** 16 oct 2026 · **Contexto:** Taller de Privacidad en Blockchain, Tellus Hub

## Problema
En Stellar todo pago es público para siempre: quién paga, a quién y cuánto. Para sueldos, ayuda de ONGs a beneficiarios vulnerables o pagos B2B eso es inaceptable. Necesitamos que A pueda pagar a C sin que nadie pueda vincular on-chain el depósito de A con el retiro de C.

## Objetivo (criterio de éxito)
Una app + un circuito ZK, ambos desplegados en Stellar **testnet** y conectados, donde:
1. A deposita 10 XLM en un pool y obtiene una nota secreta (off-chain).
2. C (otra cuenta, sin relación con A) retira 10 XLM presentando una prueba Groth16, sin revelar qué depósito está usando.
3. Un observador con stellar.expert no puede vincular la tx de depósito con la tx de retiro.
4. El mismo depósito no puede retirarse dos veces (nullifier).

## Fuera de alcance (hoy)
Association sets / cumplimiento, relayer para pagar fees, montos variables, transferencias dentro del pool, auditoría, mainnet.

## Diseño
**Modelo:** privacy pool estilo Tornado (depósito fijo, commitment en Merkle tree, retiro con ZK + nullifier).

**Circuito (Circom 2, Groth16 sobre BN254):**
- Privados: `secret`, `nullifier`, `pathElements[16]`, `pathIndices[16]`
- Públicos: `root`, `nullifierHash`, `recipient`
- Restricciones: `commitment = Poseidon(nullifier, secret)`; `nullifierHash = Poseidon(nullifier)`; `root` = raíz Merkle (Poseidon de 2) del camino; `recipient` se incluye en una restricción dummy para fijarlo en la prueba.

**Contrato Soroban (`veil_pool`):**
- `init(token, denomination, vk)`: fija el asset (SAC de XLM), 10 XLM y la verification key.
- `deposit(from, commitment)`: cobra 10 XLM, inserta el commitment en un Merkle tree incremental (Poseidon host function), guarda la raíz en un historial de 30 raíces, emite evento `deposit(commitment, leaf_index)`.
- `withdraw(proof, root, nullifier_hash, recipient)`: verifica que `root` esté en el historial, que `nullifier_hash` no esté gastado, verifica la prueba Groth16 con las funciones host BN254, marca el nullifier y transfiere 10 XLM a `recipient`.

**Paso de IA (requisito del hackathon):** antes de cada retiro, `client/openrouter.js` llama a la API de OpenRouter (modelo `openai/gpt-4.1-nano`, máx. 200 tokens) como asesor de privacidad: recibe solo el tamaño del anonymity set y la posición de la hoja (nunca la nota ni el commitment) y devuelve riesgo de vinculación + recomendación. Key en `.env`, nunca en frontend. Presupuesto: 1 llamada por retiro.

**Cliente (Node CLI; web mínima si sobra tiempo):**
- `deposit`: genera nota `veil-<nullifier>-<secret>`, calcula commitment con circomlibjs, llama `deposit`.
- `withdraw <nota> <recipient>`: lee eventos del contrato, reconstruye el árbol, genera la prueba con snarkjs (wasm + zkey) y llama `withdraw`.

## Qué significa "despliega y pasa la verificación"
Contrato desplegado en testnet (ID en README) + tx de depósito desde A + tx de retiro hacia C ejecutada con éxito + segundo retiro con la misma nota rechazado. Script `demo.sh` que lo corre de punta a punta.

## Riesgos y mitigación
- Poseidon on-chain ≠ Poseidon del circuito → test vector `Poseidon(1,2)` conocido antes de cualquier deploy.
- Orden de coordenadas G2 (snarkjs vs. host functions) → test unitario del verificador con una prueba real generada por snarkjs antes de deploy.
- Trusted setup lento → descargar el `.ptau` (2^16) antes del evento.
