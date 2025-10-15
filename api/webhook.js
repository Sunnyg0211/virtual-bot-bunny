import fetch from "node-fetch";
import fs from "fs";
import path from "path";

// ------------------- Environment -------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const apiKeys = process.env.OPENAI_API_KEYS.split(",");
let currentKeyIndex = 0;

// ------------------- Persistent User Storage -------------------
const userFile = path.join("/tmp", "users.json");

function loadUsers() {
  try {
    if (!fs.existsSync(userFile)) return {};
    return JSON.parse(fs.readFileSync(userFile));
  } catch (err) {
    console.error("Error loading users:", err);
    return {};
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(userFile, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("Error saving users:", err);
  }
}

function getUser(chatId) {
  const users = loadUsers();
  if (!users[chatId]) users[chatId] = {};
  return users[chatId];
}

function updateUser(chatId, data) {
  const users = loadUsers();
  users[chatId] = { ...users[chatId], ...data };
  saveUsers(users);
}

// ------------------- ChatGPT Helper -------------------
async function getChatGPTReply(prompt) {
  let attempts = 0;
  while (attempts < apiKeys.length) {
    const key = apiKeys[currentKeyIndex];
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          messages: [{ role: "system", content: "You are VIRTUAL_BUNNY, a cheerful, friendly, witty assistant." }, { role: "user", content: prompt }],
          temperature: 0.7,
          max_tokens: 200
        })
      });
      const data = await resp.json();
      if (resp.status !== 200 || data.error) throw new Error(data.error?.message || "API Error");
      return data.choices[0].message.content;
    } catch (err) {
      console.warn(`API key ${currentKeyIndex + 1} failed: ${err.message}`);
      currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
      attempts++;
    }
  }
  console.warn("All ChatGPT APIs failed. Using DuckDuckGo fallback.");
  return await fetchDuckDuckGoContent(prompt);
}

// ------------------- DuckDuckGo Fallback -------------------
async function fetchDuckDuckGoContent(query, max = 3) {
  try {
    const resp = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
    const data = await resp.json();
    const topics = data.RelatedTopics.slice(0, max);
    if (!topics.length) return "Sorry, I couldn't find an answer.";
    return topics.map(t => t.Text || t.FirstURL).join("\n\n");
  } catch (err) {
    console.error("DuckDuckGo fetch error:", err);
    return "Sorry, something went wrong fetching results.";
  }
}

// ------------------- Telegram Helpers -------------------
async function sendMessage(chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text, parse_mode: "Markdown" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
}

async function sendPhoto(chatId, photoUrl, caption = "") {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption })
  });
}

// ------------------- Group Cooldown -------------------
const groupCooldowns = {};
function canReplyGroup(chatId) {
  const last = groupCooldowns[chatId] || 0;
  if (Date.now() - last > 2 * 60 * 1000) {
    groupCooldowns[chatId] = Date.now();
    return true;
  }
  return false;
}

// ------------------- Category Buttons -------------------
const categories = ["Electronics", "Fashion", "Beauty", "Home", "Sports", "Toys", "Books", "Accessories"];
function getCategoryButtons() { return { inline_keyboard: categories.map(cat => [{ text: cat, callback_data: cat }]) }; }

// ------------------- Currency Conversion -------------------
async function convertCurrency(amount, targetCurrency) {
  if (!targetCurrency || targetCurrency === "INR") return amount;
  try {
    const resp = await fetch(`https://api.exchangerate.host/convert?from=USD&to=${targetCurrency}&amount=${amount}`);
    const data = await resp.json();
    return data.result ? data.result.toFixed(2) : amount;
  } catch (err) { console.error("Currency conversion error:", err); return amount; }
}

// ------------------- Country / Timezone to Currency -------------------
function getCurrencyByCountry(code) {
  const mapping = { US: "USD", IN: "INR", GB: "GBP", FR: "EUR", JP: "JPY", CA: "CAD", AU: "AUD" };
  return mapping[code] || "INR";
}
async function getCurrencyFromLocation(location) {
  if (!location) return "INR";
  const { latitude, longitude } = location;
  try {
    const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`);
    const data = await resp.json();
    const countryCode = data.address?.country_code?.toUpperCase();
    return getCurrencyByCountry(countryCode);
  } catch (err) { console.error("Location to currency error:", err); return "INR"; }
}
function getCurrencyFromTimezone(timezone) {
  if (!timezone) return "INR";
  const mapping = { "Asia/Kolkata": "INR", "America/New_York": "USD", "Europe/London": "GBP", "Europe/Paris": "EUR", "Asia/Tokyo": "JPY" };
  return mapping[timezone] || "INR";
}

// ------------------- Product Search -------------------
async function searchProducts(query, userCurrency = "INR", max = 5) {
  try {
    const resp = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
    const data = await resp.json();
    return await Promise.all(data.RelatedTopics.slice(0, max).map(async item => {
      let priceUSD = 100;
      if (item.Text && item.Text.match(/\$(\d+)/)) priceUSD = parseFloat(item.Text.match(/\$(\d+)/)[1]);
      const priceLocal = await convertCurrency(priceUSD, userCurrency);
      return { title: item.Text || item.FirstURL, link: item.FirstURL || "https://duckduckgo.com", description: item.Text || "", price: priceLocal, currency: userCurrency };
    }));
  } catch (err) { console.error("Product search error:", err); return []; }
}

// ------------------- Mood Detection -------------------
async function detectMood(text) {
  const prompt = `Analyze the following conversation and describe the overall mood as one word: happy, sad, angry, neutral. Conversation: "${text}"`;
  return (await getChatGPTReply(prompt)).toLowerCase().trim();
}

// ------------------- Dynamic Quote/Image Fetch -------------------
async function fetchQuoteOrImage(mood) {
  try {
    const resp = await fetch(`https://api.duckduckgo.com/?q=${mood}+quote&format=json`);
    const data = await resp.json();
    const firstResult = data.RelatedTopics[0];
    if (firstResult && firstResult.FirstURL) return { type: "image", url: firstResult.FirstURL };
    if (firstResult && firstResult.Text) return { type: "text", text: firstResult.Text };
    return { type: "text", text: `Here's something ${mood} for you!` };
  } catch (err) { console.error("Fetch quote/image error:", err); return { type: "text", text: `Here's something ${mood} for you!` }; }
}

// ------------------- Temporary File Storage -------------------
function saveFileTemporarily(fileBuffer, filename) {
  const filePath = path.join("/tmp", filename);
  fs.writeFileSync(filePath, fileBuffer);
  setTimeout(() => { if (fs.existsSync(filePath)) fs.unlink(filePath, err => err && console.error("Delete file error:", err)); }, 24*60*60*1000);
  return filePath;
}

// ------------------- Send Dynamic Content -------------------
async function sendDynamicContent(chatId, mood) {
  const content = await fetchQuoteOrImage(mood);
  if (content.type === "text") await sendMessage(chatId, content.text);
  else if (content.type === "image") await sendPhoto(chatId, content.url, `Mood: ${mood}`);
}

// ------------------- Automatic Prompts -------------------
async function askForLocation(chatId) {
  await sendMessage(chatId, "Hi! To show prices in your currency, please share your location 📍", { keyboard: [[{ text: "Share Location", request_location: true }]], one_time_keyboard: true });
}
async function askForCategory(chatId) { await sendMessage(chatId, "Which category interests you the most?", getCategoryButtons()); }
async function askForNickname(chatId) { await sendMessage(chatId, "Hey! How should I call you? 🤗"); }

// ------------------- Webhook Handler -------------------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  try {
    const update = req.body;
    if (!update.message && !update.callback_query) return res.status(200).send("No message");

    const chatId = update.message?.chat.id || update.callback_query?.message.chat.id;
    const text = update.message?.text || update.callback_query?.data;
    const chatType = update.message?.chat.type || "private";

    const user = getUser(chatId);

    // --- First-time prompts ---
    if (!user.initialized) {
      await askForLocation(chatId);
      await askForNickname(chatId);
      await askForCategory(chatId);
      updateUser(chatId, { initialized: true });
      return res.status(200).send("Prompts sent");
    }

    // --- Update stored data ---
    if (update.message?.location) {
      const currency = await getCurrencyFromLocation(update.message.location);
      updateUser(chatId, { location: update.message.location, currency });
    } else if (!user.currency) {
      updateUser(chatId, { currency: getCurrencyFromTimezone("Asia/Kolkata") });
    }
    if (text && !user.nickname) updateUser(chatId, { nickname: text });
    if (categories.includes(text) && !user.category) updateUser(chatId, { category: text });

    const userCurrency = user.currency || "INR";
    const nickname = user.nickname || "Friend";

    // --- Group participation ---
    if (chatType === "group") {
      if (Math.random() < 0.2 && canReplyGroup(chatId)) {
        const mood = await detectMood(text);
        await sendDynamicContent(chatId, mood);
        return res.status(200).send("Group dynamic reply sent");
      }
    }

    // --- Handle category buttons ---
    if (categories.includes(text)) {
      const products = await searchProducts(text, userCurrency);
      let reply = `🛒 Top products in *${text}*:\n\n`;
      products.forEach((p,i)=>{ reply += `${i+1}. [${p.title}](${p.link})\nPrice: ${p.price} ${p.currency}\n${p.description}\n\n`; });
      await sendMessage(chatId, reply);
      return res.status(200).send("Category products sent");
    }

    // --- Product queries ---
    if (/buy|price|inr|usd/i.test(text)) {
      const products = await searchProducts(text, userCurrency);
      if (!products.length) await sendMessage(chatId, "No products found �� Try another keyword.");
      else {
        let reply = `🛒 Best matches for "${text}":\n\n`;
        products.forEach((p,i)=>{ reply += `${i+1}. [${p.title}](${p.link})\nPrice: ${p.price} ${p.currency}\n${p.description}\n\n`; });
        await sendMessage(chatId, reply);
      }
      return res.status(200).send("Product results sent");
    }

    // --- Fallback ChatGPT / DuckDuckGo ---
    const prompt = `You are VIRTUAL_BUNNY, chatting with ${nickname}. Reply naturally: "${text}"`;
    const reply = await getChatGPTReply(prompt);
    await sendMessage(chatId, reply, getCategoryButtons());

    return res.status(200).send("Message processed");

  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("Internal server error");
  }
}
