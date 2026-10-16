#!/usr/bin/env bash
# Build + deploy del contrato en testnet, init con el SAC de XLM nativo y denominación 10 XLM.
# Escribe deploy.json (contractId, token, startLedger) que usan los clientes.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
STELLAR=${STELLAR:-$(pwd)/tools/stellar.exe}
SOURCE=${SOURCE:-alice}
NET=testnet
DENOM=100000000

echo "[1/4] build"
(cd contracts && "$STELLAR" contract build >/dev/null)
WASM=contracts/target/wasm32v1-none/release/veil_pool.wasm
ls -la $WASM

echo "[2/4] deploy"
ID=$("$STELLAR" contract deploy --wasm $WASM --network $NET --source $SOURCE --alias veil_pool 2>/dev/null | tail -1)
echo "contract id: $ID"

echo "[3/4] init"
SAC=$("$STELLAR" contract id asset --asset native --network $NET)
echo "native SAC: $SAC"
"$STELLAR" contract invoke --id $ID --network $NET --source $SOURCE -- init --token $SAC --denomination $DENOM >/dev/null

echo "[4/4] deploy.json"
LEDGER=$(curl -s -X POST https://soroban-testnet.stellar.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.sequence))')
START=$((LEDGER - 50))
cat > deploy.json <<JSON
{ "contractId": "$ID", "token": "$SAC", "denomination": $DENOM, "startLedger": $START, "network": "testnet" }
JSON
cat deploy.json
echo "https://stellar.expert/explorer/testnet/contract/$ID"
