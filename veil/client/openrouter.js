// Paso de IA del flujo de pago (requisito del hackathon): antes de cada retiro, un modelo vía OpenRouter
// evalúa el riesgo de vinculación (tamaño del anonymity set, timing) y lo deja en el log.
// La key nunca va al frontend. Sin OPENROUTER_API_KEY devuelve un stub, igual que el starter.
const fs = require("fs"), path = require("path");

// .env mínimo (sin dependencia): KEY=VALUE por línea en la raíz del repo.
(function loadEnv() {
  const p = path.join(__dirname, "../.env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4.1-nano";
const MAX_TOKENS = Number(process.env.OPENROUTER_MAX_TOKENS || 200);

async function chat(prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  console.error(`[openrouter] model=${MODEL} max_tokens=${MAX_TOKENS} prompt_chars=${prompt.length}`);
  if (!key) {
    console.error("[openrouter] sin OPENROUTER_API_KEY: stub (pon la key en .env para la llamada real)");
    return { id: "stub", model: MODEL, text: "(stub) sin OPENROUTER_API_KEY" };
  }
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      "HTTP-Referer": "https://veil.agentposhq.com", "X-Title": "Veil privacy pool" },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content ?? "";
  console.error(`[openrouter] ok id=${j.id} tokens=${j.usage?.total_tokens ?? "?"}`);
  return { id: j.id, model: j.model, text, usage: j.usage };
}

/** Evalúa el riesgo de des-anonimización de un retiro. No recibe la nota ni el commitment. */
async function privacyAdvisor({ deposits, leafIndex, minutesSinceDeposit }) {
  const prompt = `Eres el asesor de privacidad de un privacy pool estilo Tornado en Stellar testnet (depósitos fijos de 10 XLM).
Datos del retiro que se va a ejecutar:
- Depósitos totales en el pool (anonymity set): ${deposits}
- Posición del depósito que se retira: ${leafIndex + 1} de ${deposits}
- Minutos desde ese depósito: ${minutesSinceDeposit ?? "desconocido"}
Responde en español, máximo 3 frases: nivel de riesgo de vinculación (bajo/medio/alto), por qué, y una recomendación concreta (esperar más depósitos, esperar tiempo, o proceder).`;
  const r = await chat(prompt);
  return r.text.trim();
}

module.exports = { chat, privacyAdvisor, MODEL };
