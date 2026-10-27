# Work Grid adapter for the reusable LibreChat kit

This directory contains only the Work Grid-specific Compose dependency and
environment example. The reusable stack lives in `../librechat`.

From the repository root:

```bash
cp deploy/librechat-workgrid/.env.example deploy/librechat/.env
# Set OPENAI_API_KEY and generate persistent LIBRECHAT_* credentials.
npm run librechat:config
npm run librechat:up
```

`MCP_SERVER_API_KEY` is passed to both LibreChat and Work Grid, so there is one
bearer secret to generate and keep consistent.
