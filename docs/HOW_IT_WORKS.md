# Cómo Funciona: Pagos Privados ZK en Stellar Testnet

Este documento describe la arquitectura, la criptografía y el flujo de ejecución on-chain implementado en este repositorio para resolver el desafío de pagos privados mediante pruebas de conocimiento cero (**Zero-Knowledge Proofs**) en **Stellar Testnet** (Soroban / Protocolo 25).

---

## 1. El Problema de Privacidad que Resolvemos

En las blockchains públicas tradicionales, el grafo de transacciones es completamente transparente: cuando la cuenta A envía fondos a la cuenta B, cualquier observador puede vincular ambas direcciones, rastrear balances e inferir patrones de comportamiento financiero.

Nuestra solución rompe el **vínculo directo en el grafo transaccional** entre el depositante y el receptor:
- **Alice** o **Bob** depositan una cantidad fija de 10 XLM en un contrato inteligente de fondo común (*Privacy Pool*).
- El receptor (**Fresh Address**) retira los 10 XLM demostrando criptográficamente pertenencia al fondo sin revelar quién fue el depositante original ni qué nota específica le pertenece.

> **Alcance de la Privacidad:**  
> Ocultamos el **vínculo criptográfico directo** entre el depósito y el retiro. No garantizamos anonimato absoluto frente a heurísticas de correlación temporal ni ocultamos el monto de la transferencia (la denominación es fija de 10 XLM para evitar correlaciones por balance).

---

## 2. Diagrama del Flujo de la Solución

```
       [ Alice / Bob ]
              │
              ▼ (1) Genera localmente (secret, nullifier)
   commitment = Poseidon(secret, nullifier)
              │
              ▼ (2) Depósito: 10 XLM + commitment
    ┌──────────────────────────────────────────────┐
    │          Contrato Soroban: Pool              │
    │  - Custodia 10 XLM                          │
    │  - Inserta commitment en Árbol Merkle (h=8)  │
    │  - Actualiza raíz: RootHist[32]              │
    └──────────────────────────────────────────────┘
              │
              ▼ (3) Nota secreta guardada fuera de cadena
       [ Nota = 64 bytes ]
              │
              ▼ (4) Generación de Prueba ZK (Circom + Groth16)
   Demuestra: Conozco (secret, nullifier) dentro del árbol
   Entradas públicas: root, nullifier_hash, recipient, fee
              │
              ▼ (5) Invocación de Retiro
    ┌──────────────────────────────────────────────┐
    │       Contrato Verifier: Groth16 (BN254)     │
    │  - Verifica la prueba Groth16 con pairing    │
    └──────────────────────────────────────────────┘
              │ (Prueba válida)
              ▼ (6) Registra nullifier_hash (previene doble gasto)
    ┌──────────────────────────────────────────────┐
    │          Contrato Soroban: Pool              │
    │  - Transfiere 10 XLM a [ Fresh Recipient ]   │
    └──────────────────────────────────────────────┘
```

---

## 3. Arquitectura Criptográfica y Paso a Paso

### A. Depósito de 10 XLM
El usuario inicia un depósito en el contrato `Pool`. La cantidad está fijada en exactamente `100,000,000` stroops (10 XLM) para que todos los depósitos sean indistinguibles por volumen monetario.

### B. Generación del Compromiso (Poseidon Hash)
En el cliente, se generan aleatoriamente dos elementos en el campo escalar $\mathbb{F}_r$ de la curva BN254:
- `secret`: secreto criptográfico del usuario.
- `nullifier`: secreto utilizado para anular la nota en el momento del gasto.

El compromiso se calcula mediante la función hash amigable con SNARKs **Poseidon (t=3, Hash2)**:
$$\text{commitment} = \text{Poseidon}(\text{secret}, \text{nullifier})$$

La nota se codifica en 64 bytes (`nullifier || secret`, 32 bytes cada uno en big-endian) y nunca se transmite a la blockchain.

### C. Almacenamiento en el Árbol Merkle On-Chain
El contrato Soroban `Pool`:
1. Mantiene un árbol de Merkle incremental de altura 8 (capacidad de 256 notas).
2. Inserta el `commitment` como hoja en el siguiente índice disponible.
3. Recalcula los hashes intermedios utilizando una implementación optimizada de Poseidon compatible con Circom y BN254.
4. Almacena la nueva raíz en un búfer circular de 32 raíces históricas (`RootHist`) para permitir retiros válidos incluso si otros usuarios depositan después.

### D. Generación de Pruebas ZK (Circom 2.1.9 + Groth16)
Para retirar fondos, el usuario no revela su nota. En su lugar, el circuito `withdraw.circom` demuestra:
1. Posesión de `secret` y `nullifier`.
2. Que `commitment = Poseidon(secret, nullifier)`.
3. Que existe un camino de Merkle válido desde el compromiso hasta una raíz conocida del árbol (`root`).
4. Que el `nullifier_hash` público coincide con la separación de dominio:
   $$\text{nullifier\_hash} = \text{Poseidon}(1, \text{nullifier})$$
5. Vinculación estricta de `recipient` y `fee` para prevenir ataques de intermediarios (front-running / man-in-the-middle).

El sistema de pruebas compila las restricciones R1CS y produce una prueba compacta **Groth16** (elementos $A \in G_1$, $B \in G_2$, $C \in G_1$).

### E. Verificación On-Chain mediante Soroban
El contrato `Pool` delega la verificación al contrato `verifier-groth16` mediante llamada entre contratos (*cross-contract call*). El verificador implementa el emparejamiento bilineal (*bilinear pairing*) sobre la curva BN254 aprovechando las capacidades criptográficas del Protocolo 25 de Stellar (CAP-0074 y CAP-0075).

### F. Prevención de Doble Gasto (Nullifier Set)
El contrato `Pool` comprueba que el `nullifier_hash` no haya sido registrado previamente:
- Si ya existe en el almacenamiento persistente (`Nullifier(u256)`), la transacción se aborta con el error `Error(Contract, #4)` (`NullifierUsed`).
- Si es la primera vez que se presenta, se registra permanentemente como gastado.

### G. Retiro hacia una Dirección Limpia (Fresh Address)
Una vez validada la prueba Groth16 y verificado que el nullifier es nuevo, el contrato `Pool` transfiere automáticamente los 10 XLM a la dirección `recipient` especificada. La transacción de retiro es pagada por un relayer (o cuenta limpia fondeada), asegurando que el depositante original nunca interactúe con la cuenta receptora.

---

## 4. Contratos Desplegados y Evidencia en Stellar Testnet

| Componente | Dirección / Hash de Transacción | Enlace a Stellar Expert |
| :--- | :--- | :--- |
| **Verifier Groth16** | `CD5BZCJTLQUGUC5WBNCDLQETRQY3D6TS3MJCW2XIB4W7MMYWAFCNVMLT` | [Ver Contrato](https://stellar.expert/explorer/testnet/contract/CD5BZCJTLQUGUC5WBNCDLQETRQY3D6TS3MJCW2XIB4W7MMYWAFCNVMLT) |
| **Privacy Pool** | `CARO7SWGHRXZPIOL4UNEDST4IQIPMQSWYHMDQMYHX3PE62ZLG2NKUVS4` | [Ver Contrato](https://stellar.expert/explorer/testnet/contract/CARO7SWGHRXZPIOL4UNEDST4IQIPMQSWYHMDQMYHX3PE62ZLG2NKUVS4) |
| **Configuración VK** | `4964f8f0c15d55c8f50e03a1e1067b2170c9ea7bccffd700e51807dc20390978` | [Ver Transacción](https://stellar.expert/explorer/testnet/tx/4964f8f0c15d55c8f50e03a1e1067b2170c9ea7bccffd700e51807dc20390978) |
| **Depósito 1 (Alice)** | `1c65707057ef4b7599a77c3b6224916ca67d6ac9849f09c7ee1e8c4155bc894e` | [Ver Transacción](https://stellar.expert/explorer/testnet/tx/1c65707057ef4b7599a77c3b6224916ca67d6ac9849f09c7ee1e8c4155bc894e) |
| **Depósito 2 (Bob)** | `a3f0b8bc2119d24b8c63771a2f7810e9ebc7e2fe1ab17f372802d00c7b1c35d8` | [Ver Transacción](https://stellar.expert/explorer/testnet/tx/a3f0b8bc2119d24b8c63771a2f7810e9ebc7e2fe1ab17f372802d00c7b1c35d8) |
| **Retiro Privado ZK**| `e2001b0efad143d01d405a12b41a791baebdda55c807039e6f29560fdfb39dcc` | [Ver Transacción](https://stellar.expert/explorer/testnet/tx/e2001b0efad143d01d405a12b41a791baebdda55c807039e6f29560fdfb39dcc) |

### Pruebas de Seguridad Verificadas:
- **Protección Doble Gasto:** Al intentar reutilizar el mismo nullifier hash, el contrato Soroban rechaza la ejecución con `HostError: Error(Contract, #4)` (`NullifierUsed`).
- **Protección contra Pruebas Adulteradas:** Al enviar una prueba con señales públicas falsificadas o modificadas, el verifier on-chain rechaza la transacción con `HostError: Error(Contract, #5)` (`BadProof`).

---

## 5. Aplicación Web y Demostración en Vivo

- **URL de la Aplicación en Vercel:** [https://zk-pay-starter.vercel.app/app](https://zk-pay-starter.vercel.app/app)
- **Documento de Desvinculabilidad:** [`docs/lessons/UNLINKABILITY.md`](lessons/UNLINKABILITY.md)
