import { unzipSync, zipSync, strToU8, u8ToStr } from "fflate";

/**
 * Cloudflare Pages Functions + Telegram Bot
 * - Template .plp fetched from TEMPLATE_URL (GitHub raw public)
 * - Admin-only by /auth <ADMIN_CODE>
 * - Wizard via inline keyboard: count, first name mode, last name mode
 * - Generates multiple .plp files and returns outputs.zip as Telegram document
 *
 * ENV (Pages project settings):
 * - TELEGRAM_BOT_TOKEN (secret)
 * - ADMIN_CODE (secret)
 * - WEBHOOK_SECRET (secret, recommended)
 * - TEMPLATE_URL (plain var)
 *
 * KV binding name: KV
 */

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;

  // Verify Telegram secret token header (recommended)
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await request.json().catch(() => null);
  if (!update) return new Response("bad request", { status: 400 });

  waitUntil(handleUpdate(update, env));
  return new Response("OK");
}

async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  const cbq = update.callback_query;

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
    if (code && code === env.ADMIN_CODE) {
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
        firstMode: "random", // random | fixed
        fixedFirst: "",
        lastMode: "random",  // random | fixed
        fixedLast: "Ahmed",
        text2: "15/11/2025",
      },
    };
    await env.KV.put(`wiz:${userId}`, JSON.stringify(session), { expirationTtl: 1800 });
    return sendCountMenu(chatId, env);
  }

  // Wizard free-text steps
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
    const v = data.split(":")[1]; // random | fixed
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
    const v = data.split(":")[1]; // random | fixed
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

    // status message animation via edits
    const status = await tgSend(chatId, env, "⏳ Fetching template from GitHub…");
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
      await tgEdit(chatId, statusMsgId, env, `❌ Error: ${String(e.message || e)}`);
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

// -----------------------------
// Menus
// -----------------------------
function sendCountMenu(chatId, env) {
  return tgSend(chatId, env, "Choose how many files:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "10", callback_data: "count:10" }, { text: "25", callback_data: "count:25" }, { text: "50", callback_data: "count:50" }],
        [{ text: "100", callback_data: "count:100" }, { text: "Custom (1-200)", callback_data: "count:custom" }],
      ],
    },
  });
}

function sendFirstModeMenu(chatId, env) {
  return tgSend(chatId, env, "First name mode:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Random", callback_data: "first:random" }],
        [{ text: "Fixed (type)", callback_data: "first:fixed" }],
      ],
    },
  });
}

function sendLastModeMenu(chatId, env) {
  return tgSend(chatId, env, "Last name mode (surname):", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Random", callback_data: "last:random" }],
        [{ text: "Fixed (type)", callback_data: "last:fixed" }],
      ],
    },
  });
}

function sendConfirm(chatId, env, options) {
  const summary =
    `✅ Ready\n` +
    `• count: ${options.count}\n` +
    `• first: ${options.firstMode}${options.firstMode === "fixed" ? ` (${options.fixedFirst})` : ""}\n` +
    `• last: ${options.lastMode}${options.lastMode === "fixed" ? ` (${options.fixedLast})` : ""}\n` +
    `• text2: ${options.text2}\n\n` +
    `Press Generate:`;

  return tgSend(chatId, env, summary, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚀 Generate", callback_data: "do_generate" }],
        [{ text: "Cancel", callback_data: "cancel" }],
      ],
    },
  });
}

// -----------------------------
// Generation logic
// -----------------------------
const FIRST_NAMES = [
  "Ahsan","Arafat","Arif","Asif","Aziz","Fahim","Farhan","Faysal","Hasan","Imran","Ismail",
  "Jahid","Jamal","Kamal","Mahmud","Mehedi","Moin","Monir","Naim","Nayeem","Rafi","Rahim",
  "Raihan","Rashed","Rifat","Ridoy","Sabbir","Saif","Sajid","Sakib","Salman","Sami","Shafi",
  "Shahriar","Shakil","Tanvir","Tareq","Yasin","Zahid","Zubair","Nafis","Fardin","Tahmid",
  "Muntasir","Aminul","Shihab","Rakib","Shuvo","Sohel","Mahfuz","Anwar","Ruhul","Bashir",
  "Kabir","Ibrahim","Hridoy","Parvez","Sifat","Towhid","Shadman",
  "Ayesha","Farzana","Faria","Fariha","Jannat","Jui","Lamia","Maliha","Mim","Mitu","Nafisa",
  "Nusrat","Purnima","Raisa","Rima","Ritu","Sabina","Sadia","Sanjida","Shirin","Sumaiya",
  "Tahmina","Tanjila","Tania","Zannat","Jahanara","Mariya","Muna","Rukaiya","Sultana",
  "Sharmin","Sabrina","Nabila","Nowrin","Umme","Rabeya","Moushumi","Taslima","Afsana",
  "Ishika","Tanisha","Anannya","Sreya","Puja","Madhuri","Nandini","Rituparna","Oishi",
  "Anik","Aritra","Arpan","Debashish","Dip","Niloy","Pranto","Rupok","Sourav","Subrata",
  "Rony","Joy","Sohan","Ayon","Pritom","Raiyan","Sanjit"
];

const LAST_NAMES = [
  "Ahmed","Akter","Ali","Amin","Arefin","Bhuiyan","Chowdhury","Faruque","Haque","Hasan",
  "Hossain","Islam","Jahan","Khan","Mahmood","Miah","Mollah","Mostafa","Rahman",
  "Rashid","Sarker","Siddique","Sikder","Sultana","Uddin","Talukder","Sheikh","Matin",
  "Karim","Kazi","Sayeed","Nizam","Alam","Kabir","Mamun","Shah","Naser","Tasnim",
  "Das","Dey","Roy","Saha","Sarkar","Mondal","Paul","Biswas","Barman","Ghosh",
  "Chakraborty","Bhattacharya","Banerjee","Mitra","Sen","Deb","Datta","Pal","Majumder"
];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randomText1() {
  const xxx = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  const yyy = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return `451-${xxx}-${yyy}`;
}

function randomText3() {
  const n = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
  return `NSU-RCPT-${n}F`;
}

function updateIntervals(layer, newText) {
  for (const k of ["textTextColor", "textTextFont"]) {
    const block = layer[k];
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

function sanitizeFilename(name) {
  name = (name || "").trim().replace(/[\\/:*?"<>|]+/g, "");
  name = name.replace(/\s+/g, " ");
  if (!name) name = "output";
  if (name.length > 80) name = name.slice(0, 80);
  return name;
}

function titleCase(s) {
  s = (s || "").trim();
  if (!s) return "";
  return s.split(/\s+/).map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()).join(" ");
}

async function fetchTemplateBytes(env) {
  if (!env.TEMPLATE_URL) throw new Error("TEMPLATE_URL not set");
  const res = await fetch(env.TEMPLATE_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error(`Failed to fetch template: ${res.status}`);
  return await res.arrayBuffer();
}

async function generateOutputsZip(env, options, progressCb) {
  await progressCb("⏳ Downloading template (.plp) from GitHub…");
  const templateBytes = await fetchTemplateBytes(env);

  const files = unzipSync(new Uint8Array(templateBytes));
  if (!files["data.plab"]) throw new Error("Template missing data.plab");

  const baseProj = JSON.parse(u8ToStr(files["data.plab"]));
  const baseBundle = baseProj.objectsBundle || {};
  for (const k of ["text0", "text1", "text2", "text3"]) {
    if (!baseBundle[k]) throw new Error(`Template missing layer ${k}`);
  }

  const outZipEntries = {};
  const used = new Set();

  for (let i = 1; i <= options.count; i++) {
    const proj = structuredClone(baseProj);
    const b = proj.objectsBundle;

    const first = options.firstMode === "fixed" ? titleCase(options.fixedFirst) : rand(FIRST_NAMES);
    const last = options.lastMode === "fixed" ? titleCase(options.fixedLast || "Ahmed") : rand(LAST_NAMES);

    const fullName = `${first} ${last}`.trim();
    const t1 = randomText1();
    const t2 = options.text2 || "15/11/2025";
    const t3 = randomText3();

    b.text0.textTextString = fullName; updateIntervals(b.text0, fullName);
    b.text1.textTextString = t1;      updateIntervals(b.text1, t1);
    b.text2.textTextString = t2;      updateIntervals(b.text2, t2);
    b.text3.textTextString = t3;      updateIntervals(b.text3, t3);

    const outFiles = { ...files };
    outFiles["data.plab"] = strToU8(JSON.stringify(proj, null, 0));

    const plpU8 = zipSync(outFiles, { level: 6 });

    let base = sanitizeFilename(fullName);
    let fileName = `${base}.plp`;
    if (used.has(fileName)) {
      let n = 2;
      while (used.has(`${base}_${n}.plp`)) n++;
      fileName = `${base}_${n}.plp`;
    }
    used.add(fileName);

    outZipEntries[fileName] = plpU8;

    if (i === 1 || i === options.count || i % Math.max(1, Math.floor(options.count / 10)) === 0) {
      await progressCb(`✨ Generating… ${i}/${options.count}`);
    }
  }

  await progressCb("📦 Packing outputs.zip…");
  return zipSync(outZipEntries, { level: 6 });
}

// -----------------------------
// Telegram API helpers
// -----------------------------
async function tgSend(chatId, env, text, extra = {}) {
  const payload = { chat_id: chatId, text, ...extra };
  return tgCall(env, "sendMessage", payload);
}

async function tgEdit(chatId, messageId, env, text) {
  if (!messageId) return;
  return tgCall(env, "editMessageText", { chat_id: chatId, message_id: messageId, text });
}

async function tgAnswerCb(callbackQueryId, env, text) {
  return tgCall(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: false });
}

async function tgSendDocument(chatId, env, bytesU8, filename) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([bytesU8], { type: "application/zip" }), filename);

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`sendDocument failed: ${JSON.stringify(j)}`);
  return j;
}

async function tgCall(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${method} failed: ${JSON.stringify(j)}`);
  return j;
    }
