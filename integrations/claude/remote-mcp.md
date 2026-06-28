# Claude.com Remote MCP Connector

Claude.com cannot run this repo's local shell scripts. To call the factory from
Claude on the web, deploy the factory to a public HTTPS URL and add a custom
connector that points at the remote MCP endpoint:

```text
https://your-factory.example.com/mcp
```

The endpoint exposes these tools:

- `software_factory_create_run`
- `software_factory_list_runs`
- `software_factory_get_run`
- `software_factory_get_events`
- `software_factory_cancel_run`

## Authentication

Tool calls require the hosted factory's operator token. The MCP bridge accepts
either:

```text
Authorization: Bearer <SF_OPERATOR_TOKEN>
```

or:

```text
x-operator-token: <SF_OPERATOR_TOKEN>
```

If your Claude.com workspace's custom connector setup cannot attach a static
Bearer token, put the factory behind an OAuth/auth proxy that injects the
operator token before forwarding to `/mcp`.

## Smoke Test

After deploying the factory, test the endpoint with a raw MCP request:

```bash
curl "$SF_BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $SF_OPERATOR_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Create a run through MCP:

```bash
curl "$SF_BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $SF_OPERATOR_TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"software_factory_create_run","arguments":{"prompt":"Build an AI services marketplace","requestedWorkerCap":10}}}'
```
