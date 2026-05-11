import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client, ClientChannel } from "ssh2";
import { z } from "zod";

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

// ─── Session stores ───────────────────────────────────────────────────────────

const sshSessions = new Map<string, SSHSession>();
const shellSessions = new Map<string, ShellSession>();

// ─── SSH helpers ──────────────────────────────────────────────────────────────

function getSSHCredentials(host: string): { username: string; password: string } {
  if (host === "108.181.162.206" || host === "gesher-el") {
    return { username: "administrator", password: "Kk@333333" };
  }
  // Default: Hostinger VPS (itself or by IP)
  return { username: "root", password: "Kk@333333???" };
}

async function getOrCreateSSHSession(sessionId: string, host: string): Promise<Client> {
  const existing = sshSessions.get(sessionId);
  if (existing && existing.ready && existing.host === host) {
    return existing.client;
  }

  // Close stale session for different host
  if (existing) {
    existing.client.end();
    sshSessions.delete(sessionId);
  }

  const creds = getSSHCredentials(host);

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const session: SSHSession = { client: conn, host, ready: false };
    sshSessions.set(sessionId, session);

    conn.on("ready", () => {
      session.ready = true;
      resolve(conn);
    });

    conn.on("error", (err) => {
      sshSessions.delete(sessionId);
      reject(err);
    });

    conn.on("close", () => {
      sshSessions.delete(sessionId);
    });

    conn.connect({
      host,
      port: 22,
      username: creds.username,
      password: creds.password,
      readyTimeout: 15000,
    });
  });
}

async function execOnHost(
  sessionId: string,
  host: string,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const conn = await getOrCreateSSHSession(sessionId, host);

  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);

      let stdout = "";
      let stderr = "";

      stream.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      stream.on("close", (code: number) => {
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      });

      stream.on("error", reject);
    });
  });
}

// ─── MCP Server setup ─────────────────────────────────────────────────────────

function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "axis-mundi",
    version: "1.0.0",
  });

  // ── axis_exec ──────────────────────────────────────────────────────────────
  server.tool(
    "axis_exec",
    "Execute a shell command on a remote server via SSH. Returns stdout, stderr, and exit code.",
    {
      command: z.string().describe("Shell command to execute"),
      session_id: z.string().default("default").describe("Session identifier for connection reuse"),
      host: z
        .string()
        .default("127.0.0.1")
        .describe("Target host IP or hostname. Defaults to localhost (Hostinger VPS itself). Use 108.181.162.206 for gesher-el GPU."),
    },
    async ({ command, session_id, host }) => {
      try {
        const result = await execOnHost(session_id, host, command);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                host,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: String(err), host }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── axis_read ──────────────────────────────────────────────────────────────
  server.tool(
    "axis_read",
    "Read the contents of a file on the remote server.",
    {
      path: z.string().describe("Absolute path to the file on the remote server"),
      session_id: z.string().default("default").describe("Session identifier for connection reuse"),
      host: z
        .string()
        .default("127.0.0.1")
        .describe("Target host. Defaults to Hostinger VPS. Use 108.181.162.206 for gesher-el."),
    },
    async ({ path, session_id, host }) => {
      try {
        const result = await execOnHost(session_id, host, `cat "${path.replace(/"/g, '\\"')}"`);
        if (result.exitCode !== 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: result.stderr || "File not found or unreadable", path }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: result.stdout,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err), path }) }],
          isError: true,
        };
      }
    }
  );

  // ── axis_write ─────────────────────────────────────────────────────────────
  server.tool(
    "axis_write",
    "Write content to a file on the remote server. Creates parent directories if needed.",
    {
      path: z.string().describe("Absolute path to write on the remote server"),
      content: z.string().describe("Content to write to the file"),
      session_id: z.string().default("default").describe("Session identifier for connection reuse"),
      host: z
        .string()
        .default("127.0.0.1")
        .describe("Target host. Defaults to Hostinger VPS. Use 108.181.162.206 for gesher-el."),
    },
    async ({ path, content, session_id, host }) => {
      try {
        // Ensure parent dir exists, then write via heredoc
        const dir = path.substring(0, path.lastIndexOf("/"));
        const escaped = content.replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/`/g, "\\`");
        const mkdirCmd = dir ? `mkdir -p "${dir}" && ` : "";
        const writeCmd = `${mkdirCmd}cat > "${path.replace(/"/g, '\\"')}" << 'AXIS_EOF'\n${content}\nAXIS_EOF`;

        const result = await execOnHost(session_id, host, writeCmd);
        if (result.exitCode !== 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: result.stderr, path }),
              },
            ],
            isError: true,
          };
        }
        void escaped; // heredoc approach doesn't need escaping
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, path, host }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err), path }) }],
          isError: true,
        };
      }
    }
  );

  // ── axis_shell_start ───────────────────────────────────────────────────────
  server.tool(
    "axis_shell_start",
    "Start a persistent interactive PTY shell session. Use this for real-time model piloting (e.g. ollama run). Returns immediately once shell is ready.",
    {
      session_id: z.string().describe("Unique identifier for this shell session"),
      host: z
        .string()
        .default("127.0.0.1")
        .describe("Target host. Defaults to Hostinger VPS. Use 108.181.162.206 for gesher-el GPU."),
      cols: z.number().default(220).describe("Terminal width in columns"),
      rows: z.number().default(50).describe("Terminal height in rows"),
    },
    async ({ session_id, host, cols, rows }) => {
      try {
        // Clean up any existing shell session
        const existing = shellSessions.get(session_id);
        if (existing) {
          try {
            existing.stream.end();
            existing.client.end();
          } catch {
            // ignore
          }
          shellSessions.delete(session_id);
        }

        const creds = getSSHCredentials(host);

        return await new Promise<{ content: Array<{ type: "text"; text: string }> }>((resolve, reject) => {
          const conn = new Client();

          conn.on("ready", () => {
            conn.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
              if (err) {
                conn.end();
                return reject(err);
              }

              const session: ShellSession = { client: conn, stream, buffer: "", host };
              shellSessions.set(session_id, session);

              stream.on("data", (data: Buffer) => {
                session.buffer += data.toString();
                // Keep buffer from growing unbounded — keep last 64KB
                if (session.buffer.length > 65536) {
                  session.buffer = session.buffer.slice(session.buffer.length - 65536);
                }
              });

              stream.stderr.on("data", (data: Buffer) => {
                session.buffer += data.toString();
              });

              stream.on("close", () => {
                shellSessions.delete(session_id);
              });

              conn.on("close", () => {
                shellSessions.delete(session_id);
              });

              // Give the shell 500ms to emit its prompt
              setTimeout(() => {
                resolve({
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        success: true,
                        session_id,
                        host,
                        message: "Shell ready. Use axis_shell_send to send input, axis_shell_read to read output.",
                      }),
                    },
                  ],
                });
              }, 500);
            });
          });

          conn.on("error", (err) => {
            reject(err);
          });

          conn.connect({
            host,
            port: 22,
            username: creds.username,
            password: creds.password,
            readyTimeout: 15000,
          });
        });
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err), session_id }) }],
          isError: true,
        };
      }
    }
  );

  // ── axis_shell_send ────────────────────────────────────────────────────────
  server.tool(
    "axis_shell_send",
    "Send input to a running interactive shell session. Use \\n for Enter, \\x03 for Ctrl+C, \\x04 for Ctrl+D.",
    {
      input: z.string().describe("Text to send to the shell. Use \\n for newline/Enter, \\x03 for Ctrl+C."),
      session_id: z.string().describe("Shell session identifier (must match one started with axis_shell_start)"),
    },
    async ({ input, session_id }) => {
      const session = shellSessions.get(session_id);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `No shell session found with id: ${session_id}. Use axis_shell_start first.` }),
            },
          ],
          isError: true,
        };
      }

      try {
        // Process escape sequences in the input string
        const processed = input
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\x03/g, "\x03")
          .replace(/\\x04/g, "\x04")
          .replace(/\\x1b/g, "\x1b");

        session.stream.write(processed);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, session_id, sent: input }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err), session_id }) }],
          isError: true,
        };
      }
    }
  );

  // ── axis_shell_read ────────────────────────────────────────────────────────
  server.tool(
    "axis_shell_read",
    "Read accumulated output from a running interactive shell session.",
    {
      session_id: z.string().describe("Shell session identifier"),
      clear: z
        .boolean()
        .default(true)
        .describe("If true, clears the buffer after reading (default: true). Set false to peek without consuming."),
      wait_ms: z
        .number()
        .default(0)
        .describe("Milliseconds to wait for new output before returning (0 = return immediately)"),
    },
    async ({ session_id, clear, wait_ms }) => {
      const session = shellSessions.get(session_id);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `No shell session found with id: ${session_id}.` }),
            },
          ],
          isError: true,
        };
      }

      if (wait_ms > 0) {
        await new Promise((r) => setTimeout(r, Math.min(wait_ms, 30000)));
      }

      const output = session.buffer;
      if (clear) {
        session.buffer = "";
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              output,
              session_id,
              length: output.length,
              cleared: clear,
            }),
          },
        ],
      };
    }
  );

  return server;
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "axis-mundi",
    version: "1.0.0",
    sessions: {
      ssh: sshSessions.size,
      shell: shellSessions.size,
    },
  });
});

// MCP endpoint — one transport instance per HTTP request (stateless HTTP transport)
app.post("/mcp", async (req: Request, res: Response) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: String(err) });
    }
  }
});

// GET /mcp — reject (stateless server doesn't support SSE resumption)
app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ error: "Method Not Allowed. Use POST." });
});

// DELETE /mcp — session teardown (no-op for stateless)
app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`AXIS MUNDI MCP server running on port ${PORT}`);
  console.log(`  Health: http://0.0.0.0:${PORT}/health`);
  console.log(`  MCP:    http://0.0.0.0:${PORT}/mcp`);
});
