#!/usr/bin/env bash
# Demo de punta a punta: alice deposita -> nota -> carol retira a dave -> segundo retiro rechazado.
set -uo pipefail
cd "$(dirname "$0")/.."
STELLAR=${STELLAR:-./tools/stellar.exe}
DAVE=$("$STELLAR" keys address dave)
ID=$(node -e 'console.log(require("./deploy.json").contractId)')
echo "contract: $ID"
echo "dave (destinatario): $DAVE"

bal() { "$STELLAR" contract invoke --id "$(node -e 'console.log(require("./deploy.json").token)')" --network testnet --source alice -- balance --id "$1" 2>/dev/null | tr -d '"'; }
echo "saldo dave antes:  $(bal $DAVE) stroops"

echo; echo "=== 1) alice deposita 10 XLM ==="
NOTE=$(node client/deposit.js alice) || { echo "deposit falló"; exit 1; }
echo "NOTA SECRETA (off-chain): $NOTE"

echo; echo "=== 2) carol retira 10 XLM a dave con prueba ZK (sin vínculo con alice) ==="
sleep 3
node client/withdraw.js "$NOTE" "$DAVE" carol || { echo "withdraw falló"; exit 1; }
echo "saldo dave después: $(bal $DAVE) stroops"

echo; echo "=== 3) intento de doble retiro con la misma nota (debe fallar: NullifierSpent = Error #5) ==="
if node client/withdraw.js "$NOTE" "$DAVE" carol 2>&1 | tail -2; then
  echo "!! el doble retiro NO fue rechazado"; exit 1
else
  echo "OK: doble retiro rechazado"
fi
echo; echo "Explorador: https://stellar.expert/explorer/testnet/contract/$ID"
