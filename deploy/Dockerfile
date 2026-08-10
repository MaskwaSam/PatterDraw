FROM nginx:stable-alpine@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46

ARG PATTERDRAW_GIT_COMMIT
ARG PATTERDRAW_MANIFEST_SHA256
ARG PATTERDRAW_RELEASE_TREE_SHA256
ARG PATTERDRAW_DEPLOY_CONFIG_SHA256

LABEL org.opencontainers.image.title="PatterDraw" \
      org.opencontainers.image.description="Offline-first classroom drawing editor" \
      org.opencontainers.image.revision="${PATTERDRAW_GIT_COMMIT}" \
      ca.spatterson.patterdraw.manifest-sha256="${PATTERDRAW_MANIFEST_SHA256}" \
      ca.spatterson.patterdraw.release-tree-sha256="${PATTERDRAW_RELEASE_TREE_SHA256}" \
      ca.spatterson.patterdraw.deploy-config-sha256="${PATTERDRAW_DEPLOY_CONFIG_SHA256}"

COPY deploy/Dockerfile /tmp/patterdraw-deploy/Dockerfile
COPY deploy/compose.yaml /tmp/patterdraw-deploy/compose.yaml
COPY deploy/nginx.conf /tmp/patterdraw-deploy/nginx.conf
COPY deploy/security-headers.conf /tmp/patterdraw-deploy/security-headers.conf
RUN set -eu; \
    printf '%s\n' "$PATTERDRAW_DEPLOY_CONFIG_SHA256" | grep -Eq '^[0-9a-f]{64}$'; \
    cd /tmp/patterdraw-deploy; \
    : > /tmp/patterdraw-deploy.inventory; \
    for file in Dockerfile compose.yaml nginx.conf security-headers.conf; do \
      file_sha256="$(sha256sum "$file" | awk '{print $1}')"; \
      printf '%s  %s\n' "$file_sha256" "$file" >> /tmp/patterdraw-deploy.inventory; \
    done; \
    actual_deploy_config_sha256="$(sha256sum /tmp/patterdraw-deploy.inventory | awk '{print $1}')"; \
    test "$actual_deploy_config_sha256" = "$PATTERDRAW_DEPLOY_CONFIG_SHA256"; \
    mkdir -p /etc/nginx/includes; \
    cp nginx.conf /etc/nginx/nginx.conf; \
    cp security-headers.conf /etc/nginx/includes/patterdraw-security.conf; \
    chmod 0444 /etc/nginx/nginx.conf /etc/nginx/includes/patterdraw-security.conf; \
    rm -rf /tmp/patterdraw-deploy /tmp/patterdraw-deploy.inventory
# The base image ships default pages. Remove all of them (including dotfiles)
# before copying the reviewed release so inherited files cannot become an
# unlisted payload.
RUN rm -rf /usr/share/nginx/html/* /usr/share/nginx/html/.[!.]* /usr/share/nginx/html/..?*
COPY dist/release/ /usr/share/nginx/html/

RUN set -eu; \
    nginx -t; \
    test "$(id -u nginx)" = 101; \
    test "$(id -g nginx)" = 101; \
    printf '%s\n' "$PATTERDRAW_GIT_COMMIT" | grep -Eq '^[0-9a-f]{40}$'; \
    printf '%s\n' "$PATTERDRAW_MANIFEST_SHA256" | grep -Eq '^[0-9a-f]{64}$'; \
    printf '%s\n' "$PATTERDRAW_RELEASE_TREE_SHA256" | grep -Eq '^[0-9a-f]{64}$'; \
    printf '%s\n' "$PATTERDRAW_DEPLOY_CONFIG_SHA256" | grep -Eq '^[0-9a-f]{64}$'; \
    cd /usr/share/nginx/html; \
    test -f index.html; \
    test -f SHA256SUMS; \
    test -f provenance.json; \
    test -f release-manifest.json; \
    sha256sum -c SHA256SUMS; \
    printf '%s  %s\n' "$PATTERDRAW_MANIFEST_SHA256" release-manifest.json | sha256sum -c -; \
    grep -Eq '"releaseMode"[[:space:]]*:[[:space:]]*"final"' provenance.json; \
    grep -Eq '"dirty"[[:space:]]*:[[:space:]]*false' provenance.json; \
    grep -Fq "\"commit\": \"$PATTERDRAW_GIT_COMMIT\"" provenance.json; \
    grep -Eq '"releaseMode"[[:space:]]*:[[:space:]]*"final"' release-manifest.json; \
    grep -Eq '"sourceDirty"[[:space:]]*:[[:space:]]*false' release-manifest.json; \
    grep -Fq "\"gitCommit\": \"$PATTERDRAW_GIT_COMMIT\"" release-manifest.json; \
    if find . -type l -print -quit | grep -q .; then \
      echo 'Release payload must not contain symbolic links.' >&2; \
      exit 1; \
    fi; \
    if find . -type f -name '*.map' -print -quit | grep -q .; then \
      echo 'Release payload must not contain source maps.' >&2; \
      exit 1; \
    fi; \
    find . -type f -print | LC_ALL=C sort > /tmp/patterdraw-release.paths; \
    : > /tmp/patterdraw-release.inventory; \
    while IFS= read -r file; do \
      case "$file" in \
        ./*) relative="${file#./}" ;; \
        *) echo "Release inventory path is not relative: $file" >&2; exit 1 ;; \
      esac; \
      case "$relative" in \
        *[!A-Za-z0-9._/-]*) echo "Release inventory path contains unsupported characters: $relative" >&2; exit 1 ;; \
      esac; \
      file_sha256="$(sha256sum "$file" | awk '{print $1}')"; \
      printf '%s  %s\n' "$file_sha256" "$relative" >> /tmp/patterdraw-release.inventory; \
    done < /tmp/patterdraw-release.paths; \
    actual_release_tree_sha256="$(sha256sum /tmp/patterdraw-release.inventory | awk '{print $1}')"; \
    test "$actual_release_tree_sha256" = "$PATTERDRAW_RELEASE_TREE_SHA256"; \
    rm -f /tmp/patterdraw-release.paths /tmp/patterdraw-release.inventory; \
    find . -type d -exec chmod 0555 {} \;; \
    find . -type f -exec chmod 0444 {} \;

EXPOSE 8080

USER 101:101
STOPSIGNAL SIGQUIT
ENTRYPOINT ["nginx", "-g", "daemon off;"]
