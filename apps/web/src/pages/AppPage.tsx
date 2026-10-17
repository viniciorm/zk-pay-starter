import { useState, useEffect } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  commitment,
  encodeNote,
  decodeNote,
  nullifierHash,
  fieldFromBe32,
  encodeGroth16Proof,
  MerkleTree,
} from "@zk-pay/shared";
import {
  isConnected as isFreighterConnected,
  requestAccess as requestFreighterAccess,
  signTransaction as signFreighterTransaction,
} from "@stellar/freighter-api";
import {
  rpc as sorobanRpc,
  Contract,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import * as snarkjs from "snarkjs";

function generateRandomField(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return fieldFromBe32(bytes);
}

interface SavedNote {
  encoded: string;
  secret: string;
  nullifier: string;
  commitment: string;
  leafIndex?: number;
  timestamp: string;
}

const API_BASE =
  (import.meta.env.VITE_API_URL as string) ||
  (window.location.hostname.includes("vercel.app")
    ? "https://arts-officers-reviewer-huge.trycloudflare.com"
    : "/api");

const POOL_ID =
  (import.meta.env.VITE_POOL_ID as string) ||
  "CARO7SWGHRXZPIOL4UNEDST4IQIPMQSWYHMDQMYHX3PE62ZLG2NKUVS4";

const RPC_URL =
  (import.meta.env.VITE_SOROBAN_RPC_URL as string) ||
  "https://soroban-testnet.stellar.org";

const NETWORK_PASSPHRASE =
  (import.meta.env.VITE_NETWORK_PASSPHRASE as string) ||
  Networks.TESTNET;

export function AppPage() {
  const [walletType, setWalletType] = useState<"freighter" | "ephemeral">("freighter");
  const [connectedAddress, setConnectedAddress] = useState<string>("");
  const [hasFreighter, setHasFreighter] = useState<boolean>(false);
  const [ephemeralKeypair, setEphemeralKeypair] = useState<Keypair | null>(null);

  const [notes, setNotes] = useState<SavedNote[]>([]);
  const [selectedNote, setSelectedNote] = useState<string>("");
  const [recipient, setRecipient] = useState<string>("");
  const [log, setLog] = useState<string>("Ready to execute private payments on Stellar Testnet.\n");
  const [loading, setLoading] = useState<boolean>(false);
  const [aiMessage, setAiMessage] = useState<string>("");
  const [lastDepositTx, setLastDepositTx] = useState<string>("");
  const [lastWithdrawTx, setLastWithdrawTx] = useState<string>("");

  const appendLog = (msg: string) => {
    setLog((prev) => `${prev}[${new Date().toLocaleTimeString()}] ${msg}\n`);
  };

  // Check for Freighter availability on mount
  useEffect(() => {
    async function checkFreighter() {
      try {
        const res = await isFreighterConnected();
        const connected = typeof res === "boolean" ? res : res.isConnected;
        setHasFreighter(connected);
        if (connected) {
          appendLog("Freighter wallet extension detected.");
        } else {
          appendLog("Freighter not detected. You can use ephemeral in-browser identities for sandbox testing.");
        }
      } catch {
        setHasFreighter(false);
      }
    }
    checkFreighter();
  }, []);

  // Connect Freighter
  async function handleConnectFreighter() {
    setLoading(true);
    appendLog("Requesting access from Freighter wallet extension...");
    try {
      const res = await requestFreighterAccess();
      const addr = typeof res === "string" ? res : res?.address;
      if (addr) {
        setConnectedAddress(addr);
        setWalletType("freighter");
        setEphemeralKeypair(null);
        appendLog(`Connected to Freighter: ${addr}`);
      } else {
        const err = typeof res === "object" ? res?.error : "Access denied";
        throw new Error(err || "Could not retrieve address from Freighter");
      }
    } catch (e: any) {
      appendLog(`Freighter connection error: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  // Generate a brand new, completely ephemeral keypair in browser (sandbox mode)
  function handleGenerateEphemeral() {
    const kp = Keypair.random();
    setEphemeralKeypair(kp);
    setConnectedAddress(kp.publicKey());
    setWalletType("ephemeral");
    appendLog(`Generated new ephemeral in-browser wallet: ${kp.publicKey()}`);
    appendLog("Note: Key is held only in browser memory and never transmitted to the server.");
  }

  // Fund active address via Friendbot
  async function handleFundActiveAddress() {
    if (!connectedAddress) return;
    setLoading(true);
    appendLog(`Requesting Friendbot funding for ${connectedAddress.slice(0, 10)}...`);
    try {
      const res = await fetch(`${API_BASE}/fund`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: connectedAddress }),
      });
      const data = await res.json();
      if (data.funded) {
        appendLog(`Friendbot funded ${connectedAddress.slice(0, 10)}... successfully!`);
      } else {
        throw new Error(data.error || `Friendbot response status: ${data.status}`);
      }
    } catch (e: any) {
      appendLog(`Friendbot funding error: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  // Handle Client-Side Independent Deposit
  async function handleDeposit() {
    if (!connectedAddress) {
      appendLog("Please connect Freighter or generate an ephemeral wallet to deposit.");
      return;
    }
    setLoading(true);
    setLastDepositTx("");
    appendLog("--- INITIATING INDEPENDENT DEPOSIT (10 XLM) ---");
    appendLog("1. Generating secret and nullifier client-side...");
    try {
      const sec = generateRandomField();
      const nll = generateRandomField();
      const com = commitment({ secret: sec, nullifier: nll });
      const encoded = encodeNote({ secret: sec, nullifier: nll });

      appendLog(`Commitment computed: ${com.toString().slice(0, 20)}...`);
      appendLog(`2. Assembling Soroban deposit transaction for ${connectedAddress.slice(0, 8)}...`);

      const server = new sorobanRpc.Server(RPC_URL);
      const contract = new Contract(POOL_ID);
      const account = await server.getAccount(connectedAddress);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          contract.call(
            "deposit",
            nativeToScVal(connectedAddress, { type: "address" }),
            nativeToScVal(com, { type: "u256" })
          )
        )
        .setTimeout(60)
        .build();

      appendLog("3. Simulating and preparing transaction via Soroban RPC...");
      const prepared = await server.prepareTransaction(tx);

      let signedTxXdr = "";
      if (walletType === "freighter") {
        appendLog("4. Requesting signature from Freighter extension...");
        const signRes = await signFreighterTransaction(prepared.toXDR(), {
          network: "TESTNET",
          networkPassphrase: NETWORK_PASSPHRASE,
        });
        const xdrResult = typeof signRes === "string" ? signRes : signRes?.signedTxXdr;
        if (!xdrResult) {
          const err = typeof signRes === "object" ? signRes?.error : "User rejected signature";
          throw new Error(err || "Transaction signing failed in Freighter");
        }
        signedTxXdr = xdrResult;
      } else {
        appendLog("4. Signing transaction in-browser using ephemeral keypair...");
        if (!ephemeralKeypair) throw new Error("No ephemeral keypair available for signing");
        prepared.sign(ephemeralKeypair);
        signedTxXdr = prepared.toXDR();
      }

      appendLog("5. Submitting signed transaction to Stellar Testnet...");
      let txHash = "";
      let leafIndex: number | undefined = undefined;

      try {
        const sendRes = await server.sendTransaction(new Transaction(signedTxXdr, NETWORK_PASSPHRASE));
        if (sendRes.status === "ERROR") {
          throw new Error(`RPC sendTransaction error: ${JSON.stringify(sendRes)}`);
        }
        txHash = sendRes.hash;
        appendLog(`Transaction submitted to ledger! Hash: ${txHash}`);
        appendLog("Awaiting confirmation...");
        const pollRes = await server.pollTransaction(txHash);
        if (pollRes.status !== "SUCCESS") {
          throw new Error(`Transaction failed on ledger with status: ${pollRes.status}`);
        }
        if (pollRes.returnValue) {
          leafIndex = Number(scValToNative(pollRes.returnValue));
        }
      } catch (directErr) {
        appendLog("Direct RPC submission failed, falling back to broadcast endpoint...");
        const bRes = await fetch(`${API_BASE}/pay/broadcast`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ signedTxXdr }),
        });
        const bData = await bRes.json();
        if (!bData.ok) {
          throw new Error(bData.error || "Broadcast submission failed");
        }
        txHash = bData.txHash;
        leafIndex = bData.leafIndex;
      }

      const confirmedLeaf = leafIndex ?? 0;
      setLastDepositTx(txHash);
      appendLog(`Deposit confirmed on Stellar Testnet! Leaf Index = #${confirmedLeaf}`);
      appendLog(`Stellar Expert: https://stellar.expert/explorer/testnet/tx/${txHash}`);

      const newNoteObj: SavedNote = {
        encoded,
        secret: sec.toString(),
        nullifier: nll.toString(),
        commitment: com.toString(),
        leafIndex: confirmedLeaf,
        timestamp: new Date().toLocaleTimeString(),
      };

      setNotes((prev) => [newNoteObj, ...prev]);
      setSelectedNote(encoded);

      // Trigger AI Step via OpenRouter
      fetch(`${API_BASE}/pay/ai-step`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "deposit",
          amount: "10 XLM",
          memo: `Deposit leaf #${confirmedLeaf} from ${connectedAddress.slice(0, 8)}`,
        }),
      })
        .then((r) => r.json())
        .then((aiRes) => {
          if (aiRes.ok && aiRes.result?.text) {
            setAiMessage(`AI Copilot: ${aiRes.result.text}`);
            appendLog(`OpenRouter AI: ${aiRes.result.text}`);
          }
        })
        .catch(() => {});
    } catch (e: any) {
      appendLog(`Error during deposit: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleFundFresh() {
    setLoading(true);
    appendLog("Requesting fresh funded recipient from Friendbot...");
    try {
      const kp = Keypair.random();
      const res = await fetch(`${API_BASE}/fund`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: kp.publicKey() }),
      });
      const data = await res.json();
      if (data.funded) {
        setRecipient(kp.publicKey());
        appendLog(`Fresh recipient created and funded: ${kp.publicKey()}`);
      } else {
        throw new Error(data.error || "Friendbot failed");
      }
    } catch (e: any) {
      appendLog(`Failed to fund fresh recipient: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  // Handle Client-Side Groth16 Proving and Anonymous Withdrawal
  async function handleWithdraw() {
    if (!selectedNote || !recipient) {
      appendLog("Please select a note and enter a recipient address.");
      return;
    }
    setLoading(true);
    setLastWithdrawTx("");
    appendLog(`--- INITIATING CLIENT-SIDE ZK WITHDRAWAL TO ${recipient.slice(0, 10)}... ---`);
    try {
      const decoded = decodeNote(selectedNote);
      const noteItem = notes.find((n) => n.encoded === selectedNote);
      const leafIndex = noteItem?.leafIndex ?? 0;

      const secretBig = BigInt(decoded.secret);
      const nullifierBig = BigInt(decoded.nullifier);
      const cBig = commitment({ secret: secretBig, nullifier: nullifierBig });
      const nfBig = nullifierHash(nullifierBig);

      appendLog("1. Reconstructing live Merkle tree from Soroban deposit events...");
      const recStr = recipient.trim();
      const rScalar = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      let recipientBig = 0n;
      for (let i = 0; i < 32; i++) {
        recipientBig = (recipientBig << 8n) | BigInt(recStr.charCodeAt(i) || 0);
      }
      recipientBig = recipientBig % rScalar;

      // Fetch on-chain deposit events to assemble sibling path
      const latestRes = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
      });
      const latest = (await latestRes.json()).result.sequence;
      const eventsRes = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "getEvents",
          params: {
            startLedger: latest - 10000,
            filters: [{ type: "contract", contractIds: [POOL_ID] }],
          },
        }),
      });
      const events = (await eventsRes.json()).result?.events ?? [];
      const leaves: bigint[] = [];
      for (const ev of events) {
        try {
          const val = xdr.ScVal.fromXDR(ev.value, "base64");
          const native = scValToNative(val);
          if (native && native.commitment !== undefined) {
            leaves[Number(native.index)] = BigInt(native.commitment.toString());
          }
        } catch {}
      }
      leaves[leafIndex] = cBig;

      const tree = new MerkleTree(8);
      for (let i = 0; i < leaves.length; i++) {
        tree.insert(leaves[i] ?? 0n);
      }
      const proofObj = tree.proof(leafIndex);
      const expectedRoot = proofObj.root;
      const elements = proofObj.pathElements.map((x) => x.toString());
      const indices = proofObj.pathIndices;

      appendLog(`Merkle root for proof: ${expectedRoot.toString().slice(0, 16)}...`);
      appendLog("2. Computing Zero-Knowledge Groth16 proof locally in browser (WebAssembly)...");
      appendLog("Security Notice: The server will NOT receive secrets, nullifiers, or private witnesses.");

      const circuitInput = {
        root: expectedRoot.toString(),
        nullifierHash: nfBig.toString(),
        recipient: recipientBig.toString(),
        fee: "0",
        secret: secretBig.toString(),
        nullifier: nullifierBig.toString(),
        pathElements: elements,
        pathIndices: indices,
      };

      const { proof } = await snarkjs.groth16.fullProve(
        circuitInput,
        "/circuits/withdraw.wasm",
        "/circuits/withdraw.zkey"
      );

      const proofBytes = encodeGroth16Proof(proof);
      const proofHex = Array.from(proofBytes).map((b) => b.toString(16).padStart(2, "0")).join("");

      appendLog(`Proof successfully calculated! Nullifier hash: ${nfBig.toString().slice(0, 16)}...`);
      appendLog("3. Submitting public proof to relayer on Stellar Testnet...");

      // Submit ONLY public parameters to the relayer
      const withdrawRes = await fetch(`${API_BASE}/pay/withdraw`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proofHex,
          root: expectedRoot.toString(),
          nullifierHash: nfBig.toString(),
          recipient,
          fee: "0",
        }),
      });
      const withdrawData = await withdrawRes.json();
      if (!withdrawData.ok) {
        throw new Error(withdrawData.error || "Withdraw transaction failed");
      }

      if (withdrawData.txHash) {
        setLastWithdrawTx(withdrawData.txHash);
        appendLog(`Withdrawal confirmed on-chain! Tx: ${withdrawData.txHash}`);
        appendLog(`Explorer: https://stellar.expert/explorer/testnet/tx/${withdrawData.txHash}`);
      } else {
        appendLog("Withdrawal confirmed! 10 XLM transferred to fresh recipient.");
      }

      // Trigger AI step
      fetch(`${API_BASE}/pay/ai-step`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "withdraw",
          recipient,
          amount: "10 XLM",
        }),
      })
        .then((r) => r.json())
        .then((aiRes) => {
          if (aiRes.ok && aiRes.result?.text) {
            setAiMessage(`AI Copilot: ${aiRes.result.text}`);
            appendLog(`OpenRouter AI: ${aiRes.result.text}`);
          }
        })
        .catch(() => {});
    } catch (e: any) {
      appendLog(`Error during withdrawal: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  function downloadNote(note: SavedNote) {
    const blob = new Blob([JSON.stringify(note, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zk-note-${note.timestamp.replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="p-6 max-w-4xl mx-auto space-y-6">
      <header className="border-b border-graphite pb-4">
        <h1 className="text-3xl font-bold text-amber mb-1">Stellar ZK Private Payments</h1>
        <p className="text-sm text-graphite">
          Zero-Knowledge private pool on Stellar Testnet (Client-Side Groth16 BN254 + Soroban Protocol 25).
        </p>
      </header>

      {/* Depositor Wallet Bar */}
      <section className="border border-graphite p-4 rounded-lg bg-ink/70 space-y-3">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
          <div>
            <span className="text-xs font-mono text-graphite uppercase block">Active Depositor Wallet:</span>
            <span className="font-mono text-sm text-paper font-semibold">
              {connectedAddress ? `${connectedAddress.slice(0, 12)}...${connectedAddress.slice(-8)}` : "No wallet connected"}
            </span>
            <span className="ml-2 text-xs px-2 py-0.5 rounded bg-amber/20 text-amber">
              {walletType === "freighter" ? "Freighter Extension" : "Ephemeral Test Wallet (Browser-Only)"}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {hasFreighter && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleConnectFreighter}
                disabled={loading}
                className="text-xs"
              >
                Connect Freighter
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleGenerateEphemeral}
              disabled={loading}
              className="text-xs border-graphite text-graphite hover:text-paper"
            >
              + New Ephemeral Wallet
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleFundActiveAddress}
              disabled={loading || !connectedAddress}
              className="text-xs border-amber/50 text-amber hover:bg-amber/10"
            >
              + Fund via Friendbot
            </Button>
          </div>
        </div>
      </section>

      {aiMessage && (
        <div className="bg-amber/10 border border-amber/40 p-3 rounded text-sm text-amber flex items-center justify-between">
          <span>{aiMessage}</span>
          <button className="text-xs text-graphite ml-4 hover:underline" onClick={() => setAiMessage("")}>✕</button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Deposit Panel */}
        <section className="border border-graphite p-5 rounded-lg space-y-4 bg-ink/40">
          <h2 className="text-xl font-semibold text-paper">1. Deposit 10 XLM</h2>
          <p className="text-xs text-graphite">
            Locks a uniform denomination of 10 XLM in the pool. The transaction is signed directly from your active wallet with zero server custody.
          </p>

          <div className="p-3 bg-graphite/10 border border-graphite/30 rounded text-xs text-graphite space-y-1">
            <div><strong>Denomination:</strong> 10.0000000 XLM (Uniform)</div>
            <div><strong>Signing:</strong> {walletType === "freighter" ? "Freighter Extension" : "Local Client-Side (Zero Server Keys)"}</div>
          </div>

          <Button onClick={handleDeposit} disabled={loading || !connectedAddress} className="w-full">
            {loading ? "Signing & Confirming on Testnet..." : "Deposit 10 XLM & Create Note"}
          </Button>

          {lastDepositTx && (
            <div className="text-xs p-2 bg-amber/10 border border-amber/30 rounded text-amber">
              <div>Deposit Tx Confirmed!</div>
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${lastDepositTx}`}
                target="_blank"
                rel="noreferrer"
                className="underline font-mono break-all hover:text-paper block mt-1"
              >
                View on Stellar Expert ↗
              </a>
            </div>
          )}
        </section>

        {/* Withdraw Panel */}
        <section className="border border-graphite p-5 rounded-lg space-y-4 bg-ink/40">
          <h2 className="text-xl font-semibold text-paper">2. Private Withdraw</h2>
          <p className="text-xs text-graphite">
            Redeems 10 XLM to an unlinked recipient using a client-side zero-knowledge proof.
          </p>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-graphite">Recipient Address (Fresh Key):</label>
              <button
                type="button"
                onClick={handleFundFresh}
                className="text-xs text-amber hover:underline"
              >
                + Generate Fresh via Friendbot
              </button>
            </div>
            <Input
              placeholder="G... (Fresh destination address)"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs text-graphite block">Note String:</label>
            <Input
              placeholder="64-byte hex note string"
              value={selectedNote}
              onChange={(e) => setSelectedNote(e.target.value)}
            />
          </div>
          <Button onClick={handleWithdraw} disabled={loading || !selectedNote || !recipient} className="w-full">
            {loading ? "Calculating Proof (Client-Side) & Verifying..." : "Withdraw Privately"}
          </Button>

          {lastWithdrawTx && (
            <div className="text-xs p-2 bg-amber/10 border border-amber/30 rounded text-amber">
              <div>Withdrawal Tx Confirmed!</div>
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${lastWithdrawTx}`}
                target="_blank"
                rel="noreferrer"
                className="underline font-mono break-all hover:text-paper block mt-1"
              >
                View on Stellar Expert ↗
              </a>
            </div>
          )}
        </section>
      </div>

      {/* Notes Vault */}
      <section className="border border-graphite p-5 rounded-lg space-y-3 bg-ink/40">
        <h3 className="text-lg font-medium text-paper flex items-center justify-between">
          <span>Private Notes Vault</span>
          <span className="text-xs text-graphite">{notes.length} note(s) stored locally</span>
        </h3>
        {notes.length === 0 ? (
          <p className="text-xs text-graphite italic">No notes generated yet. Make a deposit above.</p>
        ) : (
          <div className="space-y-2">
            {notes.map((n, i) => (
              <div key={i} className="border border-graphite/50 p-3 rounded text-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-2">
                <div className="font-mono truncate max-w-lg">
                  <span className="text-amber">[{n.timestamp}]</span> Leaf #{n.leafIndex}: {n.encoded.slice(0, 32)}...
                </div>
                <div className="flex gap-2">
                  <button
                    className="border border-graphite px-2 py-1 rounded hover:bg-graphite/20"
                    onClick={() => setSelectedNote(n.encoded)}
                  >
                    Select
                  </button>
                  <button
                    className="border border-amber text-amber px-2 py-1 rounded hover:bg-amber/10"
                    onClick={() => downloadNote(n)}
                  >
                    Download
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Activity Log */}
      <section className="border border-graphite p-4 rounded-lg bg-ink/60">
        <h4 className="text-xs uppercase font-mono text-graphite mb-2">Live Session Logs</h4>
        <pre className="text-xs font-mono text-paper whitespace-pre-wrap max-h-48 overflow-y-auto">
          {log}
        </pre>
      </section>
    </main>
  );
}
