import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client, ClientChannel } from "ssh2";
import { z } from "zod";
import crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SSHSession {
  client: Client;
  host: string;
  ready: boolean;
}

interface ShellSession {
  client: Client;
  stream: ClientChannel;
  buffer: string;
  host: string;
}

interface OAuthClient {
  clientId: string;
  redirectUris: string[];
}

interface AuthCode {
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  expiresAt: number;
}

interface Token {
  clientId: string;
  expiresAt: number;
}

// ─── OAuth state (in-memory) ──────────────────────────────────────────────────

const oauthClients = new Map<string, OAuthClient>();
const authCodes = new Map<string, AuthCode>();
const tokens = new Map<string, Token>();

const BASE_URL = process.env.BASE_URL ?? "https://markyninox.com";
const REALM = "AXIS MUNDI";

// ─── Session stores ───────────────────────────────────────────────────────────

const sshSessions = new Map<string, SSHSession>();
const shellSessions = new Map<string, ShellSession>();

// ─── SSH helpers ──────────────────────────────────────────────────────────────

function getSSHCredentials(host: string): { username: string; password: string } {
  if (host === "108.181.162.206" || host === "gesher-el") {
    return { username: "administrator", password: "Kk@333333" };
  }
  return { username: "root", password: "Kk@333333???" };
}

async function getOrCreateSSHSession(sessionId: string, host: string): Promise<Client> {
  const existing = sshSessions.get(sessionId);
  if (existing && existing.ready && existing.host === host) {
    return existing.client;
  }
  if (existing) {
    existing.client.end();
    sshSessions.delete(sessionId);
  }

  const creds = getSSHCredentials(host);

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const session: SSHSession = { client: conn, host, ready: false };
    sshSessions.set(sessionId, session);

    conn.on("ready", () => { session.ready = true; resolve(conn); });
    conn.on("error", (err) => { sshSessions.delete(sessionId); reject(err); });
    conn.on("close", () => { sshSessions.delete(sessionId); });

    conn.connect({ host, port: 22, username: creds.username, password: creds.password, readyTimeout: 15000 });
  });
}

async function execOnHost(sessionId: string, host: string, command: string) {
  const conn = await getOrCreateSSHSession(sessionId, host);
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "", stderr = "";
      stream.on("data", (d: Buffer) => { stdout += d.toString(); });
      stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      stream.on("close", (code: number) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
      stream.on("error", reject);
    });
  });
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.set("WWW-Authenticate", `Bearer realm="${REALM}", error="invalid_token"`);
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const token = auth.slice(7);
  const session = tokens.get(token);
  if (!session || session.expiresAt < Date.now()) {
    res.set("WWW-Authenticate", `Bearer realm="${REALM}", error="invalid_token"`);
    res.status(401).json({ error: "invalid_token" });
    return;
  }
  next();
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "axis-mundi", version: "1.0.0" });

  server.tool(
    "axis_exec",
    "Execute a shell command on a remote server via SSH. Returns stdout, stderr, and exit code.",
    {
      command: z.string().describe("Shell command to execute"),
      session_id: z.string().default("default").describe("Session identifier for connection reuse"),
      host: z.string().default("127.0.0.1").describe("Target host. 127.0.0.1 = Hostinger VPS, 108.181.162.206 = gesher-el GPU."),
    },
    async ({ command, session_id, host }) => {
      try {
        const result = await execOnHost(session_id, host, command);
        return { content: [{ type: "text", text: JSON.stringify({ ...result, host }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err), host }) }], isError: true };
      }
    }
  );

  server.tool(
    "axis_read",
    "Read the contents of a file on the remote server.",
    {
      path: z.string().describe("Absolute path to the file"),
      session_id: z.string().default("default"),
      host: z.string().default("127.0.0.1").describe("Target host."),
    },
    async ({ path, session_id, host }) => {
      try {
        const result = await execOnHost(session_id, host, `cat "${path.replace(/"/g, '\\"')}"`);
        if (result.exitCode !== 0) {
          return { content: [{ type: "text", text: JSON.stringify({ error: result.stderr || "Unreadable", path }) }], isError: true };
        }
        return { content: [{ type: "text", text: result.stdout }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err), path }) }], isError: true };
      }
    }
  );

  server.tool(
    "axis_write",
    "Write content to a file on the remote server. Creates parent directories if needed.",
    {
      path: z.string().describe("Absolute path to write"),
      content: z.string().describe("Content to write"),
      session_id: z.string().default("default"),
      host: z.string().default("127.0.0.1"),
    },
    async ({ path, content, session_id, host }) => {
      try {
        const dir = path.substring(0, path.lastIndexOf("/"));
        const mkdirCmd = dir ? `mkdir -p "${dir}" && ` : "";
        const writeCmd = `${mkdirCmd}cat > "${path.replace(/"/g, '\\"')}" << 'AXIS_EOF'\n${content}\nAXIS_EOF`;
        const result = await execOnHost(session_id, host, writeCmd);
        if (result.exitCode !== 0) {
          return { content: [{ type: "text", text: JSON.stringify({ error: result.stderr, path }) }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify({ success: true, path, host }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err), path }) }], isError: true };
      }
    }
  );

  server.tool(
    "axis_shell_start",
    "Start a persistent interactive PTY shell session for real-time command streaming.",
    {
      session_id: z.string().describe("Unique shell session identifier"),
      host: z.string().default("127.0.0.1").describe("Target host."),
      cols: z.number().default(220),
      rows: z.number().default(50),
    },
    async ({ session_id, host, cols, rows }) => {
      try {
        const existing = shellSessions.get(session_id);
        if (existing) {
          try { existing.stream.end(); existing.client.end(); } catch { /**/ }
          shellSessions.delete(session_id);
        }
        const creds = getSSHCredentials(host);

        return await new Promise<{ content: Array<{ type: "text"; text: string }> }>((resolve, reject) => {
          const conn = new Client();
          conn.on("ready", () => {
            conn.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
              if (err) { conn.end(); return reject(err); }
              const session: ShellSession = { client: conn, stream, buffer: "", host };
              shellSessions.set(session_id, session);
              stream.on("data", (d: Buffer) => {
                session.buffer += d.toString();
                if (session.buffer.length > 65536) session.buffer = session.buffer.slice(-65536);
              });
              stream.stderr.on("data", (d: Buffer) => { session.buffer += d.toString(); });
              stream.on("close", () => shellSessions.delete(session_id));
              conn.on("close", () => shellSessions.delete(session_id));
              setTimeout(() => resolve({
                content: [{ type: "text", text: JSON.stringify({ success: true, session_id, host, message: "Shell ready." }) }]
              }), 500);
            });
          });
          conn.on("error", reject);
          conn.connect({ host, port: 22, username: creds.username, password: creds.password, readyTimeout: 15000 });
        });
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err), session_id }) }], isError: true };
      }
    }
  );

  server.tool(
    "axis_shell_send",
    "Send input to a running interactive shell. Use \\n for Enter, \\x03 for Ctrl+C, \\x04 for Ctrl+D.",
    {
      input: z.string().describe("Input to send to the shell"),
      session_id: z.string().describe("Shell session identifier"),
    },
    async ({ input, session_id }) => {
      const session = shellSessions.get(session_id);
      if (!session) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `No shell session: ${session_id}` }) }], isError: true };
      }
      const processed = input.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
        .replace(/\\x03/g, "\x03").replace(/\\x04/g, "\x04").replace(/\\x1b/g, "\x1b");
      session.stream.write(processed);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, session_id, sent: input }) }] };
    }
  );

  server.tool(
    "axis_shell_read",
    "Read accumulated output from an interactive shell session.",
    {
      session_id: z.string().describe("Shell session identifier"),
      clear: z.boolean().default(true).describe("Clear buffer after reading"),
      wait_ms: z.number().default(0).describe("Wait this many ms before reading (max 30000)"),
    },
    async ({ session_id, clear, wait_ms }) => {
      const session = shellSessions.get(session_id);
      if (!session) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `No shell session: ${session_id}` }) }], isError: true };
      }
      if (wait_ms > 0) await new Promise((r) => setTimeout(r, Math.min(wait_ms, 30000)));
      const output = session.buffer;
      if (clear) session.buffer = "";
      return { content: [{ type: "text", text: JSON.stringify({ output, session_id, length: output.length, cleared: clear }) }] };
    }
  );

  return server;
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "axis-mundi", version: "1.0.0", sessions: { ssh: sshSessions.size, shell: shellSessions.size } });
});

// ── OAuth: Resource metadata (RFC 8707) ───────────────────────────────────────
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
  });
});

// ── OAuth: Authorization server metadata (RFC 8414) ───────────────────────────
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

// ── OAuth: Dynamic Client Registration (RFC 7591) ─────────────────────────────
app.post("/oauth/register", (req, res) => {
  const { redirect_uris = [], client_name } = req.body;
  const clientId = crypto.randomUUID();
  oauthClients.set(clientId, { clientId, redirectUris: redirect_uris });
  res.status(201).json({
    client_id: clientId,
    client_name: client_name ?? "axis-client",
    redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
});

// ── OAuth: Authorization endpoint ─────────────────────────────────────────────
app.get("/oauth/authorize", (req, res) => {
  const { client_id, redirect_uri, code_challenge, code_challenge_method = "S256", state, response_type } = req.query as Record<string, string>;

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }
  if (!client_id || !redirect_uri || !code_challenge) {
    res.status(400).json({ error: "invalid_request", error_description: "Missing required parameters" });
    return;
  }

  const code = crypto.randomBytes(32).toString("hex");
  authCodes.set(code, {
    clientId: client_id,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    redirectUri: redirect_uri,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);
  res.redirect(redirectUrl.toString());
});

// ── OAuth: Token endpoint ─────────────────────────────────────────────────────
app.post("/oauth/token", (req, res) => {
  const { grant_type, code, code_verifier, client_id } = req.body;

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }
  const authCode = authCodes.get(code);
  if (!authCode || authCode.expiresAt < Date.now()) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  // Verify PKCE S256
  if (authCode.codeChallengeMethod === "S256") {
    const hash = crypto.createHash("sha256").update(code_verifier ?? "").digest("base64url");
    if (hash !== authCode.codeChallenge) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }
  }

  authCodes.delete(code);
  const token = crypto.randomBytes(32).toString("hex");
  // 30-day tokens — Claude connectors don't refresh automatically
  tokens.set(token, { clientId: client_id ?? authCode.clientId, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });

  res.json({ access_token: token, token_type: "Bearer", expires_in: 2592000 });
});

// ── MCP endpoint ──────────────────────────────────────────────────────────────
app.head("/mcp", (_req, res) => {
  // RFC 6750 — HEAD must respond like GET, not 405
  res.set("WWW-Authenticate", `Bearer realm="${REALM}"`).status(200).end();
});

app.post("/mcp", requireBearer, async (req: Request, res: Response) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  }
});

app.get("/mcp", (_req, res) => {
  res.set("WWW-Authenticate", `Bearer realm="${REALM}"`).status(401).json({ error: "Use POST" });
});

app.delete("/mcp", (_req, res) => res.status(200).json({ ok: true }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`AXIS MUNDI running on :${PORT}`);
  console.log(`  Health:  http://0.0.0.0:${PORT}/health`);
  console.log(`  MCP:     ${BASE_URL}/mcp`);
  console.log(`  OAuth:   ${BASE_URL}/oauth/authorize`);
});
