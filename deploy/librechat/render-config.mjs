import { readFileSync, writeFileSync } from "node:fs";

const templatePath = process.argv[2] ?? "/app/librechat.template.yaml";
const outputPath = process.argv[3] ?? "/app/data/librechat.yaml";

const firstValue = (...names) => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
};

const required = (label, ...names) => {
  const value = firstValue(...names);
  if (!value) {
    throw new Error(`${label} must be set before rendering LibreChat's configuration`);
  }
  return value;
};

const serverName = firstValue("MCP_SERVER_NAME") || "work-grid";
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(serverName)) {
  throw new Error("MCP_SERVER_NAME must contain only letters, numbers, underscores, or hyphens (maximum 64 characters)");
}

const serverUrl = required("MCP_SERVER_URL", "MCP_SERVER_URL", "WORKGRID_MCP_URL");
const parsedServerUrl = new URL(serverUrl);
if (parsedServerUrl.protocol !== "http:" && parsedServerUrl.protocol !== "https:") {
  throw new Error("MCP_SERVER_URL must use http or https");
}

const serverAddress = required("MCP_SERVER_ADDRESS", "MCP_SERVER_ADDRESS", "WORKGRID_MCP_ADDRESS");
const serverApiKey = firstValue("MCP_SERVER_API_KEY", "WORKGRID_MCP_API_KEY");
const serverDescription = firstValue("MCP_SERVER_DESCRIPTION") || `Tools and interactive interfaces from ${serverName}.`;
const welcome = firstValue("LIBRECHAT_WELCOME") || `${serverName} is connected through MCP.`;

const replacements = {
  __MCP_SANDBOX_URL__: required("MCP_SANDBOX_URL", "MCP_SANDBOX_URL"),
  __MCP_SERVER_NAME__: serverName,
  __MCP_SERVER_ADDRESS__: serverAddress,
  __MCP_SERVER_URL__: serverUrl,
  __MCP_SERVER_DESCRIPTION__: serverDescription,
  __MCP_SERVER_HEADERS__: serverApiKey ? { Authorization: `Bearer ${serverApiKey}` } : {},
  __LIBRECHAT_WELCOME__: welcome,
};

let rendered = readFileSync(templatePath, "utf8");

for (const [marker, value] of Object.entries(replacements)) {
  if (!rendered.includes(marker)) {
    throw new Error(`Missing configuration marker: ${marker}`);
  }
  rendered = rendered.replaceAll(marker, JSON.stringify(value));
}

writeFileSync(outputPath, rendered, { mode: 0o600 });
