export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // Routing
      if (method === "GET" && path === "/vip") {
        return getAllVip(env);
      }

      if (method === "GET" && path.startsWith("/vip/")) {
        const userId = decodeURIComponent(path.split("/")[2] || "");
        return getOneVip(env, userId);
      }

      if (method === "POST" && path === "/vip") {
        return addVip(request, env);
      }

      if (method === "DELETE" && path.startsWith("/vip/")) {
        const userId = decodeURIComponent(path.split("/")[2] || "");
        return deleteVip(request, env, userId);
      }

      return new Response(
        JSON.stringify({ error: "Not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Server error", message: String(e) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};

// ---------- Helper functions ----------

const DATA_KEY = "vip.json";

async function loadData(env) {
  const raw = await env.VIP_STORE.get(DATA_KEY);
  if (!raw) {
    // default value
    return { vip_users: [] };
  }
  try {
    return JSON.parse(raw);
  } catch {
    // corrupted ဖြစ်ရင်လည်း fallback
    return { vip_users: [] };
  }
}

async function saveData(env, data) {
  await env.VIP_STORE.put(DATA_KEY, JSON.stringify(data, null, 2));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function checkAdmin(request, env) {
  const adminHeader = request.headers.get("X-Admin-Code");
  if (adminHeader !== env.ADMIN_CODE) {
    throw new Response(
      JSON.stringify({ error: "Forbidden", message: "Invalid admin code" }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// ---------- Handlers ----------

// GET /vip  (public)
async function getAllVip(env) {
  const data = await loadData(env);
  return jsonResponse(data);
}

// GET /vip/:id  (public)
async function getOneVip(env, userId) {
  if (!userId) {
    return jsonResponse({ error: "User id required" }, 400);
  }

  const data = await loadData(env);
  const user = (data.vip_users || []).find((u) => u.id === userId);

  if (!user) {
    return jsonResponse({ error: "User not found" }, 404);
  }

  return jsonResponse(user);
}

// POST /vip  (admin only)
async function addVip(request, env) {
  // admin check
  checkAdmin(request, env);

  const body = await request.json().catch(() => null);

  if (!body || !body.id || !body.month || !body.start_date) {
    return jsonResponse(
      { error: "id, month, start_date are required" },
      400
    );
  }

  const data = await loadData(env);

  // id duplicated check
  const exists = (data.vip_users || []).some((u) => u.id === body.id);
  if (exists) {
    return jsonResponse({ error: "User id already exists" }, 400);
  }

  data.vip_users.push({
    id: String(body.id),
    month: String(body.month),
    start_date: String(body.start_date),
  });

  await saveData(env, data);

  return jsonResponse(data, 201);
}

// DELETE /vip/:id  (admin only)
async function deleteVip(request, env, userId) {
  // admin check
  checkAdmin(request, env);

  if (!userId) {
    return jsonResponse({ error: "User id required" }, 400);
  }

  const data = await loadData(env);
  const before = data.vip_users.length;
  data.vip_users = data.vip_users.filter((u) => u.id !== userId);

  if (data.vip_users.length === before) {
    return jsonResponse({ error: "User not found" }, 404);
  }

  await saveData(env, data);
  return jsonResponse(data);
}
