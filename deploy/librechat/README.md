# Reusable LibreChat + MCP Apps kit

This directory is a self-contained Docker Compose stack for connecting
LibreChat to one Streamable HTTP MCP server. It has no runtime dependency on
Work Grid and can be copied into another repository unchanged.

The kit provides:

- LibreChat with OpenAI or an OpenAI-compatible gateway;
- MongoDB-backed persistent chat data;
- one environment-configured Streamable HTTP MCP server;
- MCP Apps support; and
- a separate localhost sandbox origin for interactive MCP interfaces.

LibreChat is pinned to `v0.8.9-rc1`, the first published image with config
v1.3.18 and the MCP App sandbox. Change `LIBRECHAT_IMAGE` in `.env` to upgrade
without editing the Compose or configuration templates.

## Copy into another project

From the destination repository:

```bash
mkdir -p deploy
rsync -a --exclude='.env' \
  /path/to/work-distribution-grid/deploy/librechat/ deploy/librechat/
cd deploy/librechat
cp .env.example .env
```

Edit `.env` and set at least:

- `OPENAI_API_KEY`;
- `MCP_SERVER_NAME`;
- `MCP_SERVER_URL`;
- `MCP_SERVER_ADDRESS`; and
- `MCP_SERVER_API_KEY` when the MCP endpoint requires bearer authentication.

The default example assumes the other project publishes its MCP endpoint on
host port `4173`. `host.docker.internal` works on Docker Desktop, and the
Compose file adds the equivalent host-gateway mapping on Linux.

Start the standalone stack:

```bash
./compose config
./compose up -d
./compose ps
./compose logs -f librechat
```

Open <http://localhost:3080>, register the first local account, choose an
OpenAI model, and enable the configured server in LibreChat's MCP tools picker.
MCP tools that link `_meta.ui.resourceUri` to a `ui://` resource with MIME type
`text/html;profile=mcp-app` should offer **Open app**.

Stop the stack without deleting its data:

```bash
./compose down
```

Do not add `--volumes` unless you intend to delete LibreChat and MongoDB data.

## MCP endpoint placement

For an MCP server published by the host, use:

```dotenv
MCP_SERVER_URL=http://host.docker.internal:4173/api/mcp
MCP_SERVER_ADDRESS=host.docker.internal:4173
MCP_SERVER_NO_PROXY=localhost,127.0.0.1,::1,mongodb,host.docker.internal
```

If you merge this Compose file into the other project's Compose configuration,
use the MCP service's DNS name instead, for example
`http://my-api:4173/api/mcp`, and set `MCP_SERVER_ADDRESS=my-api:4173`. The exact
private address is required by LibreChat's SSRF protection; do not replace it
with a broad subnet exemption.

`render-config.mjs` validates and safely quotes deployment values before
LibreChat reads the generated configuration. An empty `MCP_SERVER_API_KEY`
omits the Authorization header rather than sending a blank credential.

## Credentials and deployment

For persistent installations, generate and retain all four `LIBRECHAT_*`
credential values. LibreChat can create temporary credentials for evaluation,
but changing them can make stored secrets unreadable.

For a non-local deployment, expose the main application and MCP sandbox on
separate HTTPS origins. Keep `MCP_SANDBOX_FRAME_ANCESTORS` restricted to the
main LibreChat origin. Store OpenAI and MCP credentials in the deployment's
secret manager rather than committing `.env`.
