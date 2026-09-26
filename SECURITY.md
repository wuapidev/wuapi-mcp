# Security

## Reporting a vulnerability

Please report vulnerabilities privately, with GitHub's
[private vulnerability reporting](https://github.com/wuapidev/wuapi-mcp/security/advisories/new)
for this repository. Don't open a public issue.

Include what you found, how to reproduce it, the package version and the MCP
client you used. We'll acknowledge the report, keep you posted while we fix
it, and credit you in the release notes unless you'd rather stay anonymous.

This covers the MCP server in this repository and the hosted endpoint at
`https://wuapi.dev/api/mcp`. For the wuapi API itself, use the same form; we
route it to the right place.

## Supported versions

Fixes ship in a new release of the latest minor version. We're pre-1.0, so
upgrade to the newest `0.x` to get them. `npx -y @wuapidev/mcp` always runs
the latest.
