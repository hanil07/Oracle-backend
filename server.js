const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'My Assistant', timestamp: new Date().toISOString() });
});

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
    name: 'web_search',
    description: 'Search the live web for current, recent, or real-time information. Use this for anything that may have changed recently, current events, prices, news, or facts you are not fully certain about.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' }
      },
      required: ['query']
    }
  }
];

// ── Chat with streaming + automatic tool use (no manual mode toggles) ──
app.post('/api/chat', async (req, res) => {
  const { messages, apiKey, model, braveKey, systemPrompt } = req.body;

  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Messages array required' });

  const selectedModel = model || 'claude-sonnet-4-5-20250929';

  const systemContent = systemPrompt || `You are a helpful, knowledgeable AI assistant. You can write code, analyze files, search the web, generate images, solve math problems, and answer questions across any topic. Decide on your own, without being asked, whether a request needs an image generated or the web searched — use the tools available to you automatically when they would help answer better. Be clear, direct, and accurate. When writing code, always use proper markdown code blocks with language tags. Format responses using markdown where it aids readability.`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    await runAgenticTurn({
      apiKey, model: selectedModel, systemContent, messages: [...messages], braveKey, res,
    });
    res.end();
  } catch (err) {
    console.error('Chat error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

// Runs one turn, letting Claude call tools as many times as it wants before giving a final text answer.
async function runAgenticTurn({ apiKey, model, systemContent, messages, braveKey, res }) {
  const MAX_TOOL_ROUNDS = 4;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: systemContent,
        messages,
        tools: CLAUDE_TOOLS,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      let message = 'Anthropic API error';
      try { message = JSON.parse(errBody).error?.message || message; } catch { message = errBody || message; }
      throw new Error(message);
    }

    const data = await response.json();
    const textBlocks = data.content.filter(b => b.type === 'text');
    const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');

    // Stream any text Claude wrote this round
    for (const block of textBlocks) {
      res.write(`data: ${JSON.stringify({ type: 'text', text: block.text })}\n\n`);
    }

    if (toolUseBlocks.length === 0) {
      // No tools requested — final answer, we're done
      return;
    }

    // Claude wants to use tool(s). Run them, then continue the conversation.
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
      } else if (toolUse.name === 'web_search') {
        try {
          const results = await braveSearch(toolUse.input.query, braveKey);
          res.write(`data: ${JSON.stringify({ type: 'search_done', query: toolUse.input.query })}\n\n`);
          const formatted = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: formatted || 'No results found.' });
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: 'Search failed: ' + e.message, is_error: true });
        }
      }
    }

    messages.push({ role: 'user', content: toolResults });
    // loop continues — Claude sees tool results and responds again
  }
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

async function braveSearch(query, braveKey) {
  if (!braveKey) throw new Error('No Brave Search key configured in Settings');
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`;
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': braveKey },
  });
  if (!response.ok) throw new Error('Brave Search error: ' + response.status);
  const data = await response.json();
  return (data.web?.results || []).slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: r.description || '' }));
}

// ── Web search via Brave ──────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query, braveKey } = req.body;
  if (!braveKey) return res.status(400).json({ error: 'Brave API key required' });
  if (!query) return res.status(400).json({ error: 'Query required' });

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': braveKey,
      },
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: 'Brave Search error: ' + err });
    }

    const data = await response.json();
    const results = (data.web?.results || []).slice(0, 5).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description || '',
    }));

    res.json({ results });
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
  const selectedModel = model || 'claude-sonnet-4-5-20250929';
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
    // Video — extract frames or describe
    return res.status(415).json({ error: 'Video analysis: Please use the video URL feature or convert to frames. Direct video upload not yet supported by Claude API.' });
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
app.post('/api/analyze-video-url', async (req, res) => {
  const { videoUrl, question, apiKey, model } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  if (!videoUrl) return res.status(400).json({ error: 'Video URL required' });

  const selectedModel = model || 'claude-opus-4-1-20250805';
  const userQuestion = question || 'Analyze this video and describe what you see in detail.';

  // Claude supports video via URL for some formats
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
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `Video URL: ${videoUrl}\n\n${userQuestion}\n\nPlease analyze the content at this URL. If you cannot directly view the video, analyze based on any metadata, title, or context available, and let the user know.` }
          ]
        }],
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
      { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1', description: 'Most powerful — best for complex tasks', tier: 'flagship' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', description: 'Fast, smart & efficient — recommended', tier: 'recommended' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude Haiku 3.5', description: 'Fastest & lightest model', tier: 'fast' },
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


