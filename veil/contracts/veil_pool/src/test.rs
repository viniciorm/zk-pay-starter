#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Bytes, BytesN, Env, U256};

#[path = "test_fixture.rs"]
mod fx;

fn u(env: &Env, b: &[u8; 32]) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, b))
}

fn hex32(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi = (b[2 * i] as char).to_digit(16).unwrap() as u8;
        let lo = (b[2 * i + 1] as char).to_digit(16).unwrap() as u8;
        out[i] = hi * 16 + lo;
    }
    out
}

#[test]
fn poseidon_matches_circomlib() {
    let env = Env::default();
    let got = h2(&env, &U256::from_u32(&env, 1), &U256::from_u32(&env, 2));
    let want = u(&env, &hex32("115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a"));
    assert_eq!(got, want);
}

#[test]
fn recipient_fr_matches_fixture() {
    let env = Env::default();
    let dave = Address::from_str(&env, fx::RECIPIENT);
    assert_eq!(addr_to_fr(&env, &dave), u(&env, &fx::PUB[2]));
}

#[test]
fn groth16_verifies_real_snarkjs_proof() {
    let env = Env::default();
    let a = BytesN::from_array(&env, &fx::PROOF_A);
    let b = BytesN::from_array(&env, &fx::PROOF_B);
    let c = BytesN::from_array(&env, &fx::PROOF_C);
    let pubs = [u(&env, &fx::PUB[0]), u(&env, &fx::PUB[1]), u(&env, &fx::PUB[2])];
    assert!(groth16_verify(&env, &a, &b, &c, &pubs), "pairing failed: revisar orden c0/c1 de G2");
    let bad = [u(&env, &fx::PUB[0]), u(&env, &fx::PUB[1]), U256::from_u32(&env, 7)];
    assert!(!groth16_verify(&env, &a, &b, &c, &bad));
}

#[test]
fn full_flow_deposit_withdraw_double_spend() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let alice = Address::generate(&env);
    let dave = Address::from_str(&env, fx::RECIPIENT);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac.address();
    let denom: i128 = 100_000_000;
    StellarAssetClient::new(&env, &token_id).mint(&alice, &(denom * 10));

    let id = env.register(VeilPool, ());
    let client = VeilPoolClient::new(&env, &id);
    client.init(&token_id, &denom);

    for leaf in fx::LEAVES.iter() {
        client.deposit(&alice, &u(&env, leaf));
    }
    assert_eq!(client.next_index(), fx::LEAVES.len() as u32);
    assert_eq!(client.root(), u(&env, &fx::PUB[0]), "raiz on-chain != raiz de client/tree.js");

    let a = BytesN::from_array(&env, &fx::PROOF_A);
    let b = BytesN::from_array(&env, &fx::PROOF_B);
    let c = BytesN::from_array(&env, &fx::PROOF_C);
    let root = u(&env, &fx::PUB[0]);
    let nh = u(&env, &fx::PUB[1]);
    let tok = token::Client::new(&env, &token_id);
    assert_eq!(tok.balance(&dave), 0);
    client.withdraw(&a, &b, &c, &root, &nh, &dave);
    assert_eq!(tok.balance(&dave), denom);
    assert!(client.is_spent(&nh));

    let again = client.try_withdraw(&a, &b, &c, &root, &nh, &dave);
    assert_eq!(again, Err(Ok(Error::NullifierSpent)));

    let other = Address::generate(&env);
    let wrong = client.try_withdraw(&a, &b, &c, &root, &U256::from_u32(&env, 99), &other);
    assert_eq!(wrong, Err(Ok(Error::InvalidProof)));
}
