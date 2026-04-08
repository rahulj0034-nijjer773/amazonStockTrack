// ====== SAFE ENV LOAD ======
if (process.env.NODE_ENV !== "production") {
  try {
    require("dotenv").config();
  } catch {}
}

const axios = require("axios");
const cheerio = require("cheerio");
const { Telegraf, Markup } = require("telegraf");
const { MongoClient } = require("mongodb");

// ====== ENV ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(Number);
const MONGO_URI = process.env.MONGO_URI;

if (!BOT_TOKEN || !MONGO_URI) {
  console.error("❌ Missing ENV");
  process.exit(1);
}

// ====== INIT ======
const bot = new Telegraf(BOT_TOKEN);
const client = new MongoClient(MONGO_URI);

let db;

// ====== CONNECT DB ======
async function connectDB() {
  await client.connect();
  db = client.db("amazon_bot");
  console.log("✅ MongoDB connected");
}

// ====== HELPERS ======
const isAdmin = (id) => ADMIN_IDS.includes(id);

async function isAuthorized(id) {
  const user = await db.collection("users").findOne({ userId: id });
  return user && user.status === "approved";
}

// ====== USER MGMT ======
async function addPendingUser(id) {
  await db.collection("users").updateOne(
    { userId: id },
    { $set: { status: "pending" } },
    { upsert: true }
  );
}

async function approveUser(id) {
  await db.collection("users").updateOne(
    { userId: id },
    { $set: { status: "approved" } }
  );
}

async function removeUser(id) {
  await db.collection("users").deleteOne({ userId: id });
}

// ====== PRODUCT MGMT ======
async function addProduct(asin, name) {
  await db.collection("products").updateOne(
    { asin },
    { $set: { name } },
    { upsert: true }
  );
}

async function removeProduct(asin) {
  await db.collection("products").deleteOne({ asin });
}

async function getProducts() {
  return await db.collection("products").find().toArray();
}

// ====== WISHLIST ======
async function setWishlist(id) {
  await db.collection("config").updateOne(
    { _id: "main" },
    { $set: { wishlistId: id } },
    { upsert: true }
  );
}

async function getWishlist() {
  const c = await db.collection("config").findOne({ _id: "main" });
  return c?.wishlistId;
}

// ====== MESSAGE CACHE ======
async function getLastMessage() {
  const c = await db.collection("config").findOne({ _id: "lastMsg" });
  return c?.text;
}

async function setLastMessage(text) {
  await db.collection("config").updateOne(
    { _id: "lastMsg" },
    { $set: { text } },
    { upsert: true }
  );
}

// ====== SCRAPER ======
async function checkStock() {
  try {
    const wishlistId = await getWishlist();
    if (!wishlistId) {
      console.log("⚠️ No wishlist set");
      return [];
    }

    const url = `https://www.amazon.in/hz/wishlist/ls/${wishlistId}`;

    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-IN,en;q=0.9"
      },
      timeout: 15000
    });

    const $ = cheerio.load(data);
    let results = [];

    $("a.a-button-text").each((i, el) => {
      const action = $(el).attr("data-csa-c-action");

      if (!action) return;

      if (action.includes("add-to-cart")) {
        const asin = $(el).attr("data-csa-c-item-id");
        if (asin) results.push({ asin, inStock: true });
      }
    });

    console.log("🧪 Scraped results:", results);

    return results;

  } catch (e) {
    console.log("❌ Scrape error:", e.message);
    return [];
  }
}

// ====== BUILD MESSAGE (FOR AUTO SEND ONLY) ======
async function buildMessage() {
  const products = await getProducts();
  const results = await checkStock();

  let msg = "📦 Amazon Stock Update:\n\n";

  for (let p of products) {
    const found = results.find(r => r.asin === p.asin);

    if (found && found.inStock) {
      const link = `https://www.amazon.in/dp/${p.asin}/ref=ox_sfl_cart_mbc_s1?pscz=1&aod=1`;
      msg += `✅ ${p.name}\n${link}\n\n`;
    } else {
      msg += `❌ ${p.name}\n\n`;
    }
  }

  return msg;
}

// ====== AUTO SEND ======
async function sendStockUpdate() {
  const msg = await buildMessage();

  const lastMsg = await getLastMessage();
  if (lastMsg === msg) {
    console.log("⏭ Skipping duplicate notification");
    return;
  }

  await setLastMessage(msg);

  const users = await db.collection("users").find({ status: "approved" }).toArray();
  const allUsers = [...new Set([...users.map(u => u.userId), ...ADMIN_IDS])];

  for (let user of allUsers) {
    try {
      await bot.telegram.sendMessage(user, msg, {
        disable_web_page_preview: true
      });
    } catch (e) {
      console.log("❌ Telegram error:", e.message);
    }
  }
}

// ====== COMMANDS ======

// START
bot.start(async (ctx) => {
  const id = ctx.from.id;

  if (await isAuthorized(id)) {
    return ctx.reply("✅ Already authorized");
  }

  await addPendingUser(id);
  await ctx.reply("📝 Request sent");

  for (let admin of ADMIN_IDS) {
    bot.telegram.sendMessage(
      admin,
      `New request:\nID: ${id}`,
      Markup.inlineKeyboard([
        Markup.button.callback("✅ Accept", `accept_${id}`),
        Markup.button.callback("❌ Decline", `decline_${id}`)
      ])
    );
  }
});

// APPROVE / DECLINE
bot.action(/accept_(.+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await approveUser(id);
  await bot.telegram.sendMessage(id, "✅ Approved");
  ctx.editMessageText("Approved");
});

bot.action(/decline_(.+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await removeUser(id);
  await bot.telegram.sendMessage(id, "❌ Declined");
  ctx.editMessageText("Declined");
});

// PRODUCTS
bot.command("p_add", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const match = ctx.message.text.match(/\/p_add (\w+) "(.+)"/);
  if (!match) return ctx.reply('Format: /p_add ASIN "Name"');

  await addProduct(match[1], match[2]);
  ctx.reply("✅ Added");
});

bot.command("p_rm", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const asin = ctx.message.text.split(" ")[1];
  await removeProduct(asin);
  ctx.reply("❌ Removed");
});

bot.command("list", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const products = await getProducts();
  let msg = "📋 Products:\n\n";

  products.forEach(p => {
    msg += `${p.asin}: ${p.name}\n`;
  });

  ctx.reply(msg);
});

// WISHLIST
bot.command("setWishlist", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const id = ctx.message.text.split(" ")[1];
  await setWishlist(id);

  ctx.reply(`✅ Wishlist updated: ${id}`);
});

// 🔥 FIXED STATUS (NO FAIL VERSION)
bot.command("status", async (ctx) => {
  try {
    if (!(await isAuthorized(ctx.from.id))) {
      return ctx.reply("❌ Not authorized");
    }

    await ctx.reply("🔍 Checking stock...");

    const products = await getProducts();
    const results = await checkStock();

    console.log("📦 Products:", products);
    console.log("📊 Results:", results);

    let msg = "📦 Amazon Stock Status:\n\n";

    for (let p of products) {
      const found = results.find(r => r.asin === p.asin);

      if (found && found.inStock) {
        const link = `https://www.amazon.in/dp/${p.asin}/ref=ox_sfl_cart_mbc_s1?pscz=1&aod=1`;
        msg += `✅ ${p.name}\n${link}\n\n`;
      } else {
        msg += `❌ ${p.name}\n\n`;
      }
    }

    if (!products.length) {
      msg += "⚠️ No products added";
    }

    await ctx.reply(msg, {
      disable_web_page_preview: true
    });

  } catch (err) {
    console.log("❌ STATUS ERROR:", err);
    await ctx.reply("❌ Error occurred. Check logs.");
  }
});

// REMOVE USER
bot.command("user_rm", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const id = Number(ctx.message.text.split(" ")[1]);
  await removeUser(id);

  ctx.reply("User removed");
});

// ====== SAFE INTERVAL ======
let isRunning = false;

async function safeRun() {
  if (isRunning) return;
  isRunning = true;

  try {
    console.log("⏱ Checking stock...");
    await sendStockUpdate();
  } catch (e) {
    console.log("Interval error:", e.message);
  }

  isRunning = false;
}

// ====== START ======
(async () => {
  await connectDB();
  bot.launch();

  console.log("🤖 Bot running...");

  setInterval(safeRun, 60 * 1000);
})();
