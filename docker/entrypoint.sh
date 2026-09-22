#!/bin/sh
# Railway bind-mounts the volume as root:root and hides the image's /data.
# The app runs as `node`, so create the dirs and hand ownership over before start.
set -eu

mkdir -p /data/proofs /data/qr-tmp

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
