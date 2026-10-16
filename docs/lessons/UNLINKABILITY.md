# Unlinkability checklist (GAP-8)

Verified and grounded on Stellar Testnet (Protocol 25 / Soroban):

- [x] Withdrawal goes to a **fresh address** funded by Friendbot (or a relayer),
      never by the depositor. Fresh address: `GAH5RVMY5YPBIEZMYJIAGYJHHARMVR7S5ULUE5QI2Y2GXDQ6Y5DXRT67` funded directly via Friendbot API.
- [x] The pool had **at least 2 deposits from different addresses** before the
      withdraw. Deposit 1 (Alice): `1c65707057ef4b7599a77c3b6224916ca67d6ac9849f09c7ee1e8c4155bc894e`, Deposit 2 (Bob): `a3f0b8bc2119d24b8c63771a2f7810e9ebc7e2fe1ab17f372802d00c7b1c35d8`
- [x] Every deposit used the **same denomination**. Amount: `100000000` stroops (10 XLM)
- [x] The withdraw tx reveals only root, nullifier hash, recipient, fee — not
      the commitment, leaf index, or note. Explorer link / tx: `e2001b0efad143d01d405a12b41a791baebdda55c807039e6f29560fdfb39dcc` (https://stellar.expert/explorer/testnet/tx/e2001b0efad143d01d405a12b41a791baebdda55c807039e6f29560fdfb39dcc)
- [x] Double-spend of the same note is rejected. Error / tx: `HostError: Error(Contract, #4)` (`NullifierUsed` in `pool` contract `CARO7SWGHRXZPIOL4UNEDST4IQIPMQSWYHMDQMYHX3PE62ZLG2NKUVS4`)
- [x] A tampered proof is rejected live. Error / tx: `HostError: Error(Contract, #5)` (`BadProof` returned by `verifier-groth16` `CD5BZCJTLQUGUC5WBNCDLQETRQY3D6TS3MJCW2XIB4W7MMYWAFCNVMLT`)

## What still leaks (write a sentence each)

- Timing: A correlation attack is possible if a withdrawal occurs immediately after a deposit when traffic volume in the pool is low.
- Anonymity-set size: The anonymity set is strictly bounded by the number of active unspent deposits in the Merkle tree (currently $N=2$).
- Funding of the fresh address: The fresh recipient account requires base reserve/gas funding on Stellar (here provided by Friendbot/relayer) which may leave an independent funding trail.
- Amount (fixed denomination): Even though the exact source is hidden, an external observer knows that exactly 10 XLM was transferred per unit note.
