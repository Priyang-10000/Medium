// IF Studio Scheduler Server v4
// Infographic → GitHub Pages (HTML+SDP) → Screenshot → Blogger → Email
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const CONFIG_PATH = path.join(__dirname, 'config.json');
const SENT_LOG_PATH = path.join(__dirname, 'sent.json');
let activeCrons = [];

// ── Config + send log persistence ────────────────────────────────────────────
// Config persists to GitHub repo (survives Railway restarts automatically)
async function loadConfigFromGitHub(cfg) {
  try {
    const user = cfg?.githubUser || process.env.GH_USER;
    const repo = cfg?.githubRepo || process.env.GH_REPO;
    const token = cfg?.githubToken || process.env.GH_TOKEN;
    if (!user || !repo || !token) return null;
    const url = `https://api.github.com/repos/${user}/${repo}/contents/_config.json`;
    const res = await fetch(url, { headers: { 'Authorization': 'token ' + token, 'User-Agent': 'IF-Studio' } });
    if (!res.ok) return null;
    const data = await res.json();
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    console.log('Config loaded from GitHub');
    return JSON.parse(content);
  } catch(e) { console.warn('GitHub config load failed:', e.message); return null; }
}

async function saveConfigToGitHub(cfg) {
  try {
    if (!cfg.githubUser || !cfg.githubRepo || !cfg.githubToken) return;
    const url = `https://api.github.com/repos/${cfg.githubUser}/${cfg.githubRepo}/contents/_config.json`;
    const b64 = Buffer.from(JSON.stringify(cfg, null, 2)).toString('base64');
    let sha;
    try {
      const existing = await fetch(url, { headers: { 'Authorization': 'token ' + cfg.githubToken, 'User-Agent': 'IF-Studio' } });
      if (existing.ok) sha = (await existing.json()).sha;
    } catch(e) {}
    const body = { message: 'IF Studio config update', content: b64 };
    if (sha) body.sha = sha;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': 'token ' + cfg.githubToken, 'Content-Type': 'application/json', 'User-Agent': 'IF-Studio' },
      body: JSON.stringify(body)
    });
    if (res.ok) console.log('Config saved to GitHub');
    else console.warn('GitHub config save failed:', res.status);
  } catch(e) { console.warn('GitHub config save failed:', e.message); }
}

function loadConfig() {
  try { if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch(e) { console.warn('Config file load failed:', e.message); }
  return null;
}

async function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  await saveConfigToGitHub(cfg);
  console.log('Config saved (local + GitHub)');
}

function loadSentLog() {
  try { if (fs.existsSync(SENT_LOG_PATH)) return JSON.parse(fs.readFileSync(SENT_LOG_PATH, 'utf8')); }
  catch(e) {}
  return {};
}
function saveSentLog(log) { fs.writeFileSync(SENT_LOG_PATH, JSON.stringify(log)); }

// Weekly dedup: returns true if this topic was already sent this ISO week
function alreadySentThisWeek(topic) {
  const log = loadSentLog();
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  const weekKey = now.getFullYear() + '-W' + weekNum + ':' + topic;
  if (log[weekKey]) return true;
  log[weekKey] = new Date().toISOString();
  // Clean old entries (keep last 200)
  const keys = Object.keys(log);
  if (keys.length > 200) { for (let i = 0; i < keys.length - 200; i++) delete log[keys[i]]; }
  saveSentLog(log);
  return false;
}

// ── Google OAuth (Gmail + Blogger) ───────────────────────────────────────────
function getOAuth(cfg) {
  const auth = new google.auth.OAuth2(cfg.gmailClientId, cfg.gmailClientSec, 'https://developers.google.com/oauthplayground');
  auth.setCredentials({ refresh_token: cfg.gmailRefreshTok });
  return auth;
}

// ── Gmail ────────────────────────────────────────────────────────────────────
async function sendEmail(cfg, subject, htmlBody, attachments) {
  const gmail = google.gmail({ version: 'v1', auth: getOAuth(cfg) });
  const boundary = 'boundary_' + Date.now();
  let raw = 'From: ' + cfg.email + '\r\n' + 'To: ' + cfg.email + '\r\n' +
    'Subject: ' + subject + '\r\nMIME-Version: 1.0\r\n' +
    'Content-Type: multipart/mixed; boundary=' + boundary + '\r\n\r\n' +
    '--' + boundary + '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' + htmlBody + '\r\n';
  for (const att of attachments) {
    raw += '--' + boundary + '\r\nContent-Type: ' + (att.type || 'text/html') + '; name="' + att.filename + '"\r\n' +
      'Content-Disposition: attachment; filename="' + att.filename + '"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + att.content + '\r\n';
  }
  raw += '--' + boundary + '--';
  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
}

// ── GitHub Pages ─────────────────────────────────────────────────────────────
async function pushToGitHub(cfg, filename, content, isBase64) {
  const url = `https://api.github.com/repos/${cfg.githubUser}/${cfg.githubRepo}/contents/${filename}`;
  const b64 = isBase64 ? content : Buffer.from(content).toString('base64');
  let sha;
  try {
    const existing = await fetch(url, { headers: { 'Authorization': 'token ' + cfg.githubToken, 'User-Agent': 'IF-Studio' } });
    if (existing.ok) sha = (await existing.json()).sha;
  } catch(e) {}
  const body = { message: 'Auto-publish: ' + filename, content: b64 };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': 'token ' + cfg.githubToken, 'Content-Type': 'application/json', 'User-Agent': 'IF-Studio' },
    body: JSON.stringify(body)
  });
  if (!res.ok) { console.warn('GitHub push failed:', res.status); return null; }
  const pagesUrl = `https://${cfg.githubUser}.github.io/${cfg.githubRepo}/${filename}`;
  console.log('Pushed to GitHub:', pagesUrl);
  return pagesUrl;
}

// ── PageShot Screenshot ──────────────────────────────────────────────────────
async function takeScreenshot(pageUrl) {
  console.log('Screenshotting:', pageUrl);
  try {
    await new Promise(r => setTimeout(r, 5000)); // Wait for GitHub Pages propagation
    const res = await fetch(`https://pageshot.site/v1/screenshot?url=${encodeURIComponent(pageUrl)}&format=png&width=1200&full_page=false`);
    if (!res.ok) { console.warn('PageShot failed:', res.status); return null; }
    const buffer = Buffer.from(await res.arrayBuffer());
    console.log('Screenshot:', buffer.length, 'bytes');
    return buffer;
  } catch(e) { console.warn('Screenshot failed:', e.message); return null; }
}

// ── Claude Article Writer (third-person, no em dashes, 700+ words) ──────────
async function writeArticle(cfg, topic, webLinks, userData, dashboardUrl) {
  console.log('Writing article for:', topic);
  try {
    const client = new Anthropic({ apiKey: cfg.anthropicKey });
    let sourceNote = '';
    if (webLinks && webLinks.length) {
      sourceNote = '\n\nCite these sources in the article naturally:\n' + webLinks.map(u => '- ' + u).join('\n');
    }
    let dataNote = '';
    if (userData) {
      const trimmed = userData.length > 3000 ? userData.slice(0, 3000) + '\n... [trimmed]' : userData;
      dataNote = '\n\nUSER-PROVIDED DATA — reference specific numbers, trends, and key figures from this dataset throughout the article, especially in the closing section:\n' + trimmed;
    }
    let dashNote = '';
    if (dashboardUrl) {
      dashNote = '\n\nAn interactive dashboard has been generated from this data and is available at: ' + dashboardUrl + '. Reference it naturally in the closing section.';
    }
    const prompt = `Write a blog article (4-6 paragraphs, at least 450 words) about "${topic}" to accompany a data infographic. Rules:
- Write in third-person narrative voice, like a news reporter covering the story
- NEVER use em dashes or en dashes (no — or –). Use commas, periods, or semicolons instead
- Open with an attention-grabbing hook
- Develop the topic with depth: context, background, and analysis
- Highlight 3-5 key insights or surprising facts with supporting detail
- Include a paragraph on implications or what experts say
- CLOSING SECTION (IMPORTANT): End with a "Key Highlights" wrap-up that summarizes the most striking data points from the dataset (cite specific numbers, percentages, or rankings). Then tie it to the interactive dashboard, encouraging the reader to explore the full visualization for deeper insights. This section should feel like a punchy executive summary of the data.
- Plain text only, no HTML tags, no markdown
- Conversational but informative
- IMPORTANT: the article MUST be at least 450 words. Do not cut it short.${sourceNote}${dataNote}${dashNote}`;
    console.log('Article prompt length:', prompt.length, 'chars');
    const r = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = r.content.map(b => b.type === 'text' ? b.text : '').join('');
    console.log('Article received:', text.length, 'chars, ~' + text.split(/\s+/).length, 'words');
    return text;
  } catch(e) { console.error('Article FAILED:', e.message); return null; }
}

// ── Blogger ──────────────────────────────────────────────────────────────────
async function postToBlogger(cfg, title, articleText, screenshotUrl, linkUrl, blogMode, blogImageUrls) {
  console.log('Posting to Blogger:', title, '| mode:', blogMode, '| images:', (blogImageUrls || []).length);
  try {
    const blogger = google.blogger({ version: 'v3', auth: getOAuth(cfg) });
    const linkLabel = blogMode === 'sdp' ? 'Download the GUUT Project File (.sdp)' : 'Explore the Full Story \u2192';

    // Hero image: first blog image if available, otherwise the PageShot screenshot
    const heroUrl = (blogImageUrls && blogImageUrls.length) ? blogImageUrls[0] : screenshotUrl;
    const remainingImages = (blogImageUrls && blogImageUrls.length > 1) ? blogImageUrls.slice(1) : [];

    // Split article into paragraphs
    const paragraphs = articleText.split('\n\n').map(p => p.trim()).filter(Boolean);

    // Build article body with images woven between paragraphs
    let articleHtml = '';
    let imgIdx = 0;
    for (let pi = 0; pi < paragraphs.length; pi++) {
      articleHtml += '<p>' + paragraphs[pi] + '</p>\n';
      // After each paragraph (except the last), insert a remaining image if available
      if (imgIdx < remainingImages.length && pi < paragraphs.length - 1) {
        articleHtml += '<div style="text-align:center;margin:20px 0;">' +
          '<img src="' + remainingImages[imgIdx] + '" style="max-width:100%;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);" />' +
          '</div>\n';
        imgIdx++;
      }
    }
    // Any leftover images go after the last paragraph
    while (imgIdx < remainingImages.length) {
      articleHtml += '<div style="text-align:center;margin:20px 0;">' +
        '<img src="' + remainingImages[imgIdx] + '" style="max-width:100%;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);" />' +
        '</div>\n';
      imgIdx++;
    }

    const htmlContent = `
      <div style="font-family:'Times New Roman',Times,Georgia,serif;font-size:18px;line-height:1.8;color:#222;">
        <div style="text-align:center;margin-bottom:24px;">
          <a href="${linkUrl}" target="_blank">
            <img src="${heroUrl}" alt="${title}" style="max-width:100%;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.15);" />
          </a>
        </div>
        ${articleHtml}
        <p style="margin-top:28px;padding:16px;background:#f0f7ff;border-radius:8px;text-align:center;font-family:sans-serif;font-size:15px;">
          <strong><a href="${linkUrl}" target="_blank">${linkLabel}</a></strong>
        </p>
      </div>`;
    const res = await blogger.posts.insert({
      blogId: cfg.blogId,
      requestBody: { title, content: htmlContent, labels: ['infographic', 'data', 'automated'] }
    });
    console.log('Blogger published:', res.data.url);
    return res.data.url;
  } catch(e) { console.warn('Blogger failed:', e.message); return null; }
}

// ── GUUT MCP conversion ─────────────────────────────────────────────────────
async function convertToGUUT(html) {
  console.log('Converting to GUUT...');
  try {
    const mcpUrl = 'https://guutit.app/mcp';
    const hdr = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    const initRes = await fetch(mcpUrl, { method: 'POST', headers: hdr, body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'IF-Studio', version: '4.0' } }
    })});
    if (!initRes.ok) return null;
    const sid = initRes.headers.get('mcp-session-id') || '';
    const sHdr = { ...hdr }; if (sid) sHdr['mcp-session-id'] = sid;
    await fetch(mcpUrl, { method: 'POST', headers: sHdr, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const res = await fetch(mcpUrl, { method: 'POST', headers: sHdr, body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'convert_html_to_project', arguments: { html, name: 'Infographic' } }
    })});
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    let result;
    if (ct.includes('text/event-stream')) {
      for (const line of (await res.text()).split('\n'))
        if (line.startsWith('data: ')) try { result = JSON.parse(line.slice(6)); } catch(e) {}
    } else result = await res.json();
    if (result?.result?.content) for (const item of result.result.content)
      if (item.text) { console.log('GUUT received:', item.text.length, 'chars'); return item.text; }
  } catch(e) { console.warn('GUUT failed:', e.message); }
  return null;
}

// ── Main pipeline ───────────────────────────────────────────────────────────
async function runTopic(cfg, entry) {
  if (alreadySentThisWeek(entry.topic)) { console.log('Already sent this week:', entry.topic); return; }
  console.log('=== Pipeline:', entry.topic, '===');
  const blogMode = entry.blogMode || cfg.blogMode || 'html';

  // 1. Generate infographic
  const client = new Anthropic({ apiKey: cfg.anthropicKey });
  const dataNote = entry.data
    ? '\n\nUSER-PROVIDED DATA — use ONLY these values:\n' + entry.data
    : '\n\nUse your own knowledge for accurate statistics. Cite real sources in the footer.';

  // Fetch web links if provided
  let webNote = '';
  if (entry.webLinks && entry.webLinks.length) {
    console.log('Fetching', entry.webLinks.length, 'web links...');
    for (const url of entry.webLinks.slice(0, 5)) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'IF-Studio-Bot/1.0' } });
        if (res.ok) {
          let text = await res.text();
          // Strip HTML tags, keep text content (rough extraction)
          text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          // Limit to ~10K chars per source
          if (text.length > 10000) text = text.slice(0, 10000) + '... [truncated]';
          webNote += '\n\nSOURCE: ' + url + '\n' + text;
          console.log('Fetched:', url, text.length, 'chars');
        }
      } catch(e) { console.warn('Failed to fetch:', url, e.message); }
    }
    if (webNote) webNote = '\n\nWEB SOURCES — use facts from these and cite them in the footer:' + webNote;
  }

  const r = await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 32000,
    messages: [{ role: 'user', content: 'Generate a stunning HTML infographic about: "' + entry.topic + '".' + dataNote + webNote + ' Dark data theme, grid layout, hero stats, SVG charts (VBAR, HBAR, DONUT, LINE). No user images, use SVG illustrations. Max 4-5 chart sections. Always end with </body></html>. Output ONLY raw HTML.' }]
  });
  let h = r.content.map(b => b.type === 'text' ? b.text : '').join('');
  h = h.replace(/^```html\s*/i, '').replace(/```\s*$/, '').trim();
  if (!h.includes('</html>')) h += '\n</div></div></body></html>';
  const slug = entry.topic.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
  console.log('1/6 Infographic:', h.length, 'chars');

  // 2. Push HTML to GitHub Pages
  let htmlUrl = null;
  if (cfg.githubUser && cfg.githubRepo && cfg.githubToken) {
    htmlUrl = await pushToGitHub(cfg, slug + '.html', h, false);
  }
  console.log('2/6 GitHub HTML:', htmlUrl || 'skipped');

  // 3. GUUT conversion + push SDP to GitHub
  const guut = await convertToGUUT(h);
  let sdpUrl = null;
  if (guut && cfg.githubUser && cfg.githubRepo && cfg.githubToken) {
    sdpUrl = await pushToGitHub(cfg, slug + '.sdp', guut, false);
  }
  console.log('3/6 GUUT+GitHub SDP:', sdpUrl || 'skipped');

  // 4. Screenshot
  let screenshotUrl = null;
  if (htmlUrl) {
    const buf = await takeScreenshot(htmlUrl);
    if (buf) screenshotUrl = await pushToGitHub(cfg, slug + '.png', buf.toString('base64'), true);
  }
  console.log('4/6 Screenshot:', screenshotUrl || 'skipped');

  // 5. Article + Blog images + Blogger
  let blogUrl = null;
  let article = null;
  try {
    if (cfg.blogId && screenshotUrl) {
      article = await writeArticle(cfg, entry.topic, entry.webLinks, entry.data || null, htmlUrl);

      // Push blog images to GitHub if provided (base64 strings from config)
      let blogImageUrls = [];
      if (entry.blogImages && entry.blogImages.length && cfg.githubUser) {
        for (let bi = 0; bi < entry.blogImages.length; bi++) {
          const imgData = entry.blogImages[bi];
          const imgUrl = await pushToGitHub(cfg, slug + '-blog-' + (bi+1) + '.jpg', imgData, true);
          if (imgUrl) blogImageUrls.push(imgUrl);
        }
        console.log('Blog images pushed:', blogImageUrls.length);
      }

      if (article) {
        const linkUrl = blogMode === 'sdp' && sdpUrl ? sdpUrl : htmlUrl;
        blogUrl = await postToBlogger(cfg, entry.topic, article, screenshotUrl, linkUrl, blogMode, blogImageUrls);
      }
    }
  } catch(e) { console.error('Step 5 (article/blogger) failed:', e.message); }
  console.log('5/6 Blogger:', blogUrl || 'skipped');

  // 6. Email (always runs, even if blogger failed)
  try {
    const attachments = [{ filename: slug + '.html', content: Buffer.from(h).toString('base64'), type: 'text/html' }];
    if (guut) attachments.push({ filename: slug + '.sdp', content: Buffer.from(guut).toString('base64'), type: 'application/json' });
    let emailBody = '<h2>' + entry.topic + '</h2>';
    if (blogUrl) emailBody += '<p>Blog: <a href="' + blogUrl + '">' + blogUrl + '</a></p>';
    if (htmlUrl) emailBody += '<p>Interactive: <a href="' + htmlUrl + '">' + htmlUrl + '</a></p>';
    if (sdpUrl) emailBody += '<p>GUUT: <a href="' + sdpUrl + '">' + sdpUrl + '</a></p>';
    emailBody += '<p>Attachments: HTML' + (guut ? ' + SDP' : '') + '</p>';
    await sendEmail(cfg, 'Your Infographic: ' + entry.topic, emailBody, attachments);
    console.log('6/6 Email sent');
  } catch(e) { console.error('Step 6 (email) FAILED:', e.message); }
  console.log('=== Done:', entry.topic, '===');
}

// ── Cron scheduling ─────────────────────────────────────────────────────────
let paused = false;

function scheduleCrons(cfg) {
  activeCrons.forEach(c => c.stop()); activeCrons = [];
  paused = false;
  if (!cfg?.schedule?.length) { console.log('No schedule'); return; }
  const hr = cfg.hour || '09', min = cfg.minute || '00';
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  cfg.schedule.forEach(entry => {
    if (entry.enabled === false) { console.log('Disabled:', entry.topic); return; }
    const job = cron.schedule(min + ' ' + hr + ' * * ' + entry.dow, () => {
      if (paused) { console.log('Paused, skipping:', entry.topic); return; }
      runTopic(cfg, entry).catch(e => console.error('Pipeline failed:', e.message));
    }, { timezone: 'America/New_York' });
    activeCrons.push(job);
    console.log('Scheduled:', entry.topic, days[entry.dow], hr + ':' + min, 'EST');
  });
}

// ── API ─────────────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  const cfg = loadConfig();
  res.json({ status: 'online', configured: !!cfg, topics: cfg?.schedule?.map(s => s.topic) || [],
    activeCrons: activeCrons.length, github: !!(cfg?.githubToken), blogger: !!(cfg?.blogId), uptime: process.uptime() });
});

app.post('/config', async (req, res) => {
  try {
    const cfg = req.body;
    if (!cfg.anthropicKey || !cfg.email || !cfg.gmailClientId || !cfg.gmailClientSec || !cfg.gmailRefreshTok)
      return res.status(400).json({ error: 'Missing required credentials' });
    if (!cfg.schedule?.length) return res.status(400).json({ error: 'No topics scheduled' });
    await saveConfig(cfg); scheduleCrons(cfg);
    res.json({ success: true, topics: cfg.schedule.map(s => s.topic), crons: activeCrons.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/pause', (req, res) => {
  paused = true;
  console.log('All crons paused');
  res.json({ status: 'paused', activeCrons: activeCrons.length });
});

app.post('/resume', (req, res) => {
  const cfg = loadConfig();
  if (!cfg) return res.status(400).json({ error: 'No config' });
  paused = false;
  console.log('Crons resumed');
  res.json({ status: 'resumed', crons: activeCrons.length });
});

app.post('/trigger', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg) return res.status(400).json({ error: 'No config' });
  const entry = cfg.schedule[parseInt(req.body.index || '0')];
  if (!entry) return res.status(400).json({ error: 'Invalid index' });
  res.json({ status: 'generating', topic: entry.topic });
  runTopic(cfg, entry).catch(e => console.error('Trigger failed:', e.message));
});

// ── Self-ping keep-alive (prevents Railway sleep) ──────────────────────────
function startKeepAlive() {
  const url = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/status`
    : `http://localhost:${process.env.PORT || 3000}/status`;
  const interval = 4 * 60 * 1000; // ping every 4 minutes
  setInterval(async () => {
    try {
      const res = await fetch(url);
      if (res.ok) console.log('Keep-alive ping OK');
      else console.warn('Keep-alive ping failed:', res.status);
    } catch(e) { console.warn('Keep-alive ping error:', e.message); }
  }, interval);
  console.log('Keep-alive enabled: pinging', url, 'every 4 min');
}

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('IF Studio Scheduler v4.1 on port', PORT);
  let cfg = loadConfig();
  // If no local config (post-restart), try loading from GitHub
  if (!cfg && (process.env.GH_USER || process.env.GH_TOKEN)) {
    cfg = await loadConfigFromGitHub({ githubUser: process.env.GH_USER, githubRepo: process.env.GH_REPO, githubToken: process.env.GH_TOKEN });
    if (cfg) {
      try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch(e) {}
    }
  }
  // Also try with stored credentials from config itself
  if (!cfg) cfg = await loadConfigFromGitHub({});
  if (cfg) { scheduleCrons(cfg); console.log('Loaded', cfg.schedule?.length || 0, 'topics'); }
  else console.log('Waiting for config from IF Studio');
  startKeepAlive();
});
