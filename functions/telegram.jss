import { unzipSync, zipSync } from "fflate";

/** ---------- Text helpers (worker-safe) ---------- */
const enc = new TextEncoder();
const dec = new TextDecoder();
const strToU8 = (s) => enc.encode(s);
const u8ToStr = (u) => dec.decode(u);

/** ---------- Worker entry (service-worker) ---------- */
addEventListener("fetch", (event) => {
  event.respondWith(router(event.request));
});

/**
 * IMPORTANT:
 * - In "service-worker" format, Wrangler/CF bindings may appear as globals.
 * - We'll always build an env object from globals so KV/vars can be used.
 */
function envFromGlobals() {
  return {
    KV: globalThis.KV,
    TELEGRAM_BOT_TOKEN: globalThis.TELEGRAM_BOT_TOKEN,
    ADMIN_CODE: globalThis.ADMIN_CODE,
    WEBHOOK_SECRET: globalThis.WEBHOOK_SECRET,
    TEMPLATE_URL: globalThis.TEMPLATE_URL,
  };
}

async function router(request) {
  const url = new URL(request.url);
  const env = envFromGlobals();

  // Quick debug endpoint (no secrets leaked)
  if (url.pathname === "/debug") {
    const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
    const template = String(env.TEMPLATE_URL || "").trim();
    return json({
      ok: true,
      hasKV: !!env.KV,
      hasToken: !!token,
      tokenLen: token.length,
      tokenStarts: token ? token.slice(0, 6) : "",
      hasAdmin: !!String(env.ADMIN_CODE || "").trim(),
      hasSecret: !!String(env.WEBHOOK_SECRET || "").trim(),
      hasTemplate: !!template,
      templateHost: template ? safeHost(template) : "",
      now: new Date().toISOString(),
    });
  }

  // For browser visits
  if (request.method === "GET") return new Response("OK");

  if (request.method !== "POST") return new Response("OK");

  // Telegram secret header verify (if configured)
  const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (String(env.WEBHOOK_SECRET || "").trim()) {
    if (!secretHeader || secretHeader !== env.WEBHOOK_SECRET) {
      console.log("DENY: bad secret header");
      return new Response("forbidden", { status: 403 });
    }
  }

  // Parse update
  const update = await request.json().catch(() => null);
  if (!update) return new Response("bad request", { status: 400 });

  try {
    await handleUpdate(update, env);
    return new Response("OK");
  } catch (e) {
    console.log("FATAL:", String(e?.stack || e?.message || e));
    return new Response("Internal Error", { status: 500 });
  }
}

function safeHost(u) {
  try { return new URL(u).host; } catch { return ""; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** ---------- Telegram Bot Logic ---------- */

async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  const cbq = update.callback_query;

  if (!env.KV) {
    // Without KV, auth flow cannot work
    console.log("KV missing - check binding name KV");
    if (msg?.chat?.id) {
      await tgSend(msg.chat.id, env, "❌ KV not bound. Please bind KV namespace as 'KV' in Worker settings.");
    }
    return;
  }

  if (cbq) return onCallback(cbq, env);
  if (!msg) return;

  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const text = msg.text || "";

  if (text.startsWith("/start")) {
    return tgSend(chatId, env, "Hi! Use /auth <admin_code> to unlock.\nThen /gen");
  }

  if (text.startsWith("/auth")) {
    const code = text.split(/\s+/)[1] || "";
    if (code && code === String(env.ADMIN_CODE || "").trim()) {
      await env.KV.put(`auth:${userId}`, "1");
      return tgSend(chatId, env, "✅ Authorized.\nUse /gen to generate.");
    }
    return tgSend(chatId, env, "❌ Wrong code.");
  }

  const authed = (await env.KV.get(`auth:${userId}`)) === "1";
  if (!authed) return tgSend(chatId, env, "🔒 Locked. Use /auth <admin_code> first.");

  if (text.startsWith("/logout")) {
    await env.KV.delete(`auth:${userId}`);
    await env.KV.delete(`wiz:${userId}`);
    return tgSend(chatId, env, "✅ Logged out.");
  }

  if (text.startsWith("/gen")) {
    const session = {
      step: "count",
      chatId,
      userId,
      options: {
        count: 10,
        firstMode: "random",
        fixedFirst: "",
        lastMode: "random",
        fixedLast: "Ahmed",
        text2: "15/11/2025",
      },
    };
    await env.KV.put(`wiz:${userId}`, JSON.stringify(session), { expirationTtl: 1800 });
    return sendCountMenu(chatId, env);
  }

  // wizard typed steps
  const wizRaw = await env.KV.get(`wiz:${userId}`);
  if (wizRaw) {
    const wiz = JSON.parse(wizRaw);

    if (wiz.step === "custom_count") {
      const n = parseInt(text.trim(), 10);
      if (!Number.isFinite(n) || n < 1 || n > 200) {
        return tgSend(chatId, env, "Enter a number between 1 and 200.");
      }
      wiz.options.count = n;
      wiz.step = "first_mode";
      await env.KV.put(`wiz:${userId}`, JSON.stringify(wiz), { expirationTtl: 1800 });
      return sendFirstModeMenu(chatId, env);
    }

    if (wiz.step === "fixed_first_input") {
      const val = text.trim();
      if (!val) return tgSend(chatId, env, "Type a first name (e.g., Ahsan).");
      wiz.options.fixedFirst = titleCase(val);
      wiz.step = "last_mode";
      await env.KV.put(`wiz:${userId}`, JSON.stringify(wiz), { expirationTtl: 1800 });
      return sendLastModeMenu(chatId, env);
    }

    if (wiz.step === "fixed_last_input") {
      const val = text.trim();
      if (!val) return tgSend(chatId, env, "Type a last name (surname) (e.g., Ahmed / Das).");
      if (val.toLowerCase() === "random") {
        wiz.options.lastMode = "random";
        wiz.step = "confirm";
        await env.KV.put(`wiz:${userId}`, JSON.stringify(wiz), { expirationTtl: 1800 });
        return sendConfirm(chatId, env, wiz.options);
      }
      wiz.options.fixedLast = titleCase(val);
      wiz.step = "confirm";
      await env.KV.put(`wiz:${userId}`, JSON.stringify(wiz), { expirationTtl: 1800 });
      return sendConfirm(chatId, env, wiz.options);
    }
  }

  return tgSend(chatId, env, "Commands:\n/auth <code>\n/gen\n/logout");
}

async function onCallback(cbq, env) {
  const data = cbq.data || "";
  const chatId = cbq.message?.chat?.id;
  const userId = cbq.from?.id;

  const authed = (await env.KV.get(`auth:${userId}`)) === "1";
  if (!authed) {
    await tgAnswerCb(cbq.id, env, "Locked.");
    return tgSend(chatId, env, "🔒 Use /auth first.");
  }

  const wizRaw = await env.KV.get(`wiz:${userId}`);
  if (!wizRaw) {
    await tgAnswerCb(cbq.id, env, "Session expired.");
    return tgSend(chatId, env, "Session expired. Send /gen again.");
  }
  const wiz = JSON.parse(wizRaw);

  if (data.startsWith("count:")) {
    const v = data.split(":")[1];
    if (v === "custom") {
      wiz.step = "custom_count";
      await env.KV.put(`wiz:${userId}`, JSON.stringify(wiz), { expirationTtl: 1800 });
      await tgAnswerCb(cbq.id, env, "OK");
      return tgSend(chatId, env, "Type a number (1-200):");
    }
    wiz.options.count = parseInt(v, 10);
    wiz.step = "first_mode";
    await env.KV.put(`wiz:${userId}`, JSON.stringify(wiz), { expirationTtl: 1800 });
    await tgAnswerCb(cbq.id, env, "OK");
    return sendFirstModeMenu(chatId, env);
  }

  if (data.startsWith("first:")) {
    const v = data.split(":")[1];
    wiz.options.firstMode = v;
    if (v === "fixed") {
      wiz.step = "fixed_first_input";
      await env.KV.put(`wiz:${userId}`, JSON.stringify(wiz), { expirationTtl: 1800 });
      await tgAnswerCb(cbq.id, env, "OK");
      return tgSend(chatId, env, "Type FIXED first name:");
    }
    wiz.step = "last_mode";
    await env.KV.put(`wiz:${userId}`, JSON.stringify(wiz), { expirationTtl: 1800 });
    await tgAnswerCb(cbq.id, env, "OK");
    return sendLastModeMenu(chatId, env);
  }

  if (data.startsWith("last:")) {
    const v = data.split(":")[1];
    wiz.options.lastMode = v;
    if (v === "fixed") {
      wiz.step = "fixed_last_input";
      await env.KV.put(`wiz:${userId}`, JSON.stringify(wiz), { expirationTtl: 1800 });
      await tgAnswerCb(cbq.id, env, "OK");
      return tgSend(chatId, env, "Type FIXED last name (surname):\n(or type 'random' to switch)");
    }
    wiz.step = "confirm";
    await env.KV.put(`wiz:${userId}`, JSON.stringify(wiz), { expirationTtl: 1800 });
    await tgAnswerCb(cbq.id, env, "OK");
    return sendConfirm(chatId, env, wiz.options);
  }

  if (data === "do_generate") {
    await tgAnswerCb(cbq.id, env, "Generating…");
    const status = await tgSend(chatId, env, "⏳ Fetching template…");
    const statusMsgId = status?.result?.message_id;

    try {
      const zipBytes = await generateOutputsZip(env, wiz.options, async (t) => {
        if (statusMsgId) await tgEdit(chatId, statusMsgId, env, t);
      });

      await tgEdit(chatId, statusMsgId, env, "📤 Uploading outputs.zip …");
      await tgSendDocument(chatId, env, zipBytes, "outputs.zip");
      await tgEdit(chatId, statusMsgId, env, "✅ Done!");
      await env.KV.delete(`wiz:${userId}`);
      return;
    } catch (e) {
      await tgEdit(chatId, statusMsgId, env, `❌ Error: ${String(e?.message || e)}`);
      return;
    }
  }

  if (data === "cancel") {
    await env.KV.delete(`wiz:${userId}`);
    await tgAnswerCb(cbq.id, env, "Cancelled");
    return tgSend(chatId, env, "Cancelled. Send /gen again anytime.");
  }

  await tgAnswerCb(cbq.id, env, "OK");
}

/** ---------- Menus ---------- */

function sendCountMenu(chatId, env) {
  return tgSend(chatId, env, "Choose how many files:", {
    reply_markup: { inline_keyboard: [
      [{ text: "10", callback_data: "count:10" }, { text: "25", callback_data: "count:25" }, { text: "50", callback_data: "count:50" }],
      [{ text: "100", callback_data: "count:100" }, { text: "Custom (1-200)", callback_data: "count:custom" }],
    ]},
  });
}
function sendFirstModeMenu(chatId, env) {
  return tgSend(chatId, env, "First name mode:", {
    reply_markup: { inline_keyboard: [
      [{ text: "Random", callback_data: "first:random" }],
      [{ text: "Fixed (type)", callback_data: "first:fixed" }],
    ]},
  });
}
function sendLastModeMenu(chatId, env) {
  return tgSend(chatId, env, "Last name mode (surname):", {
    reply_markup: { inline_keyboard: [
      [{ text: "Random", callback_data: "last:random" }],
      [{ text: "Fixed (type)", callback_data: "last:fixed" }],
    ]},
  });
}
function sendConfirm(chatId, env, options) {
  const summary =
    `✅ Ready\n• count: ${options.count}\n• first: ${options.firstMode}${options.firstMode==="fixed" ? ` (${options.fixedFirst})`:""}\n`+
    `• last: ${options.lastMode}${options.lastMode==="fixed" ? ` (${options.fixedLast})`:""}\n• text2: ${options.text2}\n\nPress Generate:`;
  return tgSend(chatId, env, summary, {
    reply_markup: { inline_keyboard: [
      [{ text: "🚀 Generate", callback_data: "do_generate" }],
      [{ text: "Cancel", callback_data: "cancel" }],
    ]},
  });
}

/** ---------- Generation ---------- */

const FIRST_NAMES = [
  "Ahsan","Arafat","Arif","Asif","Aziz","Fahim","Farhan","Hasan","Imran","Jahid","Kamal","Mahmud",
  "Mehedi","Naim","Rafi","Rahim","Rashed","Sabbir","Saif","Sajid","Sakib","Tanvir","Tareq","Yasin","Zahid",
  "Ayesha","Farzana","Lamia","Maliha","Nafisa","Nusrat","Raisa","Sabina","Sadia","Shirin","Sumaiya","Tahmina","Tania","Zannat"
];
const LAST_NAMES = [
  "Ahmed","Akter","Ali","Amin","Bhuiyan","Chowdhury","Haque","Hasan","Hossain","Islam","Jahan","Khan",
  "Miah","Mollah","Rahman","Rashid","Sarker","Siddique","Sikder","Sultana","Uddin","Das","Dey","Roy","Saha","Mondal","Paul","Biswas"
];

const rand = (a) => a[Math.floor(Math.random() * a.length)];
const randomText1 = () => `451-${String(Math.floor(Math.random()*1000)).padStart(3,"0")}-${String(Math.floor(Math.random()*1000)).padStart(3,"0")}`;
const randomText3 = () => `NSU-RCPT-${String(Math.floor(Math.random()*1000000)).padStart(6,"0")}F`;

function titleCase(s) {
  s = (s || "").trim();
  if (!s) return "";
  return s.split(/\s+/).map(x => x[0]?.toUpperCase() + x.slice(1).toLowerCase()).join(" ");
}

function sanitizeFilename(name) {
  name = (name || "").trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ");
  if (!name) name = "output";
  return name.length > 80 ? name.slice(0, 80) : name;
}

function updateIntervals(layer, newText) {
  for (const k of ["textTextColor","textTextFont"]) {
    const block = layer?.[k];
    if (block && typeof block === "object") {
      for (const intervalKey of Object.keys(block)) {
        const interval = block[intervalKey];
        if (interval && typeof interval === "object" && "textsIntervalsEnd" in interval) {
          interval.textsIntervalsEnd = newText.length;
        }
      }
    }
  }
}

async function fetchTemplateBytes(env) {
  const tpl = String(env.TEMPLATE_URL || "").trim();
  if (!tpl) throw new Error("TEMPLATE_URL not set");
  console.log("TEMPLATE_URL:", tpl);

  const res = await fetch(tpl);
  console.log("TEMPLATE_STATUS:", res.status);

  if (!res.ok) throw new Error(`Template fetch failed: ${res.status}`);
  return await res.arrayBuffer();
}

async function generateOutputsZip(env, options, progressCb) {
  await progressCb("⏳ Downloading template (.plp) …");
  const templateBytes = await fetchTemplateBytes(env);

  const files = unzipSync(new Uint8Array(templateBytes));
  if (!files["data.plab"]) throw new Error("Template missing data.plab");

  const baseProj = JSON.parse(u8ToStr(files["data.plab"]));
  for (const k of ["text0","text1","text2","text3"]) {
    if (!baseProj.objectsBundle?.[k]) throw new Error(`Template missing layer ${k}`);
  }

  const out = {};
  const used = new Set();

  for (let i=1; i<=options.count; i++) {
    const proj = structuredClone(baseProj);
    const b = proj.objectsBundle;

    const first = options.firstMode==="fixed" ? titleCase(options.fixedFirst) : rand(FIRST_NAMES);
    const last  = options.lastMode==="fixed" ? titleCase(options.fixedLast||"Ahmed") : rand(LAST_NAMES);

    const fullName = `${first} ${last}`.trim();
    const t1 = randomText1();
    const t2 = options.text2 || "15/11/2025";
    const t3 = randomText3();

    b.text0.textTextString = fullName; updateIntervals(b.text0, fullName);
    b.text1.textTextString = t1;      updateIntervals(b.text1, t1);
    b.text2.textTextString = t2;      updateIntervals(b.text2, t2);
    b.text3.textTextString = t3;      updateIntervals(b.text3, t3);

    const outFiles = { ...files, ["data.plab"]: strToU8(JSON.stringify(proj)) };
    const plpU8 = zipSync(outFiles, { level: 6 });

    let base = sanitizeFilename(fullName);
    let fileName = `${base}.plp`;
    if (used.has(fileName)) {
      let n=2; while (used.has(`${base}_${n}.plp`)) n++;
      fileName = `${base}_${n}.plp`;
    }
    used.add(fileName);
    out[fileName] = plpU8;

    if (i===1 || i===options.count || i % Math.max(1, Math.floor(options.count/10))===0) {
      await progressCb(`✨ Generating… ${i}/${options.count}`);
    }
  }

  await progressCb("📦 Packing outputs.zip…");
  return zipSync(out, { level: 6 });
}

/** ---------- Telegram API helpers (with BUG logs) ---------- */

async function tgCall(env, method, payload) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");

  method = String(method || "").trim().replace(/^\/+/, "");
  if (!method) throw new Error("Telegram method missing");

  const url = `https://api.telegram.org/bot${token}/${method}`;

  // BUG logs (token masked)
  console.log("TG_URL:", url.replace(token, token.slice(0, 6) + "…"));

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });

  const body = await res.text();
  console.log("TG_STATUS:", res.status);
  console.log("TG_BODY:", body);

  let data;
  try { data = JSON.parse(body); } catch { data = { ok: false, raw: body }; }

  if (!res.ok || !data.ok) {
    throw new Error(`${method} failed: ${body}`);
  }
  return data;
}

const tgSend = (chat_id, env, text, extra={}) => tgCall(env, "sendMessage", { chat_id, text, ...extra });
const tgEdit = (chat_id, message_id, env, text) => tgCall(env, "editMessageText", { chat_id, message_id, text });
const tgAnswerCb = (id, env, text) => tgCall(env, "answerCallbackQuery", { callback_query_id: id, text, show_alert: false });

async function tgSendDocument(chatId, env, bytesU8, filename) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");

  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  console.log("TG_DOC_URL:", url.replace(token, token.slice(0, 6) + "…"));

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([bytesU8], { type: "application/zip" }), filename);

  const res = await fetch(url, { method: "POST", body: form });
  const body = await res.text();
  console.log("TG_DOC_STATUS:", res.status);
  console.log("TG_DOC_BODY:", body);

  let data;
  try { data = JSON.parse(body); } catch { data = { ok: false, raw: body }; }
  if (!res.ok || !data.ok) throw new Error(`sendDocument failed: ${body}`);
  return data;
    }
