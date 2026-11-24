// Έλεγχος ειδοποιήσεων Crypto Tracker (τρέχει σε GitHub Actions, Node 20+).
// Διαβάζει alerts-config.json (εξαγωγή από την εφαρμογή) και στέλνει push μέσω ntfy.sh.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const CONFIG = process.env.ALERTS_CONFIG || "alerts-config.json";
const STATE = process.env.ALERTS_STATE || "state/alert-state.json";
const NTFY_TOPIC = process.env.NTFY_TOPIC || ""; // προαιρετικά από GitHub Secret (υπερισχύει του αρχείου)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "", TG_CHAT = process.env.TELEGRAM_CHAT_ID || ""; // προαιρετικά, από GitHub Secrets
const TF_MIN = { "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };
const KRAKEN = "https://api.kraken.com/0/public";
const BINANCE = "https://data-api.binance.vision/api/v3"; // δημόσια δεδομένα· το api.binance.com μπλοκάρει IP των ΗΠΑ

const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
const topic = (NTFY_TOPIC || cfg.ntfy || "").replace(/[^\w-]/g, "");
let state = {};
try { if (existsSync(STATE)) state = JSON.parse(readFileSync(STATE, "utf8")); } catch {}

/* ---------- δείκτες (ίδιοι με την εφαρμογή) ---------- */
const sma = (v, p) => v.map((_, i) => i < p - 1 ? null : v.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p);
function ema(v, p, start = 0) {
  const out = new Array(v.length).fill(null), k = 2 / (p + 1);
  if (v.length < start + p) return out;
  let e = v.slice(start, start + p).reduce((a, b) => a + b, 0) / p;
  out[start + p - 1] = e;
  for (let i = start + p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function rsi(c, p = 14) {
  const out = new Array(c.length).fill(null);
  if (c.length <= p) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; d >= 0 ? g += d : l -= d; }
  g /= p; l /= p;
  const f = (g, l) => l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  out[p] = f(g, l);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p; l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = f(g, l);
  }
  return out;
}
function macdHist(c) {
  const ef = ema(c, 12), es = ema(c, 26);
  const m = c.map((_, i) => ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null);
  const first = m.findIndex(v => v !== null);
  const sig = first < 0 ? m.map(() => null) : ema(m.map(v => v === null ? 0 : v), 9, first);
  return m.map((v, i) => v !== null && sig[i] !== null ? v - sig[i] : null);
}
function bands(c) {
  const out = new Array(c.length).fill(null);
  for (let i = 19; i < c.length; i++) {
    const w = c.slice(i - 19, i + 1), mean = w.reduce((a, b) => a + b, 0) / 20;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
    out[i] = { lo: mean - 2 * sd, up: mean + 2 * sd };
  }
  return out;
}

/* ---------- δεδομένα ---------- */
async function getJson(url) {
  const r = await fetch(url, { headers: { "user-agent": "crypto-tracker-alerts" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}
async function price(rule) {
  if (rule.cur === "eur" && rule.kraken) {
    const r = await getJson(`${KRAKEN}/Ticker?pair=${rule.kraken}`);
    return parseFloat(r.result[Object.keys(r.result)[0]].c[0]);
  }
  if (rule.binance) return parseFloat((await getJson(`${BINANCE}/ticker/price?symbol=${rule.binance}`)).price);
  throw new Error("δεν υπάρχει πηγή τιμής για " + rule.coin);
}
const cache = {};
async function candles(rule, tf) {
  const key = `${rule.coin}|${tf}|${rule.cur}`;
  if (cache[key]) return cache[key];
  let rows;
  if (rule.cur === "eur" && rule.kraken) {
    const since = Math.floor(Date.now() / 1000) - 300 * TF_MIN[tf] * 60;
    const r = await getJson(`${KRAKEN}/OHLC?pair=${rule.kraken}&interval=${TF_MIN[tf]}&since=${since}`);
    const k = Object.keys(r.result).find(x => x !== "last");
    rows = r.result[k].map(x => [x[0] * 1000, +x[1], +x[2], +x[3], +x[4]]);
  } else if (rule.binance) {
    const r = await getJson(`${BINANCE}/klines?symbol=${rule.binance}&interval=${tf}&limit=300`);
    rows = r.map(k => [k[0], +k[1], +k[2], +k[3], +k[4]]);
  } else throw new Error("δεν υπάρχει πηγή κεριών για " + rule.coin);
  return (cache[key] = rows);
}

/* ---------- κανόνες ---------- */
const TECH = {
  rsi_os: "buy", rsi_ob: "sell", macd_up: "buy", macd_dn: "sell",
  bb_lo: "buy", bb_up: "sell", ema_up: "buy", ema_dn: "sell"
};
function techCheck(kind, all) {
  const cs = all.slice(0, -1); // μόνο κλειστά κεριά
  const n = cs.length;
  if (n < 60) return null;
  const c = cs.map(x => x[4]), at = cs[n - 1][0];
  const hit = (msg) => ({ at, msg });
  if (kind === "rsi_os" || kind === "rsi_ob") {
    const r = rsi(c), a = r[n - 2], b = r[n - 1];
    if (a === null || b === null) return null;
    if (kind === "rsi_os" && a >= 30 && b < 30) return hit(`RSI έπεσε κάτω από 30 (${b.toFixed(1)})`);
    if (kind === "rsi_ob" && a <= 70 && b > 70) return hit(`RSI ανέβηκε πάνω από 70 (${b.toFixed(1)})`);
  } else if (kind === "macd_up" || kind === "macd_dn") {
    const h = macdHist(c), a = h[n - 2], b = h[n - 1];
    if (a === null || b === null) return null;
    if (kind === "macd_up" && a <= 0 && b > 0) return hit("η MACD διέσχισε προς τα πάνω τη γραμμή σήματος");
    if (kind === "macd_dn" && a >= 0 && b < 0) return hit("η MACD διέσχισε προς τα κάτω τη γραμμή σήματος");
  } else if (kind === "bb_lo" || kind === "bb_up") {
    const bb = bands(c), l = bb[n - 1], p = bb[n - 2];
    if (!l || !p) return null;
    if (kind === "bb_lo" && c[n - 1] < l.lo && c[n - 2] >= p.lo) return hit("κλείσιμο κάτω από την κάτω μπάντα Bollinger");
    if (kind === "bb_up" && c[n - 1] > l.up && c[n - 2] <= p.up) return hit("κλείσιμο πάνω από την πάνω μπάντα Bollinger");
  } else if (kind === "ema_up" || kind === "ema_dn") {
    const e20 = ema(c, 20), e50 = ema(c, 50);
    const a = e20[n - 2] - e50[n - 2], b = e20[n - 1] - e50[n - 1];
    if (!isFinite(a) || !isFinite(b)) return null;
    if (kind === "ema_up" && a <= 0 && b > 0) return hit("ο EMA 20 διέσχισε προς τα πάνω τον EMA 50");
    if (kind === "ema_dn" && a >= 0 && b < 0) return hit("ο EMA 20 διέσχισε προς τα κάτω τον EMA 50");
  }
  return null;
}
const sym = (r) => r.sym || r.coin.toUpperCase();
const num = (v) => v >= 100 ? v.toLocaleString("el-GR", { maximumFractionDigits: 2 }) : v >= 1 ? v.toFixed(3) : v.toPrecision(3);
const cur = (r) => r.cur === "usd" ? "$" : "€";

async function notify(title, message, side) {
  console.log("ΕΙΔΟΠΟΙΗΣΗ:", title, "—", message);
  if (TG_TOKEN && TG_CHAT) {
    try {
      const tr = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT, text: (side === "sell" ? "🔴 " : "🟢 ") + title + "\n" + message, disable_web_page_preview: true })
      });
      if (!tr.ok) console.error("Telegram HTTP", tr.status);
    } catch (e) { console.error("Telegram:", e.message); }
  }
  if (!topic) { if (!(TG_TOKEN && TG_CHAT)) console.log("(δεν έχει οριστεί ούτε ntfy ούτε Telegram — δεν στάλθηκε push)"); return; }
  const r = await fetch("https://ntfy.sh/", {
    method: "POST",
    body: JSON.stringify({ topic, title, message, priority: 4, tags: [side === "sell" ? "chart_with_downwards_trend" : "chart_with_upwards_trend"] })
  });
  if (!r.ok) console.error("ntfy HTTP", r.status);
}

let failures = 0;
for (const r of (cfg.rules || []).filter(x => x.on)) {
  const st = state[r.id] || (state[r.id] = {});
  try {
    if (r.type === "price") {
      const p = await price(r);
      const crossed = r.dir === "below" ? p <= r.value : p >= r.value;
      if (crossed && st.armed !== false) {
        st.armed = false;
        await notify(`${sym(r)} ${r.dir === "below" ? "κάτω από" : "πάνω από"} ${cur(r)}${num(r.value)}`, `${r.name || r.coin}: τρέχουσα τιμή ${cur(r)}${num(p)}.`, r.dir === "below" ? "buy" : "sell");
      } else if (!crossed && st.armed === false && (r.dir === "below" ? p > r.value * 1.01 : p < r.value * 0.99)) st.armed = true;
    } else if (r.type === "drop" || r.type === "rise") {
      const cs = await candles(r, "1h");
      const last = cs[cs.length - 1][4], ref = cs.length > 25 ? cs[cs.length - 25][4] : cs[0][4];
      const ch = (last - ref) / ref * 100;
      const now = r.type === "drop" ? ch <= -r.value : ch >= r.value;
      if (now && st.armed !== false) {
        st.armed = false;
        await notify(`${sym(r)} ${r.type === "drop" ? "πτώση" : "άνοδος"} ${ch.toFixed(1)}% σε 24ω`, `${r.name || r.coin}: τιμή ${cur(r)}${num(last)}.`, r.type === "drop" ? "sell" : "buy");
      } else if (!now && st.armed === false && Math.abs(ch) < r.value * 0.6) st.armed = true;
    } else if (r.type === "tech") {
      const res = techCheck(r.kind, await candles(r, r.tf));
      if (res && st.last !== res.at) {
        st.last = res.at;
        const side = TECH[r.kind];
        await notify(`${sym(r)} ${r.tf}: ${side === "buy" ? "πιθανό σήμα αγοράς" : "πιθανό σήμα πώλησης"}`, `${r.name || r.coin} — ${res.msg}. Ενδεικτικό σήμα, όχι επενδυτική συμβουλή.`, side);
      }
    }
  } catch (e) { failures++; console.error(`Κανόνας ${r.id} (${r.coin}):`, e.message); }
}
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
mkdirSync(dirname(STATE), { recursive: true });
writeFileSync(STATE, JSON.stringify(state, null, 1));
console.log(`Έλεγχος ολοκληρώθηκε: ${(cfg.rules || []).filter(x => x.on).length} κανόνες, ${failures} σφάλματα.`);
if (failures && failures === (cfg.rules || []).filter(x => x.on).length) process.exit(1);
