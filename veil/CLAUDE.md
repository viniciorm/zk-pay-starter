# Veil — brief para Claude Code

Lee `PRD.md` primero. Este archivo fija decisiones para que no explores: ejecuta en el orden indicado. Tenemos 90 minutos y un presupuesto de tokens pequeño: no investigues alternativas, no refactorices, no agregues features fuera del PRD. Si algo falla, corrige lo mínimo y sigue.

## Reglas
- Testnet solamente. Nunca mainnet.
- Ante cada paso, corre el test más barato que confirme que funciona antes de pasar al siguiente.
- Commits pequeños y frecuentes al repo (gana el primero que pushea una solución que despliega).
- Cuando termines una fase, actualiza `README.md` con el estado y los IDs/hashes.

## Toolchain (ya instalado antes del evento; si falta algo, instálalo y sigue)
- Rust stable + target `wasm32v1-none` (o `wasm32-unknown-unknown` si la CLI lo pide)
- `stellar` CLI con identidad `alice` fondeada en testnet (`stellar keys generate alice --network testnet --fund`) y una segunda `carol` también fondeada
- `circom` 2.x, `snarkjs`, `circomlibjs`, `@stellar/stellar-sdk` (npm)
- `ptau/powersOfTau28_hez_final_16.ptau` ya descargado
- Opcional: plugin Stellar para Claude Code (`/plugin marketplace add stellar/stellar-dev-skill` y `/plugin install stellar-dev@stellar-dev`)

## Estructura
```
veil/
  circuits/withdraw.circom
  circuits/build/        (wasm, zkey, verification_key.json)
  contracts/veil_pool/   (Cargo workspace, soroban-sdk)
  client/                (Node: deposit.js, withdraw.js, tree.js)
  scripts/build-circuit.sh, deploy.sh, demo.sh
  PRD.md CLAUDE.md README.md
```

## Fase 1 · Circuito (meta: 15 min)
`circuits/withdraw.circom`:
```circom
pragma circom 2.1.6;
include "circomlib/circuits/poseidon.circom";

template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;
    component h[levels];
    signal cur[levels + 1];
    cur[0] <== leaf;
    for (var i = 0; i < levels; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        h[i] = Poseidon(2);
        h[i].inputs[0] <== cur[i] + pathIndices[i] * (pathElements[i] - cur[i]);
        h[i].inputs[1] <== pathElements[i] + pathIndices[i] * (cur[i] - pathElements[i]);
        cur[i + 1] <== h[i].out;
    }
    root <== cur[levels];
}

template Withdraw(levels) {
    signal input root;
    signal input nullifierHash;
    signal input recipient;
    signal input nullifier;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component c = Poseidon(2);
    c.inputs[0] <== nullifier;
    c.inputs[1] <== secret;

    component n = Poseidon(1);
    n.inputs[0] <== nullifier;
    nullifierHash === n.out;

    component m = MerkleProof(levels);
    m.leaf <== c.out;
    for (var i = 0; i < levels; i++) {
        m.pathElements[i] <== pathElements[i];
        m.pathIndices[i] <== pathIndices[i];
    }
    root === m.root;

    signal recipientSquare;
    recipientSquare <== recipient * recipient;
}

component main {public [root, nullifierHash, recipient]} = Withdraw(16);
```
`scripts/build-circuit.sh`: `circom --r1cs --wasm -o circuits/build`, `snarkjs groth16 setup`, una contribución con entropía fija (es demo), `snarkjs zkey export verificationkey`. Verifica con `snarkjs groth16 fullprove` + `groth16 verify` usando inputs de prueba generados por `client/tree.js`.

## Fase 2 · Contrato (meta: 35 min, es el riesgo principal)
`soroban-sdk` ≥ 25 con feature `hazmat-crypto` (expone BN254 y Poseidon). Poseidon: usar el crate `soroban-poseidon` (github.com/stellar/rs-soroban-poseidon) con los parámetros compatibles con circomlib (BN254, t=3 para hash de 2, t=2 para hash de 1). **Antes de escribir el contrato**, test unitario: `poseidon2_inputs(1, 2)` debe dar `0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a`. Si no coincide, prueba las otras variantes del crate hasta que coincida; si ninguna coincide, comparar con `circomlibjs` y ajustar constantes. No avanzar sin esto.

Merkle tree incremental (patrón Tornado): `filled_subtrees[16]`, `zeros[16]` (zero = Poseidon(0,0) encadenado), `next_index`, `roots` ring buffer de 30, `current_root_index`. Todo en `persistent` storage. Nullifiers: `persistent` con clave `Nullifier(BytesN<32>)`.

Verificador Groth16 (propio, ~60 líneas). Con `env.crypto().bn254()` (nombre exacto: ver docs.rs soroban_sdk `_migrating/v25_bn254`):
1. `vk_x = IC[0] + Σ IC[i+1] * pub[i]` con `g1_mul` y `g1_add` (pub = [root, nullifierHash, recipient] como `Fr`).
2. `pairing_check([A, -alpha, -vk_x, -C], [B, beta, gamma, delta]) == true`. Negar un punto G1: negar la coordenada y (p - y).
VK: pegar las constantes de `verification_key.json` como arrays de bytes big-endian de 32. **Cuidado G2:** snarkjs entrega cada coordenada como `[c0, c1]`; el formato esperado por las host functions es big-endian con `c1` antes de `c0` (mismo que EIP-197). Si el pairing falla, invertir el orden c0/c1 es la primera cosa a probar. Las coordenadas de la prueba (`proof.json`) se serializan igual.

`recipient` como campo público: `Fr` = los 32 bytes del `Address` (XDR hash) reducidos mod r; usar los primeros 31 bytes para no exceder el campo, igual en cliente y contrato.

Test unitario obligatorio antes de deploy: generar una prueba real con snarkjs en el cliente, pegar proof + public signals en `tests/` y verificar en el contrato en test env. Si pasa, deploy.

Deploy: `stellar contract build`, `stellar contract deploy --network testnet --source alice`, `init` con el SAC de XLM nativo (`stellar contract id asset --asset native --network testnet`), denominación `100_000_000` (10 XLM en stroops).

## Fase 3 · Cliente (meta: 20 min)
Node sin framework. `tree.js` (merkle con poseidon de circomlibjs, misma convención left/right que el circuito), `deposit.js` (nota = `veil-<nullifier hex>-<secret hex>`, random de 31 bytes cada uno), `withdraw.js` (lee eventos `deposit` vía RPC `getEvents`, reconstruye árbol, `snarkjs.groth16.fullProve`, invoca `withdraw` firmando con `carol`). Invocar contratos con `@stellar/stellar-sdk` (`contract.Client` o `rpc.Server` + `TransactionBuilder`), lo que ya tengas a mano.

## Fase 4 · Demo y entrega (meta: 10 min)
`scripts/demo.sh`: deposit desde alice → imprime nota → withdraw con carol a una tercera cuenta `dave` → intenta withdraw de nuevo y muestra el rechazo → imprime links de stellar.expert de ambas txs. README con contract ID, hashes y cómo correr. Push.

## Si se acaba el tiempo
Orden de recorte: (1) web UI (no se hace), (2) historial de 30 raíces → solo raíz actual, (3) cliente withdraw manual con `stellar contract invoke` y JSON de prueba generado por snarkjs CLI. El contrato verificando una prueba real en testnet es lo que no se negocia.
