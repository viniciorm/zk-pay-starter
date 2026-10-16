import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { commitment, encodeNote, decodeNote, nullifierHash, Fr, fieldFromBe32 } from "@zk-pay/shared";

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

const API_BASE = (import.meta.env.VITE_API_URL as string) || (window.location.hostname.includes("vercel.app") ? "https://arts-officers-reviewer-huge.trycloudflare.com" : "/api");

export function AppPage() {
  const [notes, setNotes] = useState<SavedNote[]>([]);
  const [selectedNote, setSelectedNote] = useState<string>("");
  const [recipient, setRecipient] = useState<string>("");
  const [customSecret, setCustomSecret] = useState<string>("");
  const [log, setLog] = useState<string>("Ready to execute private payments on Stellar Testnet.\n");
  const [loading, setLoading] = useState<boolean>(false);
  const [aiMessage, setAiMessage] = useState<string>("");

  const appendLog = (msg: string) => {
    setLog((prev) => `${prev}[${new Date().toLocaleTimeString()}] ${msg}\n`);
  };

  async function handleDeposit() {
    setLoading(true);
    appendLog("Generating new secret and nullifier for private note...");
    try {
      const sec = generateRandomField();
      const nll = generateRandomField();
      const com = commitment({ secret: sec, nullifier: nll });
      const encoded = encodeNote({ secret: sec, nullifier: nll });

      appendLog(`Commitment computed: ${com.toString().slice(0, 20)}...`);
      appendLog("Submitting deposit of 10 XLM to Soroban Pool contract...");

      const res = await fetch(`${API_BASE}/pay/deposit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commitment: com.toString(),
          fromSecret: customSecret || undefined,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || "Deposit failed");
      }

      const leafIndex = data.leafIndex ?? 0;
      appendLog(`Deposit confirmed on Stellar Testnet! Leaf Index = ${leafIndex}`);

      const newNoteObj: SavedNote = {
        encoded,
        secret: sec.toString(),
        nullifier: nll.toString(),
        commitment: com.toString(),
        leafIndex,
        timestamp: new Date().toLocaleTimeString(),
      };

      setNotes((prev) => [newNoteObj, ...prev]);
      setSelectedNote(encoded);

      // Trigger AI Step via OpenRouter
      appendLog("Invoking OpenRouter AI copilot step...");
      fetch(`${API_BASE}/pay/ai-step`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "deposit",
          amount: "10 XLM",
          memo: `Deposit leaf #${leafIndex}`,
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
      appendLog(`Error during deposit: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleFundFresh() {
    setLoading(true);
    appendLog("Requesting fresh funded address from Friendbot...");
    try {
      const res = await fetch(`${API_BASE}/fund`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = await res.json();
      if (data.address) {
        setRecipient(data.address);
        appendLog(`Fresh recipient generated: ${data.address}`);
      }
    } catch (e: any) {
      appendLog(`Failed to fund address: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleWithdraw() {
    if (!selectedNote || !recipient) {
      appendLog("Please select a note and enter a recipient address.");
      return;
    }
    setLoading(true);
    appendLog(`Preparing anonymous withdrawal to ${recipient}...`);
    try {
      const decoded = decodeNote(selectedNote);
      const noteItem = notes.find((n) => n.encoded === selectedNote);
      const leafIndex = noteItem?.leafIndex ?? 0;

      appendLog("Generating Zero-Knowledge Groth16 withdrawal proof...");
      const proveRes = await fetch(`${API_BASE}/pay/prove-withdraw`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret: decoded.secret.toString(),
          nullifier: decoded.nullifier.toString(),
          leafIndex,
          recipient,
          fee: "0",
        }),
      });
      const proveData = await proveRes.json();
      if (!proveData.ok) {
        throw new Error(proveData.error || "Proof generation failed");
      }

      appendLog(`Proof generated successfully! Nullifier hash: ${proveData.nullifierHash.slice(0, 16)}...`);
      appendLog("Submitting withdrawal transaction to Stellar Testnet...");

      const withdrawRes = await fetch(`${API_BASE}/pay/withdraw`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proofHex: proveData.proofHex,
          root: proveData.root,
          nullifierHash: proveData.nullifierHash,
          recipient,
          fee: "0",
        }),
      });
      const withdrawData = await withdrawRes.json();
      if (!withdrawData.ok) {
        throw new Error(withdrawData.error || "Withdraw transaction failed");
      }

      appendLog(`Withdrawal confirmed! 10 XLM transferred to fresh recipient.`);

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
      appendLog(`Error during withdrawal: ${e.message || e}`);
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
          Zero-Knowledge private pool on Stellar Testnet (Soroban + Circom 2.1.9 + Groth16 BN254).
        </p>
      </header>

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
            Locks a fixed denomination of 10 XLM in the privacy pool and outputs a private 64-byte note.
          </p>
          <div className="space-y-2">
            <label className="text-xs text-graphite block">Optional Depositor Secret (defaults to Alice):</label>
            <Input
              type="password"
              placeholder="S... (Leave blank for funded Alice key)"
              value={customSecret}
              onChange={(e) => setCustomSecret(e.target.value)}
            />
          </div>
          <Button onClick={handleDeposit} disabled={loading} className="w-full">
            {loading ? "Processing..." : "Deposit 10 XLM & Create Note"}
          </Button>
        </section>

        {/* Withdraw Panel */}
        <section className="border border-graphite p-5 rounded-lg space-y-4 bg-ink/40">
          <h2 className="text-xl font-semibold text-paper">2. Private Withdraw</h2>
          <p className="text-xs text-graphite">
            Redeems 10 XLM to an unlinked recipient using a zero-knowledge membership proof.
          </p>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-graphite">Recipient Address (Fresh Key):</label>
              <button
                type="button"
                onClick={handleFundFresh}
                className="text-xs text-amber hover:underline"
              >
                + Fund Fresh via Friendbot
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
            {loading ? "Generating Proof & Verifying..." : "Withdraw Privately"}
          </Button>
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
