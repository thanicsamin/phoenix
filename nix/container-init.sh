#!/sbin/busybox sh
set -eu

# A persistent store hides image contents. Seed new paths before running any
# dynamically linked program; keep existing packages and profile generations.
for source in /opt/nix-store/*; do
  name=${source##*/}
  target=/nix/store/$name
  if [ ! -e "$target" ]; then
    temporary=/nix/store/.phoenix-seed-$name
    /sbin/busybox rm -rf "$temporary"
    /sbin/busybox cp -a "$source" "$temporary"
    /sbin/busybox mv "$temporary" "$target"
  fi
done
nix-store --load-db < /etc/nix/registration
mkdir -p /nix/var/nix/gcroots
index=0
while read -r root; do
  index=$((index + 1))
  ln -sfn "$root" "/nix/var/nix/gcroots/phoenix-$index"
done < /etc/nix/closure-roots
exec "$@"
