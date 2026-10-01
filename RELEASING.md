# Releasing the `@wuapidev/mcp` npm package

The MCP server is developed in the wuapi monorepo (`packages/wuapi-mcp`) and
published from its public mirror,
[wuapidev/wuapi-mcp](https://github.com/wuapidev/wuapi-mcp), the same way as
the TypeScript SDK (see `packages/wuapi-sdk/RELEASING.md` for the details of
the sync). Every change to what the package ships goes to npm when it reaches
`main`; you only pick the version.

```
monorepo PR (bump the version)
  -> merge into wuapidev/wuapi main
  -> sync-mcp.yml pushes the folder to wuapidev/wuapi-mcp main
  -> its release.yml publishes to npm with provenance, tags v<version>, creates a GitHub Release
```

The hosted endpoint (`https://wuapi.dev/api/mcp`, `apps/wuapi/app/api/mcp`)
does not wait for npm: it runs this folder's code and deploys with the site.

## Cutting a release

1. In your monorepo pull request, bump the version in two places to the same
   value:
   - `"version"` in `packages/wuapi-mcp/package.json`
   - `VERSION` in `packages/wuapi-mcp/src/version.ts` (`test/version.test.ts`
     fails when the two differ)

   Pre-1.0: a fix bumps the patch, anything else the minor. A version with a
   pre-release part (`0.2.0-beta.0`) publishes under the `next` dist-tag.
2. Merge into `main`. `.github/workflows/sync-mcp.yml` mirrors the folder to
   `wuapidev/wuapi-mcp`, where `.github/workflows/release.yml` typechecks,
   tests and builds it, publishes it with `npm publish --provenance` if npm
   does not have that version yet, then tags `v<version>` and creates a GitHub
   Release.

The `Version bumped` check (`.github/workflows/mcp-version.yml`) fails a pull
request that changes `src/**`, `package.json`, `README.md`, `LICENSE` or
`tsconfig*.json` without a new version. Tests, `scripts/`, `.github/` and
this file need no bump.

A new `@wuapidev/sdk` version reaches this package through the `^0.x` range in
`package.json` without a release here, unless the MCP server needs something
new from it: then raise the range and bump this version.

When one change raises the SDK range here and publishes that SDK version, the
mirrors are pushed at the same moment, so this repository's workflows start
before the SDK is on npm. Their `Wait for the @wuapidev/sdk version this
package needs` step polls `npm view @wuapidev/sdk@<range>` every 20 seconds for
up to 10 minutes before `npm install`, and fails with a message naming the
range if it never appears (then check the SDK mirror's Release run and re-run
this one).

## One-time setup

Done once, by an owner of the `wuapidev` GitHub organization and the
`wuapihq` npm account.

1. **The mirror repository.** Create `wuapidev/wuapi-mcp`: public, completely
   empty (no README, license or .gitignore), description "MCP server for
   wuapi". The first sync pushes the history. Do not add a rule that requires
   status checks on `main` (the sync pushes before CI runs); "no force pushes
   or deletion" is fine. Turn on private vulnerability reporting (Settings >
   Security) for SECURITY.md.
2. **The sync token.** A fine-grained personal access token with resource
   owner `wuapidev`, access to `wuapi-mcp` only, and **Contents** and
   **Workflows** read and write. Store it as the monorepo's Actions secret
   `MCP_REPO_TOKEN`:

   ```sh
   gh secret set MCP_REPO_TOKEN -R wuapidev/wuapi   # prompts for the token
   ```

   Renew it before it expires the same way.
3. **The npm package and trusted publishing.** Signed in to npmjs.com as
   `wuapihq`, add a trusted publisher to `@wuapidev/mcp` (package Settings >
   Trusted publishing, GitHub Actions):
   - Organization or user: `wuapidev`
   - Repository: `wuapi-mcp`
   - Workflow filename: `release.yml`
   - Environment: leave empty

   If npm does not let you configure a package that does not exist yet,
   publish `0.1.0` once by hand from a clean checkout of the mirror
   (`npm ci || npm install`, `npm run build`, `npm publish --access public`,
   with 2FA), then add the trusted publisher, and from then on releases go
   through `release.yml`. Afterwards set the package's publishing access to
   "Require two-factor authentication and disallow tokens".
4. **First sync.** Run **Actions > Sync MCP server > Run workflow** in the
   monorepo (or merge anything under `packages/wuapi-mcp`). Then check
   **Actions > Release** in `wuapi-mcp`: re-run it if it ran before step 3.

No npm token exists anywhere: `release.yml` publishes with the OIDC token of
its run (`id-token: write`).
