const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit
});

const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB cap for video URL downloads

// ── Google OAuth config (Drive + Calendar) ─────────────────────
// Set these as Railway env vars. GOOGLE_REDIRECT_URI must exactly match
// an "Authorized redirect URI" on your OAuth client in Google Cloud Console,
// and should point back at THIS backend: https://your-app.railway.app/api/google/callback
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar',
].join(' ');

// ── Video frame extraction ─────────────────────────────────────
// Writes a video buffer to a temp file, samples ~1 frame/sec via ffmpeg
// (ffmpeg-static bundles the binary — nothing to install on Railway),
// and returns base64 JPEG frames for Claude's vision endpoint.
async function extractVideoFrames(buffer, maxFrames = 10) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  const videoPath = path.join(tmpDir, 'input.mp4');
  fs.writeFileSync(videoPath, buffer);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .outputOptions(['-vf', 'fps=1', '-frames:v', String(maxFrames)])
        .output(path.join(tmpDir, 'frame_%02d.jpg'))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const frameFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('frame_')).sort();
    if (frameFiles.length === 0) throw new Error('No frames could be extracted — is this a valid video file?');

    return frameFiles.map(f => fs.readFileSync(path.join(tmpDir, f)).toString('base64'));
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

// ── Download a direct video file URL into a buffer, with safety checks ──
async function downloadVideoBuffer(url) {
  const vidResp = await fetch(url);
  if (!vidResp.ok) throw new Error(`Could not download video (HTTP ${vidResp.status})`);

  const contentType = vidResp.headers.get('content-type') || '';
  if (!contentType.startsWith('video/')) {
    throw new Error(`That isn't a direct video file link (got "${contentType || 'unknown'}"). Page links like YouTube/TikTok can't be downloaded server-side — ask the user to upload the file instead.`);
  }

  const contentLength = Number(vidResp.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_VIDEO_BYTES) {
    throw new Error('Video is too large (max 50MB for URL analysis)');
  }

  const arrayBuffer = await vidResp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > MAX_VIDEO_BYTES) throw new Error('Video is too large (max 50MB for URL analysis)');
  return buffer;
}

// ── Webpage analysis now runs through Anthropic's native web_fetch tool
// (see /api/analyze-link and the chat tool loop) — no custom scraper needed.

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'My Assistant', timestamp: new Date().toISOString() });
});

// ── Google OAuth — Drive + Calendar ─────────────────────────────
// Step 1: frontend opens this in a popup. We redirect straight to Google's
// consent screen (no separate "get the URL" round trip needed).
app.get('/api/google/connect', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
    return res.status(500).send('Google OAuth is not configured on this backend. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in Railway.');
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',   // required to get a refresh_token
    prompt: 'consent',        // forces refresh_token on every connect, not just the first time
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// Step 2: Google redirects back here with ?code=... We exchange it for tokens,
// then hand them to the opener window via postMessage and close the popup —
// the standard OAuth popup pattern for single-page apps with no backend session.
app.get('/api/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<script>window.opener && window.opener.postMessage({ type: 'google-auth-error', error: ${JSON.stringify(String(error))} }, '*'); window.close();</script>`);
  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenResp.json();
    if (!tokenResp.ok) throw new Error(tokens.error_description || tokens.error || 'Token exchange failed');

    const payload = JSON.stringify({
      type: 'google-auth',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresIn: tokens.expires_in,
    });
    res.send(`<script>window.opener && window.opener.postMessage(${payload}, '*'); window.close();</script>`);
  } catch (err) {
    res.send(`<script>window.opener && window.opener.postMessage({ type: 'google-auth-error', error: ${JSON.stringify(err.message)} }, '*'); window.close();</script>`);
  }
});

// Get a fresh access_token from a stored refresh_token (access tokens expire ~1hr)
async function refreshGoogleToken(refreshToken) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error_description || data.error || 'Token refresh failed');
  return data.access_token;
}

app.post('/api/google/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  try {
    const accessToken = await refreshGoogleToken(refreshToken);
    res.json({ accessToken });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// Calls a Google API URL with the user's access token. On 401 (expired token),
// refreshes once using the refresh token and retries — and if `res` (the SSE
// stream) is passed, tells the frontend about the new token so it can update
// what's stored in Settings.
async function googleApiCall(url, options, googleTokens, res) {
  const doFetch = (token) => fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });

  let resp = await doFetch(googleTokens.accessToken);
  if (resp.status === 401 && googleTokens.refreshToken) {
    const newToken = await refreshGoogleToken(googleTokens.refreshToken).catch(() => null);
    if (!newToken) throw new Error('Google session expired — reconnect Google in Settings.');
    googleTokens.accessToken = newToken;
    if (res) res.write(`data: ${JSON.stringify({ type: 'google_token_refreshed', accessToken: newToken })}\n\n`);
    resp = await doFetch(newToken);
  }
  return resp;
}

async function searchDriveFiles(query, googleTokens, res) {
  const params = new URLSearchParams({
    q: `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
    pageSize: '10',
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
  });
  const resp = await googleApiCall(`https://www.googleapis.com/drive/v3/files?${params}`, {}, googleTokens, res);
  if (!resp.ok) throw new Error(`Drive search failed (HTTP ${resp.status})`);
  const data = await resp.json();
  return (data.files || []).map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, modified: f.modifiedTime, link: f.webViewLink }));
}

const GOOGLE_EXPORT_MIME = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

async function readDriveFile(fileId, googleTokens, res) {
  const metaResp = await googleApiCall(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size`, {}, googleTokens, res);
  if (!metaResp.ok) throw new Error(`Could not get file info (HTTP ${metaResp.status})`);
  const meta = await metaResp.json();

  let textContent;
  if (GOOGLE_EXPORT_MIME[meta.mimeType]) {
    const exportResp = await googleApiCall(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(GOOGLE_EXPORT_MIME[meta.mimeType])}`,
      {}, googleTokens, res
    );
    if (!exportResp.ok) throw new Error(`Could not export file (HTTP ${exportResp.status})`);
    textContent = await exportResp.text();
  } else {
    const size = Number(meta.size || 0);
    if (size && size > 5 * 1024 * 1024) throw new Error('File too large to read directly (max 5MB) — try a Google Doc/Sheet instead');
    const downloadResp = await googleApiCall(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {}, googleTokens, res);
    if (!downloadResp.ok) throw new Error(`Could not download file (HTTP ${downloadResp.status})`);
    textContent = await downloadResp.text();
  }
  return { name: meta.name, content: textContent.slice(0, 20000) };
}

async function listCalendarEvents(timeMin, timeMax, googleTokens, res) {
  const params = new URLSearchParams({
    timeMin: timeMin || new Date().toISOString(),
    maxResults: '20',
    singleEvents: 'true',
    orderBy: 'startTime',
  });
  if (timeMax) params.set('timeMax', timeMax);
  const resp = await googleApiCall(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {}, googleTokens, res);
  if (!resp.ok) throw new Error(`Calendar list failed (HTTP ${resp.status})`);
  const data = await resp.json();
  return (data.items || []).map(e => ({
    title: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || '',
  }));
}

async function createCalendarEvent({ title, startTime, endTime, description }, googleTokens, res) {
  const resp = await googleApiCall('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: title,
      description: description || '',
      start: { dateTime: startTime },
      end: { dateTime: endTime },
    }),
  }, googleTokens, res);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Could not create event (HTTP ${resp.status})`);
  }
  const data = await resp.json();
  return { id: data.id, link: data.htmlLink };
}

// ── Tools Claude can choose to use on its own ──────────────────
const CLAUDE_TOOLS = [
  {
    name: 'generate_image',
    description: 'Generate an image from a text description. Use this whenever the user asks to see, create, draw, generate, make, or imagine a picture/image/photo/artwork/illustration of something.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'A detailed visual description of the image to generate' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'analyze_video_link',
    description: 'Download and analyze a direct video file URL (one that ends in .mp4, .mov, .webm, etc. and serves the raw video bytes). Only works for direct file links — NOT YouTube/TikTok/Vimeo page URLs, which block server-side downloads. If a direct link fails or the user shared a page URL instead, tell them to upload the video file directly.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The direct video file URL' }
      },
      required: ['url']
    }
  },
  {
    name: 'search_drive_files',
    description: "Search the user's Google Drive by filename/content. Only use this if the user has connected Google in Settings — if a call fails with an auth error, tell them to connect Google.",
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search text' } },
      required: ['query']
    }
  },
  {
    name: 'read_drive_file',
    description: "Read the text content of a specific Google Drive file (Docs, Sheets, Slides, or plain text files) by its file ID, usually obtained from search_drive_files first.",
    input_schema: {
      type: 'object',
      properties: { fileId: { type: 'string', description: 'The Google Drive file ID' } },
      required: ['fileId']
    }
  },
  {
    name: 'list_calendar_events',
    description: "List the user's upcoming Google Calendar events. Use this for questions like 'what's on my calendar' or 'am I free tomorrow'.",
    input_schema: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'ISO 8601 start of range. Defaults to now if omitted.' },
        timeMax: { type: 'string', description: 'ISO 8601 end of range. Optional.' }
      }
    }
  },
  {
    name: 'create_calendar_event',
    description: "Create a new event on the user's Google Calendar.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        startTime: { type: 'string', description: 'ISO 8601 datetime' },
        endTime: { type: 'string', description: 'ISO 8601 datetime' },
        description: { type: 'string' }
      },
      required: ['title', 'startTime', 'endTime']
    }
  }
];

// Anthropic's own server tools — run on Anthropic's infrastructure with just
// the API key (no Brave/third-party key needed). Claude decides on its own
// when to search the web or fetch a URL the user has shared, and the results
// (with citations) come back in the same response.
const SERVER_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
  { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5, citations: { enabled: true } },
  { type: 'code_execution_20250825', name: 'code_execution' },
];

// Beta headers needed for the server tools above — web_fetch, code execution
// (with bash + file output), the Files API used to download files code
// execution creates (charts, CSVs, etc), and Agent Skills (real Word/
// PowerPoint/Excel/PDF generation via the code execution sandbox).
const BETA_HEADERS = 'web-fetch-2025-09-10,code-execution-2025-08-25,files-api-2025-04-14,skills-2025-10-02';

// Anthropic's pre-built document Skills. Listing all four lets Claude pick
// the right one for the request (a doc vs a deck vs a spreadsheet) on its own.
const SKILLS_CONTAINER = {
  skills: [
    { type: 'anthropic', skill_id: 'docx', version: 'latest' },
    { type: 'anthropic', skill_id: 'pptx', version: 'latest' },
    { type: 'anthropic', skill_id: 'xlsx', version: 'latest' },
    { type: 'anthropic', skill_id: 'pdf', version: 'latest' },
  ],
};

// Current per-million-token pricing (USD). Used to show real cost per
// message instead of leaving usage a mystery. Update if Anthropic changes
// pricing — check https://platform.claude.com/docs/en/about-claude/pricing
const MODEL_PRICING = {
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

function estimateCostUsd(model, usage) {
  const p = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-4-6'];
  return (
    ((usage.input_tokens || 0) / 1e6) * p.input +
    ((usage.output_tokens || 0) / 1e6) * p.output +
    ((usage.cache_creation_input_tokens || 0) / 1e6) * p.cacheWrite +
    ((usage.cache_read_input_tokens || 0) / 1e6) * p.cacheRead +
    (usage.web_search_count || 0) * 0.01 // billed per query, separately from tokens — was missing entirely before
  );
}

// ── Files API — download a file a code_execution run created ──
async function fetchGeneratedFile(fileId, apiKey) {
  const metaResp = await fetch(`https://api.anthropic.com/v1/files/${fileId}`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA_HEADERS },
  });
  if (!metaResp.ok) throw new Error(`Could not get file metadata (HTTP ${metaResp.status})`);
  const meta = await metaResp.json();

  const contentResp = await fetch(`https://api.anthropic.com/v1/files/${fileId}/content`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA_HEADERS },
  });
  if (!contentResp.ok) throw new Error(`Could not download file (HTTP ${contentResp.status})`);
  const arrayBuffer = await contentResp.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  return { filename: meta.filename || fileId, mimeType: meta.mime_type || 'application/octet-stream', base64 };
}

// Recursively dig through a code_execution_tool_result block for any
// {file_id: ...} entries — the exact nesting can vary between the bash and
// plain-python execution result shapes, so we search rather than assume one path.
function findFileIds(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (typeof node.file_id === 'string') found.push(node.file_id);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) val.forEach(v => findFileIds(v, found));
    else if (val && typeof val === 'object') findFileIds(val, found);
  }
  return found;
}

// ── Chat with streaming + automatic tool use (no manual mode toggles) ──
app.post('/api/chat', async (req, res) => {
  const { messages, apiKey, model, systemPrompt, extendedThinking, googleAccessToken, googleRefreshToken } = req.body;

  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Messages array required' });

  const selectedModel = model || 'claude-sonnet-4-6';

  const systemContent = systemPrompt || `You are a helpful, knowledgeable AI assistant. You can write code, analyze files, search the web, fetch and read links, generate images, run real Python/bash code in a sandbox to do math, analyze data, and create files like charts or CSVs, create real Word documents/PowerPoint presentations/Excel spreadsheets/PDFs when asked, and answer questions across any topic. If the user has connected Google, you can also search their Drive and check/create Calendar events. Decide on your own, without being asked, whether a request needs an image generated, the web searched, a link read, code executed, a document created, or Google Drive/Calendar checked — use the tools available to you automatically when they would help answer better. When writing a standalone HTML page, SVG, Mermaid diagram, or single-file React component, the frontend renders it live in a preview panel — for React, write a single default-exported component with no external npm imports beyond React itself (hooks are available as globals), since there is no bundler. Be clear, direct, and accurate. When writing code, always use proper markdown code blocks with language tags. Format responses using markdown where it aids readability.`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Mutable wrapper — googleApiCall() updates .accessToken in place on refresh
  const googleTokens = { accessToken: googleAccessToken || null, refreshToken: googleRefreshToken || null };

  // Mark everything before the newest message as cacheable. On a long
  // back-and-forth (like building a landing page over several turns), this
  // stops every message from re-billing the entire prior conversation.
  const messagesCopy = [...messages];
  if (messagesCopy.length >= 2) {
    const priorTurnEnd = messagesCopy[messagesCopy.length - 2];
    if (typeof priorTurnEnd.content === 'string') {
      priorTurnEnd.content = [{ type: 'text', text: priorTurnEnd.content, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(priorTurnEnd.content) && priorTurnEnd.content.length > 0) {
      priorTurnEnd.content = [...priorTurnEnd.content];
      const lastBlock = { ...priorTurnEnd.content[priorTurnEnd.content.length - 1] };
      lastBlock.cache_control = { type: 'ephemeral' };
      priorTurnEnd.content[priorTurnEnd.content.length - 1] = lastBlock;
    }
  }

  try {
    await runAgenticTurn({
      apiKey, model: selectedModel, systemContent, messages: messagesCopy, res,
      extendedThinking: !!extendedThinking, googleTokens,
    });
    res.end();
  } catch (err) {
    console.error('Chat error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

// Calls the Anthropic API with stream:true and parses the SSE response as it
// arrives, forwarding text/thinking word-by-word to the frontend in real time
// via onTextDelta/onThinkingDelta — instead of waiting for the entire
// response to finish generating server-side before sending anything back.
// Returns the fully assembled content blocks (same shape the non-streaming
// API would have returned) once the stream ends, so the rest of the tool
// loop can keep working with it unchanged.
async function streamAnthropicMessage(requestBody, apiKey, res, onTextDelta, onThinkingDelta) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADERS,
    },
    body: JSON.stringify({ ...requestBody, stream: true }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    let message = 'Anthropic API error';
    try { message = JSON.parse(errBody).error?.message || message; } catch { message = errBody || message; }
    throw new Error(message);
  }

  const blocks = [];
  let stopReason = null;
  let buffer = '';
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  // While we're waiting on Anthropic (e.g. a slow code_execution run, or a
  // big thinking budget with a quiet stretch before output starts), our own
  // connection to the frontend would otherwise go silent too — and the
  // frontend has its own stall-timeout that would wrongly treat a perfectly
  // healthy slow request as dead, forcing a separately-billed retry. A
  // periodic harmless ping keeps that timer reset for as long as we're
  // genuinely still working.
  const keepAlive = setInterval(() => {
    try { res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`); } catch {}
  }, 15000);

  try {
  for await (const chunk of response.body) {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // keep any partial line for the next chunk

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw) continue;

      let evt;
      try { evt = JSON.parse(raw); } catch { continue; }

      if (evt.type === 'message_start' && evt.message?.usage) {
        usage.input_tokens = evt.message.usage.input_tokens || 0;
        usage.cache_creation_input_tokens = evt.message.usage.cache_creation_input_tokens || 0;
        usage.cache_read_input_tokens = evt.message.usage.cache_read_input_tokens || 0;
      } else if (evt.type === 'message_delta' && evt.usage) {
        usage.output_tokens = evt.usage.output_tokens || usage.output_tokens;
      }

      if (evt.type === 'content_block_start') {
        const block = { ...evt.content_block };
        if (block.type === 'tool_use' || block.type === 'server_tool_use') block._partialJson = '';
        blocks[evt.index] = block;
      } else if (evt.type === 'content_block_delta') {
        const block = blocks[evt.index];
        if (!block) continue;
        if (evt.delta.type === 'text_delta') {
          block.text = (block.text || '') + evt.delta.text;
          if (onTextDelta) onTextDelta(evt.delta.text);
        } else if (evt.delta.type === 'thinking_delta') {
          block.thinking = (block.thinking || '') + evt.delta.thinking;
          if (onThinkingDelta) onThinkingDelta(evt.delta.thinking);
        } else if (evt.delta.type === 'signature_delta') {
          // Thinking blocks carry a signature Anthropic uses to verify they
          // weren't tampered with. It streams in separately from the thinking
          // text itself, right before the block closes — has to be captured
          // and preserved intact, or the API rejects the block on the next
          // round with "Invalid signature in thinking block".
          block.signature = (block.signature || '') + (evt.delta.signature || '');
        } else if (evt.delta.type === 'input_json_delta') {
          block._partialJson = (block._partialJson || '') + (evt.delta.partial_json || '');
        } else if (evt.delta.type === 'citations_delta') {
          block.citations = block.citations || [];
          block.citations.push(evt.delta.citation);
        }
      } else if (evt.type === 'content_block_stop') {
        const block = blocks[evt.index];
        if (block && block._partialJson !== undefined) {
          try { block.input = JSON.parse(block._partialJson || '{}'); } catch { block.input = {}; }
          delete block._partialJson;
        }
      } else if (evt.type === 'message_delta') {
        if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
      } else if (evt.type === 'error') {
        throw new Error(evt.error?.message || 'Stream error');
      }
    }
  }
  } finally {
    clearInterval(keepAlive);
  }

  return { content: blocks.filter(Boolean), stop_reason: stopReason, usage };
}

// Runs one turn, letting Claude call tools as many times as it wants before giving a final text answer.
async function runAgenticTurn({ apiKey, model, systemContent, messages, res, extendedThinking, googleTokens }) {
  const MAX_TOOL_ROUNDS = 4;
  const totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_count: 0 };
  const sendUsage = () => {
    res.write(`data: ${JSON.stringify({
      type: 'usage',
      usage: totalUsage,
      estimatedCostUsd: estimateCostUsd(model, totalUsage),
    })}\n\n`);
  };

  // The system prompt and tool definitions are byte-identical on every
  // single request — every round of every turn, for every user. Marking
  // them as cacheable means Anthropic charges full price once and ~90%
  // less on every repeat within the cache window (~5 min), instead of
  // re-billing the same ~1-2k tokens of system+tools on every message.
  const cachedTools = [...CLAUDE_TOOLS, ...SERVER_TOOLS];
  cachedTools[cachedTools.length - 1] = {
    ...cachedTools[cachedTools.length - 1],
    cache_control: { type: 'ephemeral' },
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const requestBody = {
      model,
      max_tokens: extendedThinking ? 16000 : 12000,
      system: [{ type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } }],
      messages,
      tools: cachedTools,
      container: SKILLS_CONTAINER,
    };
    if (extendedThinking) {
      requestBody.thinking = { type: 'enabled', budget_tokens: 6000 };
    }

    const data = await streamAnthropicMessage(
      requestBody,
      apiKey,
      res,
      (textDelta) => res.write(`data: ${JSON.stringify({ type: 'text', text: textDelta })}\n\n`),
      (thinkingDelta) => res.write(`data: ${JSON.stringify({ type: 'thinking', text: thinkingDelta })}\n\n`)
    );

    const textBlocks = data.content.filter(b => b.type === 'text');
    const toolUseBlocks = data.content.filter(b => b.type === 'tool_use'); // client tools only
    const serverToolUseBlocks = data.content.filter(b => b.type === 'server_tool_use'); // web_search/web_fetch — already resolved

    totalUsage.input_tokens += data.usage.input_tokens || 0;
    totalUsage.output_tokens += data.usage.output_tokens || 0;
    totalUsage.cache_creation_input_tokens += data.usage.cache_creation_input_tokens || 0;
    totalUsage.cache_read_input_tokens += data.usage.cache_read_input_tokens || 0;

    // Let the frontend show "searching"/"reading link"/"running code" status
    // for the native server tools — Anthropic already ran them server-side
    // before this response came back, so there's nothing for us to execute.
    for (const block of serverToolUseBlocks) {
      if (block.name === 'web_search') {
        totalUsage.web_search_count += 1;
        res.write(`data: ${JSON.stringify({ type: 'tool_start', tool: 'web_search', input: { query: block.input.query } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'search_done', query: block.input.query })}\n\n`);
      } else if (block.name === 'web_fetch') {
        res.write(`data: ${JSON.stringify({ type: 'tool_start', tool: 'analyze_link', input: { url: block.input.url } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'link_done', url: block.input.url })}\n\n`);
      } else if (block.name === 'code_execution') {
        res.write(`data: ${JSON.stringify({ type: 'tool_start', tool: 'code_execution', input: {} })}\n\n`);
      }
    }

    // Pull out any files code execution created (charts, CSVs, generated
    // documents...) and stream them down as base64 so the frontend can show
    // or offer them for download, same as a generated image.
    const codeResultBlocks = data.content.filter(b => typeof b.type === 'string' && b.type.includes('code_execution_tool_result'));
    if (codeResultBlocks.length) {
      res.write(`data: ${JSON.stringify({ type: 'code_done' })}\n\n`);
      for (const block of codeResultBlocks) {
        const fileIds = findFileIds(block);
        for (const fileId of fileIds) {
          try {
            const file = await fetchGeneratedFile(fileId, apiKey);
            res.write(`data: ${JSON.stringify({ type: 'generated_file', ...file })}\n\n`);
          } catch (e) {
            console.error('File download error:', e.message);
          }
        }
      }
    }

    // Surface citations (from web_search / web_fetch) as a simple source list
    const citationSources = [];
    for (const block of textBlocks) {
      (block.citations || []).forEach(c => {
        if (c.url && !citationSources.find(s => s.url === c.url)) {
          citationSources.push({ url: c.url, title: c.title || c.url });
        }
      });
    }
    if (citationSources.length) {
      res.write(`data: ${JSON.stringify({ type: 'citations', sources: citationSources })}\n\n`);
    }

    if (toolUseBlocks.length === 0) {
      if (data.stop_reason === 'pause_turn') {
        // Long-running server-side work isn't finished yet — this shows up
        // with Skills (a multi-step document build can outrun one turn).
        // Resend the content as-is so Claude can keep going.
        messages.push({ role: 'assistant', content: data.content });
        continue;
      }
      // No client tools requested — final answer, we're done
      // (any web_search/web_fetch/code_execution use already happened server-side above)
      sendUsage();
      return;
    }

    // Claude wants to use a client-executed tool (image gen / video link).
    // Preserve the full content array — including thinking and any server
    // tool blocks — exactly as required when continuing the conversation.
    messages.push({ role: 'assistant', content: data.content });

    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      res.write(`data: ${JSON.stringify({ type: 'tool_start', tool: toolUse.name, input: toolUse.input })}\n\n`);

      if (toolUse.name === 'generate_image') {
        try {
          const imageData = await generateImage(toolUse.input.prompt);
          res.write(`data: ${JSON.stringify({ type: 'image', image: imageData, prompt: toolUse.input.prompt })}\n\n`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Image generated successfully and shown to the user.',
          });
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: 'Image generation failed: ' + e.message, is_error: true });
        }
      } else if (toolUse.name === 'analyze_video_link') {
        try {
          const buffer = await downloadVideoBuffer(toolUse.input.url);
          const frames = await extractVideoFrames(buffer, 10);
          res.write(`data: ${JSON.stringify({ type: 'video_done', url: toolUse.input.url, frames: frames.length })}\n\n`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: [
              ...frames.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })),
              { type: 'text', text: `Frames sampled chronologically from the video at ${toolUse.input.url}` },
            ],
          });
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: 'Could not analyze that video: ' + e.message, is_error: true });
        }
      } else if (toolUse.name === 'search_drive_files') {
        try {
          if (!googleTokens?.accessToken) throw new Error('Google is not connected — connect it in Settings first.');
          const files = await searchDriveFiles(toolUse.input.query, googleTokens, res);
          res.write(`data: ${JSON.stringify({ type: 'drive_done' })}\n\n`);
          const formatted = files.map(f => `${f.name} (id: ${f.id}, type: ${f.mimeType})`).join('\n') || 'No matching files found.';
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: formatted });
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: 'Drive search failed: ' + e.message, is_error: true });
        }
      } else if (toolUse.name === 'read_drive_file') {
        try {
          if (!googleTokens?.accessToken) throw new Error('Google is not connected — connect it in Settings first.');
          const file = await readDriveFile(toolUse.input.fileId, googleTokens, res);
          res.write(`data: ${JSON.stringify({ type: 'drive_done' })}\n\n`);
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `File: ${file.name}\n\n${file.content}` });
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: 'Could not read that file: ' + e.message, is_error: true });
        }
      } else if (toolUse.name === 'list_calendar_events') {
        try {
          if (!googleTokens?.accessToken) throw new Error('Google is not connected — connect it in Settings first.');
          const events = await listCalendarEvents(toolUse.input.timeMin, toolUse.input.timeMax, googleTokens, res);
          res.write(`data: ${JSON.stringify({ type: 'calendar_done' })}\n\n`);
          const formatted = events.map(e => `${e.title}: ${e.start} → ${e.end}${e.location ? ' @ ' + e.location : ''}`).join('\n') || 'No events found in that range.';
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: formatted });
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: 'Could not list events: ' + e.message, is_error: true });
        }
      } else if (toolUse.name === 'create_calendar_event') {
        try {
          if (!googleTokens?.accessToken) throw new Error('Google is not connected — connect it in Settings first.');
          const created = await createCalendarEvent(toolUse.input, googleTokens, res);
          res.write(`data: ${JSON.stringify({ type: 'calendar_done' })}\n\n`);
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `Event created: ${created.link}` });
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: 'Could not create event: ' + e.message, is_error: true });
        }
      }
    }

    messages.push({ role: 'user', content: toolResults });
    // loop continues — Claude sees tool results and responds again
  }

  sendUsage(); // fallback — only reached if MAX_TOOL_ROUNDS was exhausted
}

async function generateImage(prompt) {
  const encodedPrompt = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 1000000);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${seed}&nologo=true&enhance=true`;
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error('Pollinations error: ' + response.status);
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  const mimeType = response.headers.get('content-type') || 'image/jpeg';
  return `data:${mimeType};base64,${base64}`;
}

// ── Standalone web search via Anthropic's native web_search tool ──
// Not used by the main chat (which calls web_search automatically), but
// handy as a direct endpoint. Runs entirely on the Anthropic API key.
app.post('/api/search', async (req, res) => {
  const { query, apiKey, model } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  if (!query) return res.status(400).json({ error: 'Query required' });

  const selectedModel = model || 'claude-sonnet-4-6';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 1024,
        messages: [{ role: 'user', content: `Search the web for: ${query}\n\nGive a concise summary with sources.` }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: { message: 'API error' } }));
      return res.status(response.status).json({ error: err.error?.message || 'Claude API error' });
    }

    const data = await response.json();
    const answer = data.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
    const sources = [];
    (data.content || []).forEach(block => {
      (block.citations || []).forEach(c => {
        if (c.url && !sources.find(s => s.url === c.url)) sources.push({ url: c.url, title: c.title || c.url });
      });
    });
    res.json({ answer, sources });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Image generation via Pollinations ────────────────────────
app.post('/api/imagine', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  try {
    const encodedPrompt = encodeURIComponent(prompt);
    const seed = Math.floor(Math.random() * 1000000);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${seed}&nologo=true&enhance=true`;

    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error('Pollinations error: ' + response.status);

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = response.headers.get('content-type') || 'image/jpeg';

    res.json({ image: `data:${mimeType};base64,${base64}`, prompt });
  } catch (err) {
    console.error('Imagine error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── File analysis via Claude vision/document ─────────────────
app.post('/api/analyze-file', upload.single('file'), async (req, res) => {
  const { apiKey, question, model } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  if (!req.file) return res.status(400).json({ error: 'File required' });

  const { originalname, mimetype, buffer } = req.file;
  const base64Data = buffer.toString('base64');
  const selectedModel = model || 'claude-sonnet-4-6';
  const userQuestion = question || 'Please analyze this file thoroughly and describe what you see.';

  let contentBlock;

  if (mimetype.startsWith('image/')) {
    // Image — use vision
    contentBlock = [
      { type: 'image', source: { type: 'base64', media_type: mimetype, data: base64Data } },
      { type: 'text', text: userQuestion }
    ];
  } else if (mimetype === 'application/pdf') {
    // PDF — use document type
    contentBlock = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
      { type: 'text', text: userQuestion }
    ];
  } else if (mimetype.startsWith('video/')) {
    // Video — sample frames with ffmpeg, then analyze them as a sequence with vision
    try {
      const frames = await extractVideoFrames(buffer, 10);
      contentBlock = [
        ...frames.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })),
        { type: 'text', text: `These are frames sampled across a video file ("${originalname}"), in chronological order.\n\n${userQuestion}` }
      ];
    } catch (e) {
      return res.status(500).json({ error: 'Video processing failed: ' + e.message });
    }
  } else {
    // Text/code/CSV/JSON etc
    let textContent;
    try {
      textContent = buffer.toString('utf-8');
    } catch {
      textContent = base64Data;
    }
    contentBlock = [
      { type: 'text', text: `File: ${originalname}\n\nContent:\n\`\`\`\n${textContent}\n\`\`\`\n\n${userQuestion}` }
    ];
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 4096,
        messages: [{ role: 'user', content: contentBlock }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: { message: 'API error' } }));
      return res.status(response.status).json({ error: err.error?.message || 'Claude API error' });
    }

    const data = await response.json();
    const text = data.content?.find(c => c.type === 'text')?.text || 'No analysis returned.';
    res.json({ analysis: text, filename: originalname });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Video URL analysis ────────────────────────────────────────
// Note: this only works for *direct* video file links (e.g. ending in .mp4)
// that are publicly downloadable. YouTube/Vimeo/TikTok page URLs are not
// direct files — those platforms block server-side downloads — so for
// those, ask the user to download and upload the file instead.
app.post('/api/analyze-video-url', async (req, res) => {
  const { videoUrl, question, apiKey, model } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  if (!videoUrl) return res.status(400).json({ error: 'Video URL required' });

  const selectedModel = model || 'claude-sonnet-4-6';
  const userQuestion = question || 'Analyze this video and describe what you see in detail.';

  try {
    const buffer = await downloadVideoBuffer(videoUrl);
    const frames = await extractVideoFrames(buffer, 10);
    const contentBlock = [
      ...frames.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })),
      { type: 'text', text: `These are frames sampled across a video from this URL: ${videoUrl}\n\n${userQuestion}` }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 4096,
        messages: [{ role: 'user', content: contentBlock }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: { message: 'API error' } }));
      return res.status(response.status).json({ error: err.error?.message || 'Claude API error' });
    }

    const data = await response.json();
    const text = data.content?.find(c => c.type === 'text')?.text || 'No analysis returned.';
    res.json({ analysis: text });
  } catch (err) {
    console.error('Video URL analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Webpage / link analysis ───────────────────────────────────
// Fetches a URL, strips it down to readable text, and has Claude analyze it.
// Used as a direct endpoint — the main chat flow uses the same native
// web_fetch tool automatically, without needing to call this route.
app.post('/api/analyze-link', async (req, res) => {
  const { url, question, apiKey, model } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  if (!url) return res.status(400).json({ error: 'URL required' });

  const selectedModel = model || 'claude-sonnet-4-6';
  const userQuestion = question || 'Summarize and analyze this page.';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': BETA_HEADERS,
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 2048,
        messages: [{ role: 'user', content: `Please fetch and read this page: ${url}\n\n${userQuestion}` }],
        tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 1, citations: { enabled: true } }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: { message: 'API error' } }));
      return res.status(response.status).json({ error: err.error?.message || 'Claude API error' });
    }

    const data = await response.json();
    const text = data.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || 'No analysis returned.';
    res.json({ analysis: text, url });
  } catch (err) {
    console.error('Link analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── List available models ─────────────────────────────────────
app.post('/api/models', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API key required' });

  // Return our curated model list
  res.json({
    models: [
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', description: 'Most powerful — best for complex tasks', tier: 'flagship' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Fast, smart & efficient — recommended', tier: 'recommended' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', description: 'Fastest & lightest model', tier: 'fast' },
    ]
  });
});

// ── Serve frontend ────────────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ message: 'API is running. Deploy frontend separately.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
