import { XMLParser } from "fast-xml-parser";

const CACHE = {
  NEWS: 86400,
  API: 300,
  SITEMAP: 3600,
};
const BATCH_SIZE = 50;
const MAX_SITEMAP_URLS = 45000;
const LOCK_TTL = 3300;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "__cdata",
  trimValues: true,
  parseTagValue: false,
});

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}
function textValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") return String(value.__cdata ?? value["#text"] ?? "").trim();
  return "";
}
function firstText(...values) {
  for (const v of values) {
    const t = textValue(v);
    if (t) return t;
  }
  return "";
}
function escapeHTML(text = "") {
  return String(text).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[m]));
}
function escapeXML(text = "") {
  return String(text).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  }[m]));
}
function normalizeURL(raw) {
  try {
    const u = new URL(raw.trim());
    // Preserve the query because some publishers use it as part of the article URL.
    // Drop fragments because they do not identify a different server-side resource.
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}
function domainOf(raw) {
  try { return new URL(raw).hostname.replace(/^www\./, ""); } catch { return ""; }
}
function isoDate(raw) {
  const d = new Date(raw || Date.now());
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function slugify(title) {
  let slug = String(title || "")
    .trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return slug || "news";
}
function safeImageFromItem(item, content) {
  const candidates = [
    item?.enclosure?.["@_url"],
    item?.enclosure?.url,
    item?.["media:content"]?.["@_url"],
    item?.["media:content"]?.url,
  ];
  for (const candidate of candidates) {
    try { if (candidate && new URL(candidate).protocol.startsWith("http")) return candidate; } catch {}
  }
  const m = String(content || "").match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) {
    try { if (new URL(m[1]).protocol.startsWith("http")) return m[1]; } catch {}
  }
  return "";
}
function stripMarkup(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRSS(xml) {
  const root = parser.parse(xml);
  const rssItems = asArray(root?.rss?.channel?.item);
  const atomEntries = asArray(root?.feed?.entry);
  const rdfItems = asArray(root?.RDF?.item ?? root?.rdf?.item);
  const rawItems = [...rssItems, ...atomEntries, ...rdfItems];
  const result = [];

  for (const item of rawItems) {
    const title = firstText(item.title);
    let link = firstText(item.link);
    if (!link && item.link?.["@_href"]) link = item.link["@_href"];
    const pubDate = firstText(item.pubDate, item.published, item.updated, item["dc:date"]);
    const description = firstText(item.description, item.summary, item["content:description"]);
    const content = firstText(item["content:encoded"], item.content, item["content:description"], description);
    const originalUrl = normalizeURL(link);
    if (!title || !originalUrl) continue;

    result.push({
      title: title.trim(),
      link: originalUrl,
      pubDate: isoDate(pubDate),
      description: stripMarkup(description).slice(0, 500),
      content: stripMarkup(content).slice(0, 4000),
      image: safeImageFromItem(item, content),
      source: domainOf(originalUrl),
      originalUrl,
    });
  }
  return result;
}

async function listKeys(env, prefix, limit = 1000) {
  const keys = [];
  let cursor;
  do {
    const page = await env.NEWS_KV.list({ prefix, limit, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}
async function getBatch(env, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    const values = await Promise.all(batch.map(k => env.NEWS_KV.get(k, "json")));
    out.push(...values.filter(Boolean));
  }
  return out;
}
async function getRecentNews(env, limit = 30) {
  const dateKeys = await listKeys(env, "date:");
  dateKeys.sort((a, b) => b.name.localeCompare(a.name));
  const selected = dateKeys.slice(0, Math.max(limit * 2, limit));
  const news = await getBatch(env, selected.map(k => `news:${k.name.split(":").pop()}`));
  const unique = new Map(news.map(n => [n.id, n]));
  return [...unique.values()].sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate)).slice(0, limit);
}

async function getNews(env, id) {
  return env.NEWS_KV.get(`news:${id}`, "json");
}

// KV has no atomic "put-if-absent" operation. Instead of pretending it does,
// IDs are deterministic SHA-256 hashes of normalized source URLs. Re-running
// the same feed therefore overwrites the same record rather than creating duplicates.
async function saveNews(env, item) {
  const id = await sha256Hex(item.originalUrl);
  const previous = await env.NEWS_KV.get(`news:${id}`, "json");
  const baseSlug = slugify(item.title);
  const news = {
    ...item,
    id,
    slug: `${baseSlug}-${id.slice(0, 8)}`,
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const date = news.pubDate.slice(0, 10);
  if (previous?.slug && previous.slug !== news.slug) {
    await env.NEWS_KV.delete(`slug:${previous.slug}`);
  }
  if (previous?.pubDate) {
    const oldDate = previous.pubDate.slice(0, 10);
    if (oldDate !== date) await env.NEWS_KV.delete(`date:${oldDate}:${id}`);
  }
  await env.NEWS_KV.put(`news:${id}`, JSON.stringify(news));
  await env.NEWS_KV.put(`slug:${news.slug}`, id);
  const urlKey = await sha256Hex(item.originalUrl);
  await env.NEWS_KV.put(`url:${urlKey}`, id);
  
  await env.NEWS_KV.put(`date:${date}:${id}`, "1");
  return news;
}

async function fetchFeeds(env) {
  const urls = (env.RSS_FEEDS || "").split(",").map(s => s.trim()).filter(Boolean);
  const results = await Promise.all(urls.map(async (feedUrl) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": "ProclaimNewsBot/1.0 (+https://proclaim.news)" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseRSS(await res.text());
    } catch (err) {
      console.error("RSS fetch failed", feedUrl, err?.message || err);
      return [];
    }
  }));
  const unique = new Map();
  for (const item of results.flat()) unique.set(item.originalUrl, item);
  return [...unique.values()];
}

// A KV lease is useful as a best-effort guard, but it is not a distributed
// mutex because KV writes are eventually consistent. Idempotent news IDs are
// the real duplicate-safety mechanism.
async function acquireLease(env) {
  const token = crypto.randomUUID();
  const current = await env.NEWS_KV.get("cron:lease");
  if (current) return null;
  await env.NEWS_KV.put("cron:lease", token, { expirationTtl: LOCK_TTL });
  const confirmed = await env.NEWS_KV.get("cron:lease");
  return confirmed === token ? token : null;
}
async function releaseLease(env, token) {
  if (!token) return;
  const current = await env.NEWS_KV.get("cron:lease");
  if (current === token) await env.NEWS_KV.delete("cron:lease");
}

async function updateNews(env) {
  const lease = await acquireLease(env);
  if (!lease) return { skipped: true };
  try {
    const items = await fetchFeeds(env);
    let saved = 0;
    for (const item of items) {
      await saveNews(env, item);
      saved++;
    }
    console.log(JSON.stringify({ event: "news_update", total: items.length, saved }));
    return { total: items.length, saved };
  } finally {
    await releaseLease(env, lease);
  }
}

function json(data, status = 200, cache = CACHE.API) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${cache}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}
function renderSitemap(news, baseUrl) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
  xml += `<url><loc>${escapeXML(baseUrl)}/</loc><lastmod>${new Date().toISOString().slice(0,10)}</lastmod></url>`;
  for (const item of news) {
    xml += `<url><loc>${escapeXML(baseUrl)}/news/${escapeXML(item.slug)}</loc><lastmod>${escapeXML(item.pubDate.slice(0,10))}</lastmod></url>`;
  }
  xml += "</urlset>";
  return xml;
}
function renderNewsPage(item, baseUrl) {
  const title = escapeHTML(item.title);
  const description = escapeHTML(item.description.slice(0, 160));
  const image = item.image ? `<img src="${escapeHTML(item.image)}" alt="${title}" class="article-image" loading="lazy">` : "";
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | Proclaim</title><meta name="description" content="${description}"><link rel="canonical" href="${escapeHTML(baseUrl)}/news/${escapeHTML(item.slug)}"><style>*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#171717;font-family:Arial,sans-serif;padding:20px}.wrap{max-width:850px;margin:auto}.head{background:#fff;border:1px solid #ddd;border-radius:18px;padding:18px 22px;margin-bottom:22px}.head a{color:#1769ff;text-decoration:none;font-weight:800;font-size:24px}.card{background:#fff;border:1px solid #ddd;border-radius:22px;padding:28px}.meta{color:#888;font-size:12px;margin-bottom:12px}.meta strong{color:#1769ff}.title{font-size:30px;line-height:1.8;margin:10px 0 18px}.article-image{width:100%;max-height:430px;object-fit:cover;border-radius:14px;margin:10px 0 24px}.text{font-size:15px;line-height:2.3;color:#444;white-space:pre-line}.source{margin-top:30px;padding-top:18px;border-top:1px solid #ddd;font-size:12px}.source a{color:#1769ff}@media(max-width:600px){body{padding:10px}.card{padding:20px}.title{font-size:23px}}</style></head><body><div class="wrap"><div class="head"><a href="/">Proclaim</a></div><article class="card"><div class="meta"><strong>${escapeHTML(item.source)}</strong> · ${escapeHTML(new Date(item.pubDate).toLocaleString("fa-IR"))}</div><h1 class="title">${title}</h1>${image}<div class="text">${escapeHTML(item.content || item.description)}</div><div class="source">منبع: <a href="${escapeHTML(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHTML(item.source)}</a></div></article></div></body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    try {
      if (url.pathname === "/api/news") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 30), 1), 100);
        return json(await getRecentNews(env, limit));
      }
      if (url.pathname.startsWith("/api/news/")) {
        const id = url.pathname.slice("/api/news/".length).split("/")[0];
        const item = await getNews(env, id);
        return item ? json(item) : json({ error: "خبر یافت نشد" }, 404);
      }
      if (url.pathname === "/sitemap.xml") {
        const keys = await listKeys(env, "date:");
        const counts = new Map();
        for (const k of keys) {
          const parts = k.name.split(":");
          const date = parts[1];
          counts.set(date, (counts.get(date) || 0) + 1);
        }
        const dates = [...counts.keys()].sort().reverse();
        let xml = '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
        xml += `<sitemap><loc>${escapeXML(baseUrl)}/sitemap-home.xml</loc></sitemap>`;
        for (const date of dates) {
          const shards = Math.ceil((counts.get(date) || 0) / 500);
          for (let shard = 0; shard < shards; shard++) {
            xml += `<sitemap><loc>${escapeXML(baseUrl)}/sitemap/${date}-${shard}.xml</loc></sitemap>`;
          }
        }
        xml += '</sitemapindex>';
        return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": `public, max-age=${CACHE.SITEMAP}` } });
      }
      if (url.pathname === "/sitemap-home.xml") {
        let xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
        xml += `<url><loc>${escapeXML(baseUrl)}/</loc><lastmod>${new Date().toISOString().slice(0,10)}</lastmod></url></urlset>`;
        return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": `public, max-age=${CACHE.SITEMAP}` } });
      }
      const sitemapMatch = url.pathname.match(/^\/sitemap\/(\d{4}-\d{2}-\d{2})-(\d+)\.xml$/);
      if (sitemapMatch) {
        const [, date, shardText] = sitemapMatch;
        const shard = Number(shardText);
        const keys = await listKeys(env, `date:${date}:`);
        keys.sort((a,b) => a.name.localeCompare(b.name));
        const selected = keys.slice(shard * 500, shard * 500 + 500);
        const news = await getBatch(env, selected.map(k => `news:${k.name.split(":").pop()}`));
        let xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
        for (const item of news) {
          xml += `<url><loc>${escapeXML(baseUrl)}/news/${escapeXML(item.slug)}</loc><lastmod>${escapeXML(item.pubDate.slice(0,10))}</lastmod></url>`;
        }
        xml += '</urlset>';
        return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": `public, max-age=${CACHE.SITEMAP}` } });
      }
      if (url.pathname.startsWith("/news/")) {
        const slug = decodeURIComponent(url.pathname.slice("/news/".length));
        const id = await env.NEWS_KV.get(`slug:${slug}`);
        const item = id ? await getNews(env, id) : null;
        if (!item) return new Response("خبر یافت نشد", { status: 404 });
        return new Response(renderNewsPage(item, baseUrl), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": `public, max-age=${CACHE.NEWS}` }
        });
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("Worker error", error);
      return new Response("خطای داخلی سرور", { status: 500 });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateNews(env).catch(err => console.error("Cron error", err)));
  },
};
