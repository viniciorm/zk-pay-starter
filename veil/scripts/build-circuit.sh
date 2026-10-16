#!/usr/bin/env bash
# Compila el circuito, hace el setup Groth16 (demo: una contribución con entropía fija)
# y verifica una prueba de extremo a extremo con inputs generados por client/tree.js.
set -euo pipefail
cd "$(dirname "$0")/.."
CIRCOM=${CIRCOM:-./tools/circom.exe}
SNARKJS=./node_modules/.bin/snarkjs
PTAU=${PTAU:-ptau/pot14_final.ptau}
B=circuits/build
mkdir -p $B

echo "[1/5] circom"
$CIRCOM circuits/withdraw.circom --r1cs --wasm -o $B -l node_modules
echo "[2/5] groth16 setup"
$SNARKJS groth16 setup $B/withdraw.r1cs $PTAU $B/withdraw_0000.zkey
echo "[3/5] contribute (demo entropy)"
$SNARKJS zkey contribute $B/withdraw_0000.zkey $B/withdraw_final.zkey --name="veil demo" -e="veil-demo-fixed-entropy"
$SNARKJS zkey export verificationkey $B/withdraw_final.zkey $B/verification_key.json
rm -f $B/withdraw_0000.zkey
echo "[4/5] test inputs via client/tree.js"
node client/tree.js
echo "[5/5] fullprove + verify"
$SNARKJS groth16 fullprove $B/input.json $B/withdraw_js/withdraw.wasm $B/withdraw_final.zkey $B/proof.json $B/public.json
$SNARKJS groth16 verify $B/verification_key.json $B/public.json $B/proof.json
echo "OK: circuit builds and a real proof verifies"
