#![no_std]
//! Veil: privacy pool estilo Tornado en Soroban. Depósito fijo, Merkle tree Poseidon,
//! retiro con prueba Groth16 (BN254) + nullifier.
use soroban_poseidon::poseidon_hash;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    symbol_short, token, vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, Vec, U256,
};

mod vk;

pub const LEVELS: u32 = 16;
pub const ROOT_HISTORY: u32 = 30;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInit = 1,
    NotInit = 2,
    TreeFull = 3,
    UnknownRoot = 4,
    NullifierSpent = 5,
    InvalidProof = 6,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Token,
    Denom,
    Subtrees,  // Vec<U256> filled_subtrees[LEVELS]
    Zeros,     // Vec<U256> zeros[LEVELS+1]
    NextIndex, // u32
    Roots,     // Vec<U256> ring buffer de ROOT_HISTORY
    RootIdx,   // u32
    Nullifier(U256),
}

fn h2(env: &Env, a: &U256, b: &U256) -> U256 {
    poseidon_hash::<3, Bn254Fr>(env, &vec![env, a.clone(), b.clone()])
}

/// Fr del recipient: sha256(XDR del ScVal Address), primeros 31 bytes. Igual que client/addr.js.
fn addr_to_fr(env: &Env, a: &Address) -> U256 {
    let xdr = a.clone().to_xdr(env);
    let h = env.crypto().sha256(&xdr).to_bytes().to_array();
    let mut out = [0u8; 32];
    out[1..].copy_from_slice(&h[..31]);
    U256::from_be_bytes(env, &Bytes::from_array(env, &out))
}

fn g1(env: &Env, b: &[u8; 64]) -> Bn254G1Affine {
    Bn254G1Affine::from_bytes(BytesN::from_array(env, b))
}
fn g2(env: &Env, b: &[u8; 128]) -> Bn254G2Affine {
    Bn254G2Affine::from_bytes(BytesN::from_array(env, b))
}

/// Verificador Groth16: e(-A,B) * e(alpha,beta) * e(vk_x,gamma) * e(C,delta) == 1
fn groth16_verify(env: &Env, a: &BytesN<64>, b: &BytesN<128>, c: &BytesN<64>, pub_signals: &[U256; 3]) -> bool {
    let bn = env.crypto().bn254();
    let mut vk_x = g1(env, &vk::IC[0]);
    for (i, s) in pub_signals.iter().enumerate() {
        let prod = bn.g1_mul(&g1(env, &vk::IC[i + 1]), &Bn254Fr::from_u256(s.clone()));
        vk_x = bn.g1_add(&vk_x, &prod);
    }
    let neg_a = -Bn254G1Affine::from_bytes(a.clone());
    let vp1 = vec![env, neg_a, g1(env, &vk::ALPHA), vk_x, Bn254G1Affine::from_bytes(c.clone())];
    let vp2 = vec![env, Bn254G2Affine::from_bytes(b.clone()), g2(env, &vk::BETA), g2(env, &vk::GAMMA), g2(env, &vk::DELTA)];
    bn.pairing_check(vp1, vp2)
}

#[contract]
pub struct VeilPool;

#[contractimpl]
impl VeilPool {
    /// token = SAC de XLM; denomination en stroops (10 XLM = 100_000_000).
    pub fn init(env: Env, token: Address, denomination: i128) -> Result<(), Error> {
        let st = env.storage().persistent();
        if st.has(&DataKey::Token) {
            return Err(Error::AlreadyInit);
        }
        st.set(&DataKey::Token, &token);
        st.set(&DataKey::Denom, &denomination);
        // zeros[0] = 0 (hoja vacia), zeros[i] = H(zeros[i-1], zeros[i-1]) -- igual que client/tree.js
        let mut zeros: Vec<U256> = vec![&env, U256::from_u32(&env, 0)];
        let mut subtrees: Vec<U256> = vec![&env];
        for i in 0..LEVELS {
            let z = zeros.get(i).unwrap();
            subtrees.push_back(z.clone());
            zeros.push_back(h2(&env, &z, &z));
        }
        let empty_root = zeros.get(LEVELS).unwrap();
        let mut roots: Vec<U256> = vec![&env];
        for _ in 0..ROOT_HISTORY {
            roots.push_back(empty_root.clone());
        }
        st.set(&DataKey::Zeros, &zeros);
        st.set(&DataKey::Subtrees, &subtrees);
        st.set(&DataKey::Roots, &roots);
        st.set(&DataKey::RootIdx, &0u32);
        st.set(&DataKey::NextIndex, &0u32);
        Ok(())
    }

    /// Cobra la denominacion a `from` e inserta `commitment` en el arbol. Emite deposit(commitment, index).
    pub fn deposit(env: Env, from: Address, commitment: U256) -> Result<u32, Error> {
        from.require_auth();
        let st = env.storage().persistent();
        let token: Address = st.get(&DataKey::Token).ok_or(Error::NotInit)?;
        let denom: i128 = st.get(&DataKey::Denom).ok_or(Error::NotInit)?;
        token::Client::new(&env, &token).transfer(&from, &env.current_contract_address(), &denom);

        let index: u32 = st.get(&DataKey::NextIndex).unwrap_or(0);
        if index >= (1u32 << LEVELS) {
            return Err(Error::TreeFull);
        }
        let zeros: Vec<U256> = st.get(&DataKey::Zeros).ok_or(Error::NotInit)?;
        let mut subtrees: Vec<U256> = st.get(&DataKey::Subtrees).ok_or(Error::NotInit)?;
        let mut cur = commitment.clone();
        let mut idx = index;
        for i in 0..LEVELS {
            let (left, right) = if idx % 2 == 0 {
                subtrees.set(i, cur.clone());
                (cur.clone(), zeros.get(i).unwrap())
            } else {
                (subtrees.get(i).unwrap(), cur.clone())
            };
            cur = h2(&env, &left, &right);
            idx /= 2;
        }
        let mut roots: Vec<U256> = st.get(&DataKey::Roots).ok_or(Error::NotInit)?;
        let ri = (st.get::<_, u32>(&DataKey::RootIdx).unwrap_or(0) + 1) % ROOT_HISTORY;
        roots.set(ri, cur);
        st.set(&DataKey::Roots, &roots);
        st.set(&DataKey::RootIdx, &ri);
        st.set(&DataKey::Subtrees, &subtrees);
        st.set(&DataKey::NextIndex, &(index + 1));
        env.events().publish((symbol_short!("deposit"),), (commitment, index));
        Ok(index)
    }

    /// Verifica raiz conocida, nullifier nuevo y prueba Groth16; marca nullifier y paga a `recipient`.
    pub fn withdraw(
        env: Env,
        proof_a: BytesN<64>,
        proof_b: BytesN<128>,
        proof_c: BytesN<64>,
        root: U256,
        nullifier_hash: U256,
        recipient: Address,
    ) -> Result<(), Error> {
        let st = env.storage().persistent();
        let roots: Vec<U256> = st.get(&DataKey::Roots).ok_or(Error::NotInit)?;
        if !roots.contains(&root) {
            return Err(Error::UnknownRoot);
        }
        if st.has(&DataKey::Nullifier(nullifier_hash.clone())) {
            return Err(Error::NullifierSpent);
        }
        let pub_signals = [root, nullifier_hash.clone(), addr_to_fr(&env, &recipient)];
        if !groth16_verify(&env, &proof_a, &proof_b, &proof_c, &pub_signals) {
            return Err(Error::InvalidProof);
        }
        st.set(&DataKey::Nullifier(nullifier_hash.clone()), &true);
        let token: Address = st.get(&DataKey::Token).ok_or(Error::NotInit)?;
        let denom: i128 = st.get(&DataKey::Denom).ok_or(Error::NotInit)?;
        token::Client::new(&env, &token).transfer(&env.current_contract_address(), &recipient, &denom);
        env.events().publish((symbol_short!("withdraw"),), (nullifier_hash, recipient));
        Ok(())
    }

    // ---- lecturas ----
    pub fn root(env: Env) -> U256 {
        let st = env.storage().persistent();
        let roots: Vec<U256> = st.get(&DataKey::Roots).unwrap();
        roots.get(st.get(&DataKey::RootIdx).unwrap_or(0)).unwrap()
    }
    pub fn next_index(env: Env) -> u32 {
        env.storage().persistent().get(&DataKey::NextIndex).unwrap_or(0)
    }
    pub fn is_spent(env: Env, nullifier_hash: U256) -> bool {
        env.storage().persistent().has(&DataKey::Nullifier(nullifier_hash))
    }
    pub fn poseidon2(env: Env, a: U256, b: U256) -> U256 {
        h2(&env, &a, &b)
    }
    pub fn recipient_fr(env: Env, recipient: Address) -> U256 {
        addr_to_fr(&env, &recipient)
    }
    /// Solo verificacion criptografica (sin estado), util para depurar on-chain.
    pub fn verify(env: Env, proof_a: BytesN<64>, proof_b: BytesN<128>, proof_c: BytesN<64>, root: U256, nullifier_hash: U256, recipient_fr: U256) -> bool {
        groth16_verify(&env, &proof_a, &proof_b, &proof_c, &[root, nullifier_hash, recipient_fr])
    }
}

#[cfg(test)]
mod test;
