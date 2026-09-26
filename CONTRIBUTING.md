# Contributing

Thanks for taking the time to help with the wuapi MCP server.

## This repository is a mirror

The MCP server is developed in the wuapi monorepo, next to the API and the
TypeScript SDK it uses, and every change is copied here automatically. Nobody
commits to this repository directly: the next sync would refuse to run.

## Issues

Issues are welcome: a tool that is missing or confusing, a client that does
not connect, a description that leads a model astray. The package version, the
MCP client and its version, and the tool call that went wrong help a lot.
Never paste your API key.

## Pull requests

You can open a pull request here too. We don't merge it in this repository:
a maintainer ports the change to the monorepo, credits you as co-author, and
it comes back here with the next sync. Your pull request is closed with a
link to the commit that shipped it.

Before you open one:

```sh
npm install
npm run typecheck
npm test
npm run build
```

## Security

Please don't open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
