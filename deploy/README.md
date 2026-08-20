# PatterDraw deployment

This package serves a verified, final `dist/release/` at the two exact hostnames `https://draw.spatterson.ca` and `https://patterdraw.spatterson.ca` from a separate non-root NGINX container. It has no backend, server-side student data, published host port, remote asset dependency, or persistent volume. NGINX does not redirect between the hostnames and its rejecting default server does not accept wildcard or other Host values.

Browser-local projects do not automatically move between these hostnames. IndexedDB is origin-scoped, so a project saved at `https://draw.spatterson.ca` is not visible at `https://patterdraw.spatterson.ca`, or vice versa. To move a project, export its `.patterdraw` file from the original hostname and import that file at the other hostname.

## Intended request path

```text
Browser -> Cloudflare edge -> managed spatterson-site Tunnel
        -> standalone spatterson-cloudflared -> dedicated patterdraw_edge
        -> patterdraw:8080 -> NGINX
```

PatterDraw must join only the dedicated external `patterdraw_edge` network. Attach the existing standalone `spatterson-cloudflared` connector to that network in addition to its existing site network; do not attach PatterDraw to `spatterson-site_default`, and never stop or recreate the connector. This preserves the main site's current path while removing lateral network reach from the public PatterDraw container.

The public route is intended to be public without Cloudflare Access. Adding the Published application route exposes it to the Internet; confirm that boundary before cutover.

## Release gate

1. Review and commit the exact source tree. Do not deploy an artifact created with `--allow-dirty`.
2. Run the repository's full production checks, security audit, final package command, and final verifier.
3. Run `node deploy/verify-config.mjs`. It re-runs the release verifier without a dirty override, requires the current checkout to be clean and at the release commit, and prints five non-secret Compose values derived from the commit, manifest, release tree, reviewed deployment files, and image tag.
4. Render `deploy/compose.yaml` with those values and verify that it has no `ports` entry, is hard-bound to the pre-existing external `patterdraw_edge` network, and names a unique immutable image tag.
5. Build from the reviewed deployment context. The Dockerfile independently verifies `SHA256SUMS`, clean/final provenance, the exact commit, the manifest hash, the exact release-tree inventory hash, the deployment configuration hash, absence of source maps, and absence of symlinks.

`node deploy/verify-config.mjs --config-only` checks the deployment files without accepting the current release as deployable.

### Release-tree binding

`PATTERDRAW_RELEASE_TREE_SHA256` is a deterministic cryptographic anchor over
every regular file copied from `dist/release/`, including each relative path and
the bytes of the release metadata and `SHA256SUMS`. `verify-config.mjs` emits the
anchor only after `scripts/package-release.mjs --verify` accepts the final tree.
The Dockerfile clears NGINX's stock HTML directory, copies the release, and
recomputes the same sorted inventory before the image can be built. A changed
JavaScript file, rewritten checksum list, inherited/default file, or extra
unlisted file therefore fails the build even if a mutable `SHA256SUMS` file was
edited to match it. The standalone command can inspect or verify an inventory:

```sh
node deploy/release-inventory.mjs dist/release
node deploy/release-inventory.mjs dist/release "$PATTERDRAW_RELEASE_TREE_SHA256"
```

The inventory intentionally accepts only portable release paths made of ASCII
letters, digits, `.`, `_`, `-`, and `/`, so the line format remains unambiguous
in both Node and the minimal BusyBox tools in the final image.

### Deployment-configuration binding

`PATTERDRAW_DEPLOY_CONFIG_SHA256` binds the exact `Dockerfile`, Compose model,
NGINX virtual host, and security-header policy reviewed with the release. The
verifier emits it only when the current checkout is clean and matches the
release commit. The Docker build copies those four source files into a private
build stage directory, recomputes the same inventory before installing NGINX
configuration, and retains the anchor as an image/container label. This keeps
a retained app release from being relabelled with configuration from another
checkout and makes transfer drift fail the build.

```sh
node deploy/deploy-config-inventory.mjs deploy
node deploy/deploy-config-inventory.mjs deploy "$PATTERDRAW_DEPLOY_CONFIG_SHA256"
```

## Live-state gate before any change

Capture all of the following for both `draw.spatterson.ca` and `patterdraw.spatterson.ca` before changing Cloudflare:

- the complete HTTP and HTTPS response chain;
- DNS record type, content, proxy state, TTL, and provider record identifier;
- every existing Published application route;
- hostname-scoped Redirect Rule, Page Rule, Worker route, Bulk Redirect, Transform Rule, cache rule, and Access application or account-wide Access protection setting.

The exact pre-change record and rule set is the DNS/Cloudflare rollback point. Do not assume the existing redirect comes from DNS alone.

Also capture the running app/site/connector containers, their networks and restart counts, the `spatterson-site_default` network identity, current host listeners, and the apex/`www`/`mesconline.ca` public responses. Confirm that `patterdraw_edge` does not already contain an unexpected container or `patterdraw` alias. Do not inspect environment variables or secret contents.

## Private-origin acceptance

Before adding a public hostname:

- start only the `patterdraw` service and wait for its health check;
- create or reuse only the dedicated `patterdraw_edge` network, attach the existing connector to it without disconnecting its site network, and confirm PatterDraw has no membership in `spatterson-site_default`;
- confirm it is non-root, read-only, capability-free, resource-bounded, log-bounded, and has no host port;
- from the connector's actual Docker network, require both `Host: draw.spatterson.ca` and `Host: patterdraw.spatterson.ca` to return the same app without a redirect, and require an arbitrary Host to return no usable response;
- require GET/HEAD-only behavior, uncached `404` responses for missing or traversal-like assets, `no-store, no-transform` on every HTML entry/fallback path, immutable caching only for existing hashed `assets/`, and CSP/HSTS/nosniff/frame protections;
- require the main app to allow only same-origin frames while remaining unframeable itself, and require `/geogon/` to use its narrower child CSP with `connect-src 'none'`, `frame-ancestors 'self'`, and `X-Frame-Options: SAMEORIGIN`;
- restart only PatterDraw and prove health returns without touching the main site or connector.

## Cutover and acceptance

Only after the private origin passes, route each authorized exact hostname to the Service URL `http://patterdraw:8080`. Preserve the working `draw.spatterson.ca` route when adding `patterdraw.spatterson.ca`; do not create a wildcard route or a redirect between the names. Resolve only a confirmed exact-host conflict and remove only confirmed hostname-scoped redirect behavior.

Acceptance requires public HTTPS `200` at both exact PatterDraw hostnames, valid certificates, expected security/cache headers, a working board and local persistence, no redirect to Moodle or between the PatterDraw hostnames, and no remote application requests. The final edge must preserve `Cache-Control: no-store, no-transform` on HTML and must not inject an analytics beacon. Recheck that `https://spatterson.ca`, `https://www.spatterson.ca`, `https://mesconline.ca`, the standalone connector, email DNS, and router TCP 443 ownership are unchanged.

## Image rollback checkpoint

Before recreating an existing PatterDraw container, record its exact image reference, immutable image ID, revision label, manifest-SHA label, release-tree-SHA label, deployment-config-SHA label, container ID, health/restart state, and the exact non-secret Compose values that select it. Require those labels to match the retained release provenance before accepting the checkpoint. Preserve the prior image locally and prove that a scoped `--no-build` recreation can select it; a rollback must never build from the current source or an unverified `dist/release/`.

The active release session must print a concrete rollback command containing its verified deployment path, Compose file, checkpoint file, prior image tag, and only the `patterdraw` service. That command must use `docker compose up -d --no-deps --no-build --force-recreate --wait patterdraw`. Do not leave placeholders or unresolved shell variables in the operator's rollback command.

For a first deployment there is no prior PatterDraw image. Its rollback is to restore the captured exact-host Cloudflare behavior first, verify the previous response for each affected hostname, and then stop only the new PatterDraw service. The main site and connector remain running.

## Rollback

If public acceptance fails, restore only the captured exact-host rule/route/DNS state in the order that points each affected hostname back to its previous behavior. Do not stop or recreate `spatterson-cloudflared`. If the hostname is healthy but the candidate image fails, use the printed `--no-build` checkpoint to switch only the PatterDraw service back to the retained and label-verified prior image. Keep the exact release tree, current and prior images, Cloudflare before-state, Compose checkpoints, and rollback command until the acceptance window closes.
