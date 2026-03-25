const TelegramBot = require("node-telegram-bot-api");
const http = require("http");

// ════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "admin123"; // Set this in your env!

if (!TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN in the environment.");
  process.exit(1);
}

/** Vercel sets VERCEL=1 — use webhooks there; local dev uses polling */
const useWebhook = Boolean(process.env.VERCEL);
const RESTAURANT = "🍽️ Foodie Palace";
const CURRENCY = "₹";

// ════════════════════════════════════════════════════
//  AUTO PROGRESSION TIMINGS (in seconds)
// ════════════════════════════════════════════════════
const STAGE_DURATIONS = {
  confirmed: 30,
  preparing: 30,
  picked_up: 30,
  nearby: 30,
  delivered: null,
};

// ════════════════════════════════════════════════════
//  MENU
// ════════════════════════════════════════════════════
const MENU = {
  Starters: {
    "🥗 Caesar Salad": { price: 99, desc: "Fresh romaine, croutons, parmesan" },
    "🥣 Tomato Soup": { price: 79, desc: "Creamy homestyle tomato soup" },
  },
  "Main Course": {
    "🍕 Pizza Margherita": { price: 199, desc: "Classic tomato, mozzarella, basil" },
    "🍔 Chicken Burger": { price: 149, desc: "Grilled chicken, lettuce, cheese" },
    "🍜 Veg Noodles": { price: 129, desc: "Stir-fried veggies, soy sauce" },
  },
  Drinks: {
    "🧃 Fresh Juice": { price: 59, desc: "Orange / Mango / Pineapple" },
    "☕ Masala Chai": { price: 29, desc: "Spiced Indian tea" },
  },
};

// ════════════════════════════════════════════════════
//  DELIVERY STAGES
// ════════════════════════════════════════════════════
const STAGES = {
  confirmed: { icon: "✅", label: "Order Confirmed", eta: "~30 min" },
  preparing: { icon: "👨‍🍳", label: "Being Prepared in Kitchen", eta: "~20 min" },
  picked_up: { icon: "🛵", label: "Out for Delivery", eta: "~10 min" },
  nearby: { icon: "📍", label: "Delivery Boy Nearby", eta: "~3 min" },
  delivered: { icon: "🎉", label: "Delivered! Enjoy your meal", eta: "—" },
};
const STAGE_KEYS = Object.keys(STAGES);

// ════════════════════════════════════════════════════
//  RUNTIME STATE
// ════════════════════════════════════════════════════
const orders = {};   // keyed by customer chatId
const session = {};  // keyed by customer chatId

/**
 * ownerRegistry: maps ownerChatId (string) → { name, registeredAt }
 * Multiple people can register as owners independently.
 * Each owner receives alerts for ALL orders placed while they are registered.
 */
const ownerRegistry = {};

// ════════════════════════════════════════════════════
//  BOT INIT
// ════════════════════════════════════════════════════
const bot = new TelegramBot(TOKEN, useWebhook ? {} : { polling: true });

// ════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════
function getOwnerIds() {
  return Object.keys(ownerRegistry);
}

function isOwner(chatId) {
  return Boolean(ownerRegistry[String(chatId)]);
}

function notifyAllOwners(text, extra = {}) {
  for (const ownerId of getOwnerIds()) {
    send(ownerId, text, extra).catch(() => {});
  }
}

function notifyAllOwnerLocation(lat, lng) {
  for (const ownerId of getOwnerIds()) {
    bot.sendLocation(ownerId, lat, lng).catch(() => {});
  }
}

function ensureSession(cid) {
  if (!session[cid]) session[cid] = { cart: {} };
  if (!session[cid].cart) session[cid].cart = {};
}

function orderId(chatId) {
  return `ORD${String(chatId).slice(-4)}${Date.now().toString().slice(-4)}`;
}

function progressBar(status) {
  const idx = STAGE_KEYS.indexOf(status);
  return STAGE_KEYS.map((_, i) => (i <= idx ? "🟢" : "⚪")).join("");
}

function findPrice(name) {
  for (const cat of Object.values(MENU)) {
    if (cat[name]) return cat[name].price;
  }
  return 0;
}

function formatCart(cart) {
  let text = "", total = 0;
  for (const [item, qty] of Object.entries(cart)) {
    const price = findPrice(item);
    text += `  • ${item} × ${qty} — ${CURRENCY}${price * qty}\n`;
    total += price * qty;
  }
  return { text, total };
}

function homeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🍽️ View Menu", callback_data: "show_categories" }],
      [{ text: "📦 Track My Order", callback_data: "order_status" }],
      [{ text: "📞 Contact Us", callback_data: "contact" }],
    ],
  };
}

function send(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...extra });
}

// ════════════════════════════════════════════════════
//  BUILD LIVE STATUS MESSAGE
// ════════════════════════════════════════════════════
function buildLiveStatus(order) {
  const stage = STAGES[order.status];
  const { text, total } = formatCart(order.cart);
  const locLine = order.location
    ? `🗺️ [View on Maps](https://maps.google.com/?q=${order.location.latitude},${order.location.longitude})\n`
    : "";

  let countdownLine = "";
  if (order.status !== "delivered" && order.secondsLeft != null) {
    const m = Math.floor(order.secondsLeft / 60);
    const s = order.secondsLeft % 60;
    countdownLine = m > 0
      ? `⏳ *Next stage in:* ${m}m ${s}s\n`
      : `⏳ *Next stage in:* ${s}s\n`;
  }

  return (
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `📦 *LIVE ORDER STATUS*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🆔 *Order ID:* \`${order.id}\`\n` +
    `⏱️ *Placed at:* ${order.time}\n\n` +
    `*Items:*\n${text}\n` +
    `💰 *Total: ${CURRENCY}${total}* (Cash on Delivery)\n` +
    `${locLine}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Delivery Progress:*\n` +
    `${progressBar(order.status)}\n\n` +
    `${stage.icon} *${stage.label}*\n` +
    `⏱️ *ETA:* ${stage.eta}\n\n` +
    `${countdownLine}` +
    `━━━━━━━━━━━━━━━━━━━━━`
  );
}

// ════════════════════════════════════════════════════
//  AUTO PROGRESSION ENGINE
// ════════════════════════════════════════════════════
function startAutoProgression(chatId) {
  const order = orders[chatId];
  if (!order) return;

  if (order.autoInterval) {
    clearInterval(order.autoInterval);
    order.autoInterval = null;
  }

  order.secondsLeft = STAGE_DURATIONS[order.status] || 30;

  send(chatId, buildLiveStatus(order), {
    reply_markup: {
      inline_keyboard: [[{ text: "🏠 Home", callback_data: "home" }]],
    },
  }).then((sentMsg) => {
    order.liveMessageId = sentMsg.message_id;

    const interval = setInterval(async () => {
      const o = orders[chatId];
      if (!o) { clearInterval(interval); return; }

      o.secondsLeft -= 10;

      if (o.secondsLeft <= 0) {
        const nextIdx = STAGE_KEYS.indexOf(o.status) + 1;
        const nextStatus = STAGE_KEYS[nextIdx];

        if (!nextStatus) { clearInterval(interval); o.autoInterval = null; return; }

        o.status = nextStatus;
        o.secondsLeft = STAGE_DURATIONS[nextStatus] || 30;

        const isDelivered = nextStatus === "delivered";
        bot.editMessageText(buildLiveStatus(o), {
          chat_id: chatId,
          message_id: o.liveMessageId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: isDelivered
              ? [
                  [{ text: "🍽️ Order Again", callback_data: "show_categories" }],
                  [{ text: "🏠 Home", callback_data: "home" }],
                ]
              : [[{ text: "🏠 Home", callback_data: "home" }]],
          },
        }).catch(() => {});

        if (nextStatus === "picked_up") {
          send(chatId,
            `🛵 *Out for Delivery!*\n\n` +
            `${progressBar("picked_up")}\n\n` +
            `Delivery boy has picked up your order!\n` +
            `He's heading to you now 🔥`
          );
        } else if (nextStatus === "nearby") {
          send(chatId,
            `📍 *Delivery Boy is Nearby!*\n\n` +
            `${progressBar("nearby")}\n\n` +
            `He's just around the corner!\n` +
            `💵 Please keep *${CURRENCY}${o.total}* ready!`
          );
        } else if (nextStatus === "delivered") {
          clearInterval(interval);
          o.autoInterval = null;

          send(chatId,
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `🎉 *ORDER DELIVERED!*\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Thank you for ordering from *${RESTAURANT}*! 😊\n\n` +
            `💵 Please pay *${CURRENCY}${o.total}* to the delivery boy.\n\n` +
            `⭐ Enjoy your meal! Come back soon 🙏`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🍽️ Order Again", callback_data: "show_categories" }],
                  [{ text: "🏠 Home", callback_data: "home" }],
                ],
              },
            }
          );

          notifyAllOwners(`✅ *Delivered!*\n🆔 \`${o.id}\` | 💰 ${CURRENCY}${o.total}`);
        }
      } else {
        bot.editMessageText(buildLiveStatus(o), {
          chat_id: chatId,
          message_id: o.liveMessageId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🏠 Home", callback_data: "home" }]],
          },
        }).catch(() => {});
      }
    }, 10000);

    order.autoInterval = interval;
  });
}

// ════════════════════════════════════════════════════
//  CONFIRM ORDER
// ════════════════════════════════════════════════════
function confirmOrder(chatId, fromMsg) {
  ensureSession(chatId);
  const cart = session[chatId]?.cart || {};
  if (Object.keys(cart).length === 0) {
    return send(chatId, `❌ *Cart is empty!* Add items first.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🍽️ Browse Menu", callback_data: "show_categories" }],
        ],
      },
    });
  }

  const { text, total } = formatCart(cart);
  const id = orderId(chatId);
  const time = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const location = session[chatId]?.location || null;

  orders[chatId] = {
    id, cart, total,
    status: "confirmed",
    time, location,
    liveMessageId: null,
    autoInterval: null,
    secondsLeft: null,
  };
  session[chatId] = { cart: {} };

  const locLine = location ? `📍 *Location:* ✅ Shared` : `📍 *Location:* Not shared`;

  send(chatId,
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ *ORDER CONFIRMED!*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🆔 *Order ID:* \`${id}\`\n` +
    `⏱️ *Time:* ${time}\n\n` +
    `*Items Ordered:*\n${text}\n` +
    `💰 *Total: ${CURRENCY}${total}* (Cash on Delivery)\n` +
    `${locLine}\n\n` +
    `👨‍🍳 Your food is being prepared!\n` +
    `🔔 Live status updates appear below 👇`,
    { reply_markup: { remove_keyboard: true } }
  );

  // ── Notify ALL registered owners ──
  const ownerCount = getOwnerIds().length;
  if (ownerCount === 0) {
    console.log(`⚠️  New order ${id} but no owners registered!`);
  }

  const mapsLine = location
    ? `\n🗺️ [Location](https://maps.google.com/?q=${location.latitude},${location.longitude})`
    : `\n📍 No location`;

  notifyAllOwners(
    `🔔 *NEW ORDER!*\n\n` +
    `🆔 \`${id}\`\n` +
    `👤 ${fromMsg?.first_name || ""} ${fromMsg?.last_name || ""} (\`${chatId}\`)\n` +
    `⏱️ ${time}\n\n` +
    `*Items:*\n${text}\n` +
    `💰 *${CURRENCY}${total}* COD` +
    `${mapsLine}`
  );

  if (location) notifyAllOwnerLocation(location.latitude, location.longitude);

  setTimeout(() => startAutoProgression(chatId), 1500);
}

// ════════════════════════════════════════════════════
//  ASK LOCATION
// ════════════════════════════════════════════════════
function askLiveLocation(chatId) {
  session[chatId].step = "awaiting_location";
  bot.sendMessage(chatId,
    `📍 *Share Your Location*\n\n` +
    `Help our delivery boy find you faster!\n\n` +
    `👇 Tap *"Share My Location"* below\n` +
    `_(or "Skip" to proceed without it)_`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [
          [{ text: "📍 Share My Location", request_location: true }],
          [{ text: "⏭️ Skip" }],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }
  );
}

// ════════════════════════════════════════════════════
//  LOCATION HANDLER
// ════════════════════════════════════════════════════
bot.on("location", (msg) => {
  const chatId = msg.chat.id;
  ensureSession(chatId);
  const { latitude, longitude } = msg.location;
  const isLive = msg.location.live_period != null;

  if (session[chatId]?.step !== "awaiting_location") {
    if (orders[chatId] && isLive) {
      orders[chatId].location = { latitude, longitude };
      notifyAllOwners(
        `📡 *Live Location Update*\n👤 \`${chatId}\`\n[Maps](https://maps.google.com/?q=${latitude},${longitude})`
      );
    }
    return;
  }

  session[chatId].step = "done";
  session[chatId].location = { latitude, longitude };

  notifyAllOwners(
    `📍 *Location Received*\n` +
    `👤 ${msg.from.first_name} | \`${chatId}\` | ${isLive ? "📡 Live" : "📍 Pinned"}`
  );
  notifyAllOwnerLocation(latitude, longitude);

  bot.sendMessage(chatId, `✅ *Location received!*`, {
    parse_mode: "Markdown",
    reply_markup: { remove_keyboard: true },
  }).then(() => setTimeout(() => confirmOrder(chatId, msg.from), 500));
});

// ════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ════════════════════════════════════════════════════
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  ensureSession(chatId);
  if (!msg.text || msg.text.startsWith("/")) return;

  const text = msg.text.trim();

  if (text === "⏭️ Skip" && session[chatId]?.step === "awaiting_location") {
    session[chatId].step = "done";
    session[chatId].location = null;
    bot.sendMessage(chatId, `⏭️ *Location skipped.*`, {
      parse_mode: "Markdown",
      reply_markup: { remove_keyboard: true },
    }).then(() => setTimeout(() => confirmOrder(chatId, msg.from), 400));
    return;
  }

  if (!session[chatId]?.step || session[chatId]?.step === "done") {
    send(chatId, `👋 Use the menu to get started!`, { reply_markup: homeKeyboard() });
  }
});

// ════════════════════════════════════════════════════
//  /start
// ════════════════════════════════════════════════════
bot.onText(/\/start/, (msg) => {
  session[msg.chat.id] = { cart: {} };
  send(
    msg.chat.id,
    `👋 Welcome to *${RESTAURANT}*, ${msg.from.first_name || "there"}!\n\n` +
    `🍕 Fresh food  •  🚀 Fast delivery  •  💵 COD\n\n` +
    `What would you like to do?`,
    { reply_markup: homeKeyboard() }
  );
});

// ════════════════════════════════════════════════════
//  /setowner <password>  — Register yourself as owner
//  Usage: /setowner admin123
// ════════════════════════════════════════════════════
bot.onText(/\/setowner(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const password = (match[1] || "").trim();

  if (!password) {
    return send(chatId,
      `🔐 *Owner Registration*\n\n` +
      `Usage: \`/setowner <password>\`\n\n` +
      `Enter the owner password to receive order alerts on this chat.`
    );
  }

  if (password !== OWNER_PASSWORD) {
    return send(chatId, `❌ *Wrong password.* Access denied.`);
  }

  if (isOwner(chatId)) {
    return send(chatId,
      `✅ *You're already registered as an owner!*\n\n` +
      `📊 Total owners: ${getOwnerIds().length}\n` +
      `Use /removeowner to unregister.`
    );
  }

  ownerRegistry[String(chatId)] = {
    name: `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim() || "Unknown",
    username: msg.from.username || null,
    registeredAt: new Date().toISOString(),
  };

  console.log(`👑 New owner registered: ${chatId} (${ownerRegistry[String(chatId)].name})`);

  send(chatId,
    `👑 *You are now registered as Owner!*\n\n` +
    `✅ You will receive alerts for all new orders.\n` +
    `📊 Total active owners: *${getOwnerIds().length}*\n\n` +
    `Commands available:\n` +
    `/orders — View all active orders\n` +
    `/owners — List all registered owners\n` +
    `/removeowner — Stop receiving order alerts`
  );
});

// ════════════════════════════════════════════════════
//  /removeowner — Unregister yourself as owner
// ════════════════════════════════════════════════════
bot.onText(/\/removeowner/, (msg) => {
  const chatId = String(msg.chat.id);

  if (!ownerRegistry[chatId]) {
    return send(msg.chat.id, `❌ *You are not registered as an owner.*`);
  }

  const name = ownerRegistry[chatId].name;
  delete ownerRegistry[chatId];

  console.log(`👋 Owner unregistered: ${chatId} (${name})`);
  send(msg.chat.id,
    `👋 *Unregistered successfully.*\n\n` +
    `You will no longer receive order alerts.\n` +
    `Remaining owners: *${getOwnerIds().length}*`
  );
});

// ════════════════════════════════════════════════════
//  /owners — List all registered owners (owner only)
// ════════════════════════════════════════════════════
bot.onText(/\/owners/, (msg) => {
  if (!isOwner(msg.chat.id)) {
    return send(msg.chat.id, `❌ *Owner access required.*\nUse /setowner to register.`);
  }

  const ids = getOwnerIds();
  if (ids.length === 0) {
    return send(msg.chat.id, `📭 *No owners registered.*`);
  }

  let text = `👑 *Registered Owners (${ids.length})*\n\n`;
  for (const id of ids) {
    const o = ownerRegistry[id];
    const usernameStr = o.username ? ` @${o.username}` : "";
    text += `• *${o.name}*${usernameStr}\n  \`${id}\` | Since ${o.registeredAt.slice(0, 10)}\n\n`;
  }
  send(msg.chat.id, text);
});

// ════════════════════════════════════════════════════
//  /orders — View active orders (owner only)
// ════════════════════════════════════════════════════
bot.onText(/\/orders/, (msg) => {
  if (!isOwner(msg.chat.id)) {
    return send(msg.chat.id, `❌ *Owner access required.*\nUse /setowner to register.`);
  }

  const active = Object.entries(orders);
  if (active.length === 0) {
    return send(msg.chat.id, `📭 *No active orders.*`);
  }

  let text = `📋 *Active Orders (${active.length})*\n\n`;
  for (const [cid, o] of active) {
    const loc = o.location
      ? `[📍 Map](https://maps.google.com/?q=${o.location.latitude},${o.location.longitude})`
      : "No location";
    text += `🆔 \`${o.id}\` | ${STAGES[o.status].icon} ${STAGES[o.status].label}\n`;
    text += `   👤 \`${cid}\` | 💰 ${CURRENCY}${o.total} | ${loc}\n\n`;
  }
  send(msg.chat.id, text);
});

// ════════════════════════════════════════════════════
//  CALLBACK HANDLER
// ════════════════════════════════════════════════════
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  await bot.answerCallbackQuery(query.id);
  ensureSession(chatId);

  if (data === "show_categories") {
    const buttons = Object.keys(MENU).map((cat) => [
      { text: `🗂️ ${cat}`, callback_data: `cat_${cat}` },
    ]);
    buttons.push([{ text: "🛒 View Cart", callback_data: "view_cart" }]);
    buttons.push([{ text: "🏠 Home", callback_data: "home" }]);
    send(chatId, `🍴 *${RESTAURANT} — Menu*\n\nChoose a category:`, {
      reply_markup: { inline_keyboard: buttons },
    });
  } else if (data.startsWith("cat_")) {
    const cat = data.replace("cat_", "");
    const items = MENU[cat];
    if (!items) return;
    let text = `📂 *${cat}*\n\n`;
    const buttons = [];
    for (const [name, info] of Object.entries(items)) {
      text += `${name}\n_${info.desc}_\n*${CURRENCY}${info.price}*\n\n`;
      buttons.push([{ text: `➕ Add ${name}`, callback_data: `add_${name}` }]);
    }
    buttons.push([
      { text: "🛒 View Cart", callback_data: "view_cart" },
      { text: "🔙 Categories", callback_data: "show_categories" },
    ]);
    send(chatId, text, { reply_markup: { inline_keyboard: buttons } });
  } else if (data.startsWith("add_")) {
    const item = data.replace("add_", "");
    session[chatId].cart[item] = (session[chatId].cart[item] || 0) + 1;
    const qty = session[chatId].cart[item];
    const price = findPrice(item);
    send(chatId, `🛒 *${item}* added! ×${qty} (${CURRENCY}${price * qty})`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Add More", callback_data: "show_categories" }],
          [{ text: "🛒 View Cart", callback_data: "view_cart" }],
        ],
      },
    });
  } else if (data === "view_cart") {
    const cart = session[chatId]?.cart || {};
    if (Object.keys(cart).length === 0) {
      return send(chatId, `🛒 *Cart is empty!* Add some items 😋`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🍽️ Browse Menu", callback_data: "show_categories" }],
            [{ text: "🏠 Home", callback_data: "home" }],
          ],
        },
      });
    }
    const { text, total } = formatCart(cart);
    send(chatId,
      `🛒 *Your Cart*\n\n${text}\n━━━━━━━━━━━━━\n💰 *Total: ${CURRENCY}${total}*\n💵 Cash on Delivery`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Place Order", callback_data: "pre_order" }],
            [{ text: "🗑️ Clear Cart", callback_data: "clear_cart" }],
            [{ text: "➕ Add More Items", callback_data: "show_categories" }],
          ],
        },
      }
    );
  } else if (data === "clear_cart") {
    session[chatId].cart = {};
    send(chatId, `🗑️ *Cart cleared!*`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🍽️ Browse Menu", callback_data: "show_categories" }],
          [{ text: "🏠 Home", callback_data: "home" }],
        ],
      },
    });
  } else if (data === "pre_order") {
    const cart = session[chatId]?.cart || {};
    if (Object.keys(cart).length === 0) {
      return send(chatId, `❌ *Cart is empty!*`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🍽️ Browse Menu", callback_data: "show_categories" }],
          ],
        },
      });
    }
    const savedCart = { ...session[chatId].cart };
    session[chatId] = { cart: savedCart };
    askLiveLocation(chatId);
  } else if (data === "order_status") {
    const order = orders[chatId];
    if (!order) {
      return send(chatId, `❌ *No active order.*\n\nReady to order? 😋`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🍽️ Order Now", callback_data: "show_categories" }],
            [{ text: "🏠 Home", callback_data: "home" }],
          ],
        },
      });
    }
    send(chatId, buildLiveStatus(order), {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Refresh", callback_data: "order_status" }],
          [{ text: "🏠 Home", callback_data: "home" }],
        ],
      },
    });
  } else if (data === "contact") {
    send(chatId,
      `📞 *Contact ${RESTAURANT}*\n\n📱 +91 98765 43210\n⏰ 10AM – 11PM\n📍 Surat, Gujarat`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "🏠 Home", callback_data: "home" }]],
        },
      }
    );
  } else if (data === "home") {
    const savedCart = session[chatId]?.cart || {};
    session[chatId] = { cart: savedCart };
    send(chatId, `🏠 *Main Menu*`, { reply_markup: homeKeyboard() });
  }
});

if (!useWebhook) {
  bot.on("polling_error", (err) => console.error("Polling error:", err.message));
}

// Render (Web Service) expects the process to bind to a port.
// Keep a lightweight HTTP server open for health checks.
const PORT = Number(process.env.PORT) || 3000;
http
  .createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Health server listening on port ${PORT}`);
  });

console.log(`✅ ${RESTAURANT} Bot running (${useWebhook ? "webhook" : "polling"})...`);
console.log(`🔐 Owner password set: ${OWNER_PASSWORD !== "admin123" ? "✅ Custom" : "⚠️  Default (set OWNER_PASSWORD env var!)"}`);
console.log(`⏱️  Stages: confirmed→${STAGE_DURATIONS.confirmed}s → preparing→${STAGE_DURATIONS.preparing}s → picked_up→${STAGE_DURATIONS.picked_up}s → nearby→${STAGE_DURATIONS.nearby}s → delivered`);
console.log(`💡 To register as owner, send: /setowner <password> in your Telegram chat with the bot`);

module.exports = bot;
