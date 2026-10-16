# PRD: ZK Private Payments en Stellar Testnet (zk-pay-starter)

**Equipo:** `viniciorm/zk-pay-starter` · **Fecha:** 2026-10-16 · **Red:** Stellar Testnet (exclusivamente)

## 1. Problema que resolvemos
En una blockchain pública como Stellar, toda transferencia deja un vínculo directo en el ledger entre el emisor (`Account A`), el receptor (`Account B`) y el monto. Este proyecto implementa un **pool de pagos privados de denominación fija** usando pruebas de conocimiento cero (ZKPs) y primitivas nativas de Soroban (Protocolo 25+, CAP-0074 y CAP-0075), permitiendo depositar fondos desde una cuenta `A` y retirarlos hacia una cuenta nueva `B` sin que un observador público pueda vincular el depósito con el retiro.

## 2. Usuario, alcance y flujo principal
- **Alcance (In):** Depósito de denominación fija (`10 XLM` = `100_000_000` stroops), generación de nota secreta local, árbol de Merkle Poseidon en Soroban, prueba ZK de retiro (`withdraw`), prevención de doble gasto con `nullifierHash`, UI mínima en `/app` y paso de asistencia IA con OpenRouter en `/pay/ai-step`.
- **Fuera de alcance (Out):** Mainnet, montos variables, Association Sets, sistemas de cumplimiento empresarial, relayers externos complejos.
- **Flujo del usuario:**
  1. **Depósito:** `Alice` genera localmente una nota `(nullifier, secret)`, calcula `commitment = Poseidon2(nullifier, secret)`, descarga/guarda la nota (64 bytes hex) e invoca `Pool.deposit(from, commitment)` transfiriendo `10 XLM`.
  2. **Anonimato:** Al menos un segundo depositante (`Bob`) deposita en el mismo pool para formar un conjunto de anonimato ($\ge 2$ hojas).
  3. **Retiro:** El usuario fondea una cuenta nueva (`fresh-1`) vía Friendbot, genera localmente la prueba ZK demostrando membresía en el árbol de Merkle para una `root` histórica válida sin revelar qué hoja posee, e invoca `Pool.withdraw(proof, root, nullifier_hash, recipient, fee, relayer)`.

## 3. Arquitectura mínima y cobertura de GAPs
| Componente | Archivo / Ubicación | Rol y GAP asociado |
|---|---|---|
| **Shared Crypto & Merkle** | `packages/shared/src/{note,merkle,encode}.ts` | Parámetros Poseidon (`poseidon.params.json`), codificación de notas/pruebas, `commitment(note)` y `nullifierHash(n)` (**GAP-1**). |
| **Circuito ZK Withdraw** | `circuits/circom/withdraw/withdraw.circom` y `circuits/noir/withdraw/src/main.nr` | Prueba membresía en árbol de Merkle (profundidad 8), deriva `nullifierHash` y vincula `recipient` y `fee` (**GAP-2c / GAP-2**). |
| **Contrato Pool Soroban** | `contracts/pool/src/lib.rs` | Inserción incremental en árbol de Merkle con `poseidon_permutation` (CAP-0075) e historial circular de 32 raíces (**GAP-3**), registro persistente de nullifiers (**GAP-4**) y llamada al verificador + transferencia del pago (**GAP-5**). |
| **Contrato Verificador** | `contracts/verifier-groth16` (y `verifier-ultrahonk`) | Verificación criptográfica on-chain en BN254 (`env.crypto().bn254()`, CAP-0074 / CAP-0080). |
| **Web UI y API** | `apps/web/src/pages/AppPage.tsx` y `apps/api/src/index.ts` | Interfaz `/app` para depositar, respaldar nota y retirar a dirección nueva (**GAP-6**) + endpoint `/pay/ai-step` con OpenRouter (`max_tokens=300`, sin enviar secretos) (**GAP-7**). |
| **Auditoría de privacidad** | `docs/lessons/UNLINKABILITY.md` | Checklist verificable con hashes reales de Testnet y análisis de fugas de metadatos (**GAP-8**). |

## 4. Circuito y sistema de pruebas
- **Primitiva Hash:** Poseidon clásico sobre el campo escalar BN254 ($t=3, d=5, R_F=8, R_P=57$, estado inicial `[0, a, b]`, salida `state[0]`). Fuente única: `packages/shared/poseidon.params.json`.
- **Entradas públicas (orden estricto):** `0: root`, `1: nullifierHash`, `2: recipient`, `3: fee`.
  - Conversión de dirección Stellar a elemento de campo: `recipient_field = U256::from_be_bytes(address_bytes) mod r`.
- **Entradas privadas:** `nullifier`, `secret`, `pathElements[8]`, `pathIndices[8]`.
- **Restricciones del circuito:**
  1. `commitment = Poseidon2(nullifier, secret)`
  2. Reconstrucción de raíz desde `commitment` usando `pathElements[8]` y `pathIndices[8]` (`0` = hijo izquierdo, `1` = hijo derecho) y restricción `computed_root === root`.
  3. `nullifierHash === Poseidon2(nullifier, 1)` (`DOMAIN_NULLIFIER = 1`).
  4. Vinculación cuadrática de `recipient` y `fee` para impedir maleabilidad por parte del relayer.
- **Sistema de pruebas principal:** **Circom 2.1.9 + Groth16 (`snarkjs` 0.7.5)** sobre BN254 (camino principal para el Pool en Windows y menor costo de CPU en Soroban), manteniendo **Noir + UltraHonk** resuelto para compatibilidad completa con la suite de pruebas (`GAP-2`).

## 5. Funcionamiento de depósitos, retiros y verificación en Soroban
- **Depósito (`Pool::deposit`):** Requiere `from.require_auth()`, transfiere la denominación fija del token SAC (`XLM`) al contrato, inserta `commitment` en `Node(0, index)`, recalcula los 8 niveles hacia arriba con `poseidon_hash2` (CAP-0075 `env.crypto_hazmat().poseidon_permutation`), actualiza `ROOT`, guarda en `RootHist(index % 32)` e incrementa `NEXT`.
- **Retiro y verificación (`Pool::withdraw`):**
  1. Verifica que `is_known_root(root)` sea verdadero en el buffer `RootHist(0..32)`.
  2. Comprueba que `DataKey::Nullifier(nullifier_hash_be32)` no exista en almacenamiento (`Error::NullifierUsed`).
  3. Empaqueta las 4 señales públicas en orden (`root`, `nullifier_hash`, `recipient_field`, `fee_field`) y llama al contrato verificador en Soroban (`verifier-groth16.verify` o `verifier-ultrahonk.verify_proof`), que ejecuta el chequeo criptográfico sobre BN254 (CAP-0074). Si falla, revierte con `Error::BadProof`.
  4. Marca el nullifier como gastado (`storage().persistent()` / `instance()` con extensión de TTL) antes de transferir fondos.
  5. Transfiere `denomination - fee` a `recipient` y (si `fee > 0`) `fee` a `relayer`.

## 6. Requisitos de seguridad, privacidad y fugas residuales
- **Guardia de red:** Ejecución exclusiva en Stellar Testnet (`assertNotMainnet`).
- **Privacidad de secretos:** La nota `(nullifier, secret)` y las claves privadas nunca se envían al contrato ni a OpenRouter.
- **Lo que aún filtra metadatos (What still leaks):** Correlación temporal si se retira inmediatamente después de depositar; tamaño reducido del conjunto de anonimato; origen del fondeo inicial de XLM en la cuenta `B` (por ello se usa Friendbot); denominación fija visible.

## 7. Criterios de éxito verificables (Testnet)
1. Depósitos reales de `Alice` y `Bob` en Stellar Testnet actualizando la raíz de Merkle on-chain (`insert_matches_shared_root`).
2. Generación de prueba ZK válida para el vector de prueba y para el depósito real.
3. Retiro exitoso en Testnet hacia una dirección `fresh-1` verificando la prueba criptográficamente en Soroban (`withdraw_verifies_vector_proof`).
4. Segundo retiro con el mismo `nullifier_hash` rechazado con `Error::NullifierUsed` (`rejects_reused_nullifier`).
5. Prueba adulterada o raíz desconocida rechazada on-chain (`Error::BadProof` / `Error::UnknownRoot`).
6. Evidencia en el explorador de Testnet sin vínculo público entre la cuenta depositante y la cuenta receptora (`GAP-8`).
