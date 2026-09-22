import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { connectDatabase } from "./db.js";
import { authenticatePat, McpReadService } from "./mcp-service.js";

const config = loadConfig();
if (config.APP_MODE !== "local") throw new Error("PAT-based stdio MCP is local-development only; hosted access requires OAuth");
const token = process.env.VSO_MCP_PAT;
if (!token) throw new Error("VSO_MCP_PAT is required");
const database = await connectDatabase(config);
const service = new McpReadService(database.db, await authenticatePat(database.db, token));
const server = new McpServer({ name: "venture-studio", version: "0.1.0" });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const tool = (name: string, description: string, inputSchema: z.ZodType, handler: (input: any) => Promise<unknown>) => server.registerTool(name, { description, inputSchema, annotations: readOnly }, async (input) => { const result = await handler(input); return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> }; });

tool("list_ventures", "List ventures available to the authenticated user", z.object({}), () => service.listVentures());
tool("get_my_today", "Get the authenticated user's due work and classes", z.object({ date: z.iso.date(), ventureId: z.string().optional() }), ({ date, ventureId }) => service.today(date, ventureId));
tool("get_venture_status", "Get authorized venture goals, outcomes, blockers and decisions", z.object({ ventureId: z.string() }), ({ ventureId }) => service.ventureStatus(ventureId));
tool("search_knowledge", "Search authorized, evidence-labelled knowledge with citations", z.object({ query: z.string().min(2), ventureId: z.string().optional(), limit: z.number().int().min(1).max(20).default(5) }), ({ query, ventureId, limit }) => service.searchKnowledge(query, ventureId, limit));
tool("get_task", "Get one authorized task with evidence", z.object({ id: z.string() }), ({ id }) => service.task(id));
tool("list_my_tasks", "List tasks assigned to the authenticated user", z.object({ ventureId: z.string().optional(), status: z.string().optional() }), ({ ventureId, status }) => service.myTasks(ventureId, status));
tool("list_blockers", "List blockers in authorized ventures", z.object({ ventureId: z.string().optional() }), ({ ventureId }) => service.blockers(ventureId));
tool("get_class_schedule", "Get the authenticated user's upcoming classes", z.object({}), () => service.classSchedule());
tool("get_decision", "Get one current authorized decision", z.object({ id: z.string() }), ({ id }) => service.decision(id));
tool("export_context_packet", "Export a bounded Markdown packet for one authorized task", z.object({ taskId: z.string() }), ({ taskId }) => service.contextPacket(taskId));

process.on("SIGINT", async () => { await server.close(); await database.client.close(); process.exit(0); });
await server.connect(new StdioServerTransport());
