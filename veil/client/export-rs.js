// Genera contracts/veil_pool/src/vk.rs (constantes de la VK) y src/test_fixture.rs (prueba real).
const fs = require("fs"), path = require("path");
const { be32, g1, g2 } = require("./encode");
const B = path.join(__dirname, "../circuits/build"), S = path.join(__dirname, "../contracts/veil_pool/src");
const rd = (f) => JSON.parse(fs.readFileSync(path.join(B, f), "utf8"));
const vk = rd("verification_key.json"), proof = rd("proof.json"), pub = rd("public.json"), fx = rd("fixture.json");
const arr = (b) => `[${[...b].join(",")}]`;
fs.writeFileSync(path.join(S, "vk.rs"), `// GENERADO por client/export-rs.js desde verification_key.json. No editar.
pub const ALPHA: [u8; 64] = ${arr(g1(vk.vk_alpha_1))};
pub const BETA: [u8; 128] = ${arr(g2(vk.vk_beta_2))};
pub const GAMMA: [u8; 128] = ${arr(g2(vk.vk_gamma_2))};
pub const DELTA: [u8; 128] = ${arr(g2(vk.vk_delta_2))};
pub const IC: [[u8; 64]; ${vk.IC.length}] = [${vk.IC.map((p) => arr(g1(p))).join(",\n")}];
`);
fs.writeFileSync(path.join(S, "test_fixture.rs"), `// GENERADO por client/export-rs.js desde proof.json/public.json/fixture.json. No editar.
pub const PROOF_A: [u8; 64] = ${arr(g1(proof.pi_a))};
pub const PROOF_B: [u8; 128] = ${arr(g2(proof.pi_b))};
pub const PROOF_C: [u8; 64] = ${arr(g1(proof.pi_c))};
pub const PUB: [[u8; 32]; ${pub.length}] = [${pub.map((x) => arr(be32(x))).join(",\n")}];
pub const LEAVES: [[u8; 32]; ${fx.leaves.length}] = [${fx.leaves.map((x) => arr(be32(x))).join(",\n")}];
pub const RECIPIENT: &str = "${fx.recipient}";
`);
console.log("wrote vk.rs (IC =", vk.IC.length, ") and test_fixture.rs");
