require("dotenv").config();

const axios = require("axios");
const cheerio = require("cheerio");
const { Telegraf, Markup } = require("telegraf");
const { MongoClient } = require("mongodb");

// ====== ENV ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS.split(",").map(Number);
const MONGO_URI = process.env.MONGO_URI;

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
  const config = await db.collection("config").findOne({ _id: "main" });
  return config?.wishlistId;
}

// ====== SCRAPER ======
async function checkStock() {
  try {
    const wishlistId = await getWishlist();
    if (!wishlistId) return [];

    const url = `https://www.amazon.in/hz/wishlist/ls/${wishlistId}`;

    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-IN,en;q=0.9"
      }
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

    return results;

  } catch (err) {
    console.log("Scrape error:", err.message);
    return [];
  }
}

// ====== SEND STOCK ======
async function sendStockUpdate() {
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

  const users = await db.collection("users").find({ status: "approved" }).toArray();
  const allUsers = [...new Set([...users.map(u => u.userId), ...ADMIN_IDS])];

  for (let user of allUsers) {
    try {
      await bot.telegram.sendMessage(user, msg);
    } catch {}
  }
}

// ====== COMMANDS ======

// START (approval)
bot.start(async (ctx) => {
  const id = ctx.from.id;

  if (await isAuthorized(id)) {
    return ctx.reply("✅ Already authorized");
  }

  await addPendingUser(id);
  await ctx.reply("📝 Request sent to admin");

  for (let admin of ADMIN_IDS) {
    bot.telegram.sendMessage(
      admin,
      `New request:\nID: ${id}\nName: ${ctx.from.first_name}`,
      Markup.inlineKeyboard([
        Markup.button.callback("✅ Accept", `accept_${id}`),
        Markup.button.callback("❌ Decline", `decline_${id}`)
      ])
    );
  }
});

// APPROVE
bot.action(/accept_(.+)/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  await approveUser(userId);

  await bot.telegram.sendMessage(userId, "✅ Approved");
  ctx.editMessageText("Approved");
});

// DECLINE
bot.action(/decline_(.+)/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  await removeUser(userId);

  await bot.telegram.sendMessage(userId, "❌ Declined");
  ctx.editMessageText("Declined");
});

// ADD PRODUCT
bot.command("p_add", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const match = ctx.message.text.match(/\/p_add (\w+) "(.+)"/);
  if (!match) return ctx.reply('Format: /p_add ASIN "Product Name"');

  const [, asin, name] = match;
  await addProduct(asin, name);

  ctx.reply(`✅ Added: ${name}`);
});

// REMOVE PRODUCT
bot.command("p_rm", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const asin = ctx.message.text.split(" ")[1];
  await removeProduct(asin);

  ctx.reply(`❌ Removed: ${asin}`);
});

// LIST PRODUCTS
bot.command("list", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const products = await getProducts();

  let msg = "📋 Products:\n\n";
  products.forEach(p => {
    msg += `${p.asin}: ${p.name}\n`;
  });

  ctx.reply(msg);
});

// SET WISHLIST
bot.command("setWishlist", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const id = ctx.message.text.split(" ")[1];
  if (!id) return ctx.reply("Usage: /setWishlist ID");

  await setWishlist(id);
  ctx.reply(`✅ Wishlist updated: ${id}`);
});

// STATUS
bot.command("status", async (ctx) => {
  if (!(await isAuthorized(ctx.from.id))) return;

  await ctx.reply("Checking...");
  await sendStockUpdate();
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
    await sendStockUpdate();
  } catch (e) {
    console.log(e);
  }

  isRunning = false;
}

// ====== START ======
(async () => {
  await connectDB();
  bot.launch();

  console.log("🤖 Bot running");

  setInterval(safeRun, 60 * 1000);
})();
