FROM nixos/nix@sha256:7a007c766426c1877758ddc5cb87a965ac131fc78c582ce0083d922d51ae945c AS build
WORKDIR /build
COPY flake.lock ./
COPY nix/runtime.nix ./nix/runtime.nix
RUN nix --extra-experimental-features 'nix-command flakes' build --impure --expr 'let lock = builtins.fromJSON (builtins.readFile ./flake.lock); pkgs = import (builtins.getFlake ("github:NixOS/nixpkgs/" + lock.nodes.nixpkgs.locked.rev)).outPath {}; in import ./nix/runtime.nix { inherit pkgs; }' --out-link /build/runtime
COPY flake.nix package.json package-lock.json ./
COPY nix/module.nix ./nix/module.nix
COPY nix/agent-flake.nix ./nix/agent-flake.nix
COPY nix/container-init.sh ./nix/container-init.sh
COPY src ./src
COPY extensions ./extensions
COPY web ./web
COPY agent.json ./
COPY PHOENIX.md ./
RUN nix --extra-experimental-features 'nix-command flakes' build .#default --out-link /build/app \
    && nix --extra-experimental-features 'nix-command flakes' build .#bootstrap --out-link /build/busybox \
    && mkdir -p /rootfs/nix/store /rootfs/opt/nix-store /rootfs/sbin /rootfs/data/tmp /rootfs/tmp /rootfs/etc /rootfs/app \
    && nix-store --query --requisites /build/app /build/runtime > /build/closure \
    && while read -r path; do cp -a "$path" /rootfs/opt/nix-store/; done < /build/closure \
    && cp /build/busybox/bin/busybox /rootfs/sbin/busybox \
    && cp nix/container-init.sh /rootfs/sbin/phoenix-init \
    && cp -a /build/app/share/phoenix/. /rootfs/app/ \
    && ln -s "$(readlink -f /build/runtime)/bin" /rootfs/bin \
    && cp /build/runtime/etc/ssl/certs/ca-bundle.crt /rootfs/etc/ca-bundle.crt \
    && cp -a /build/runtime/etc/fonts /rootfs/etc/fonts \
    && mkdir -p /rootfs/etc/nix /rootfs/nix/var/nix /rootfs/usr/bin \
    && ln -s /bin/env /rootfs/usr/bin/env \
    && nix-store --dump-db $(cat /build/closure) > /rootfs/etc/nix/registration \
    && readlink -f /build/app /build/runtime > /rootfs/etc/nix/closure-roots \
    && printf 'experimental-features = nix-command flakes\nbuild-users-group =\nsandbox = false\nbuild-dir = /data/tmp\nauto-optimise-store = true\nmax-jobs = 1\ncores = 1\n' > /rootfs/etc/nix/nix.conf \
    && printf 'root:x:0:0:root:/data:/bin/bash\nphoenix:x:1000:1000:Phoenix:/data:/bin/bash\n' > /rootfs/etc/passwd \
    && printf 'root:x:0:\nphoenix:x:1000:\n' > /rootfs/etc/group \
    && chmod 1777 /rootfs/tmp \
    && chown 1000:1000 /rootfs/data

FROM scratch
# Recommended runtime budget. Image metadata cannot enforce Docker host limits;
# compose.yaml applies these defaults (override with PHOENIX_*_LIMIT in .env).
LABEL io.phoenix.resources.memory="2g" \
    io.phoenix.resources.cpus="1" \
    io.phoenix.resources.shm="256m" \
    io.phoenix.resources.tmp="64m"
COPY --from=build /rootfs /
ENV NODE_OPTIONS=--max-old-space-size=256 UV_PYTHON_DOWNLOADS=never UV_PYTHON_PREFERENCE=only-system TMPDIR=/data/tmp NIX_LOG_DIR=/data/nix-log PATH=/data/.nix-profile/bin:/bin HOME=/data NIX_REMOTE=local PHOENIX_CONFIG=/app/agent.json PHOENIX_DATA=/data PHOENIX_BIND=0.0.0.0 \
    CHROMIUM_PATH=/bin/chromium FONTCONFIG_FILE=/etc/fonts/fonts.conf SSL_CERT_FILE=/etc/ca-bundle.crt NODE_EXTRA_CA_CERTS=/etc/ca-bundle.crt
WORKDIR /app
USER 0:0
EXPOSE 8080
VOLUME ["/data", "/nix/store", "/nix/var/nix"]
HEALTHCHECK --interval=30s --timeout=3s CMD ["/bin/node", "-e", "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/sbin/busybox", "sh", "/sbin/phoenix-init"]
CMD ["/bin/node", "src/bootstrap.js"]
