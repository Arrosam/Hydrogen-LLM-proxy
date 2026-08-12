/**
 * Minimal OpenAI-completion upstream for memory measurement. Answers with a
 * fixed-size body so the only variable in a sweep is what the proxy itself does.
 */
const http = require("node:http");

const PORT = Number(process.env.MOCK_PORT || 8791);
const RESP_CHARS = Number(process.env.RESP_CHARS || 2000);
/**
 * Think-time before answering. A real LLM takes seconds, which is what makes
 * requests overlap: in-flight count is arrival rate x latency. With an instant
 * mock, nothing the proxy holds *during* a call can ever show up in a peak.
 */
const DELAY_MS = Number(process.env.MOCK_DELAY_MS || 0);
/** Gap between SSE frames, so a streamed answer takes seconds like a real one. */
const FRAME_DELAY_MS = Number(process.env.MOCK_FRAME_DELAY_MS || 0);
const CONTENT = "response ".repeat(Math.ceil(RESP_CHARS / 9)).slice(0, RESP_CHARS);

let calls = 0;
let bytesIn = 0;

function nonStreaming(model) {
  return JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: CONTENT }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
}

function sseFrames(model) {
  const frames = [];
  const chunk = Math.max(1, Math.ceil(CONTENT.length / 20));
  frames.push({ id: "1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  for (let i = 0; i < CONTENT.length; i += chunk) {
    frames.push({ id: "1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: CONTENT.slice(i, i + chunk) }, finish_reason: null }] });
  }
  frames.push({ id: "1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).concat("data: [DONE]\n\n");
}

const server = http.createServer((req, res) => {
  if (req.url === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ calls, bytesIn }));
    return;
  }
  const parts = [];
  let n = 0;
  req.on("data", (c) => {
    n += c.length;
    parts.push(c);
  });
  req.on("end", () => {
    if (DELAY_MS > 0) setTimeout(() => answer(), DELAY_MS);
    else answer();

    function answer() {
    calls++;
    bytesIn += n;
    const raw = Buffer.concat(parts).toString("utf8");
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* the proxy always sends JSON; a parse failure is the test's problem */
    }
    const model = body.model || "mock-model";

    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const frames = sseFrames(model);
      // Trickle when asked: a real answer streams over seconds, and that window
      // is precisely how long the proxy holds whatever it holds per request.
      if (FRAME_DELAY_MS > 0) {
        let i = 0;
        const tick = setInterval(() => {
          if (i >= frames.length || res.writableEnded) {
            clearInterval(tick);
            if (!res.writableEnded) res.end();
            return;
          }
          res.write(frames[i++]);
        }, FRAME_DELAY_MS);
        return;
      }
      for (const f of frames) res.write(f);
      res.end();
      return;
    }
    const out = nonStreaming(model);
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(out) });
    res.end(out);
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`mock upstream on ${PORT}, ${RESP_CHARS} chars per answer\n`);
});
