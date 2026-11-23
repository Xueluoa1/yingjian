#!/bin/sh
# Run once on a Linux AMD64 Docker builder. Does not deploy/replace yingjian-lan.
set -eu
umask 077
fail() { printf '%s\n' "Error: $*" >&2; exit 1; }
ROOT=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
cd "$ROOT"
[ "$#" -le 1 ] || fail "Usage: sh scripts/build-nas-image.sh [output-parent]"
command -v docker >/dev/null 2>&1 || fail "Docker is required on the build machine."
docker info >/dev/null 2>&1 || fail "Docker is not running or this account lacks access."
platform=$(docker info --format '{{.OSType}}/{{.Architecture}}')
case "$platform" in linux/amd64|linux/x86_64) ;; *) fail "Build on a Linux AMD64 Docker engine." ;; esac
OUTPUT=${1:-"$ROOT/release"}
mkdir -p "$OUTPUT"
OUTPUT=$(CDPATH= cd -P "$OUTPUT" && pwd)
BUNDLE="$OUTPUT/Yingjian-Server-0.1.4-nas1-linux-amd64-Offline"
[ ! -e "$BUNDLE" ] || fail "Output exists. Choose a new output directory."
WORK=$(mktemp -d "$OUTPUT/.yingjian-image-build.XXXXXXXX")
suffix=${WORK##*.}
CONTAINER="yingjian-image-check-$suffix"
VOLUME="yingjian-image-check-$suffix"
TEMP_TAG="yingjian-image-build:$suffix"
FINAL_TAG=yingjian-server:0.1.4-nas1
LABEL="yingjian.image-verification=$suffix"
created_container=0
created_volume=0
cleanup() {
  result=$?
  trap - 0 HUP INT TERM
  if [ "$created_container" -eq 1 ]; then docker container rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  if [ "$created_volume" -eq 1 ]; then docker volume rm "$VOLUME" >/dev/null 2>&1 || true; fi
  docker image rm "$TEMP_TAG" >/dev/null 2>&1 || true
  # Only this script's mktemp directory; never application or household paths.
  case "$WORK" in "$OUTPUT"/.yingjian-image-build.*) rm -rf "$WORK" ;; esac
  exit "$result"
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' HUP TERM
for name in docker-compose.yml .env.example deploy.sh README.md; do
  [ -f "$ROOT/deployment/nas-offline/$name" ] || fail "Missing offline template: $name"
done
printf '%s\n' "[1/5] Building application image. Existing containers are not changed."
docker build --platform linux/amd64 \
  --build-arg "NODE_IMAGE=${NODE_IMAGE:-public.ecr.aws/docker/library/node:24-alpine}" \
  --file "$ROOT/deployment/nas/Dockerfile" --tag "$TEMP_TAG" "$ROOT"
identity=$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$TEMP_TAG")
IMAGE_ID=${identity%% *}
[ "$identity" = "$IMAGE_ID linux/amd64" ] || fail "Unexpected built image platform."
docker volume inspect "$VOLUME" >/dev/null 2>&1 && fail "Temporary volume name collision."
docker container inspect "$CONTAINER" >/dev/null 2>&1 && fail "Temporary container name collision."
docker volume create --label "$LABEL" "$VOLUME" >/dev/null
created_volume=1
password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
[ "${#password}" -eq 48 ] || fail "Cannot generate an isolated test password."
printf 'ADMIN_PASSWORD=%s\nPUBLIC_ORIGIN=http://127.0.0.1:8080\n' "$password" > "$WORK/test.env"
unset password
start_test_container() {
  docker create --name "$CONTAINER" --label "$LABEL" --network none \
    --env-file "$WORK/test.env" --mount "type=volume,source=$VOLUME,target=/app/data" \
    --health-interval 2s --health-start-period 3s --health-timeout 3s --health-retries 10 \
    "$IMAGE_ID" >/dev/null
  created_container=1
  docker start "$CONTAINER" >/dev/null
  attempt=0
  while [ "$attempt" -lt 45 ]; do
    state=$(docker inspect --format '{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER")
    case "$state" in
      running:healthy) return ;;
      running:starting) ;;
      *) docker logs --tail 30 "$CONTAINER" >&2; fail "Test container failed: $state" ;;
    esac
    attempt=$((attempt + 1))
    sleep 2
  done
  docker logs --tail 30 "$CONTAINER" >&2
  fail "Container startup timed out."
}
printf '%s\n' "[2/5] Checking non-root startup, login, assets, and TV pairing."
start_test_container
docker exec -i --env SMOKE_PHASE=prepare "$CONTAINER" node --input-type=module \
  < "$ROOT/scripts/nas-image-smoke.mjs" > "$WORK/prepare.json"
printf '%s\n' "[3/5] Recreating the test container and checking saved settings."
docker stop --time 30 "$CONTAINER" >/dev/null
docker container rm "$CONTAINER" >/dev/null
created_container=0
start_test_container
docker exec -i --env SMOKE_PHASE=restore "$CONTAINER" node --input-type=module \
  < "$ROOT/scripts/nas-image-smoke.mjs" > "$WORK/restore.json"
printf '%s\n' "[4/5] Exporting the verified application image."
STAGE="$WORK/bundle"
mkdir "$STAGE"
chmod 755 "$STAGE"
docker tag "$IMAGE_ID" "$FINAL_TAG"
docker save --output "$STAGE/image.tar" "$FINAL_TAG"
archive_hash=$(sha256sum "$STAGE/image.tar")
archive_hash=${archive_hash%% *}
archive_bytes=$(wc -c < "$STAGE/image.tar" | tr -d ' ')
printf 'IMAGE_ID=%s\nIMAGE_PLATFORM=linux/amd64\n' "$IMAGE_ID" > "$STAGE/image-metadata.txt"
printf '%s  image.tar\n' "$archive_hash" > "$STAGE/image.tar.sha256"
verified_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
cat > "$STAGE/verification.json" <<EOF
{
  "schemaVersion": 1,
  "appVersion": "0.1.4",
  "verificationMode": "docker-runtime",
  "verifiedAt": "$verified_at",
  "passed": true,
  "image": {"tag": "$FINAL_TAG", "id": "$IMAGE_ID", "platform": "linux/amd64"},
  "archive": {"file": "image.tar", "sha256": "$archive_hash", "bytes": $archive_bytes},
  "checks": {"nonRoot": true, "health": true, "adminLogin": true, "staticAssets": true, "persistenceRecreate": true, "pairing": true}
}
EOF
for name in docker-compose.yml .env.example deploy.sh README.md; do
  cp "$ROOT/deployment/nas-offline/$name" "$STAGE/$name"
done
cp "$ROOT/THIRD-PARTY.md" "$STAGE/THIRD-PARTY.md"
chmod 644 "$STAGE/"* "$STAGE/.env.example"
# The builder needs no host Node installation. This isolated helper hashes files.
cp "$ROOT/scripts/verify-nas-offline.mjs" "$WORK/verify.mjs"
chmod 644 "$WORK/verify.mjs"
printf '%s\n' "[5/5] Verifying archive identity and writing the complete manifest."
docker run --rm --network none --read-only --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$STAGE,target=/bundle" \
  --mount "type=bind,source=$WORK/verify.mjs,target=/verify.mjs,readonly" \
  --entrypoint node "$IMAGE_ID" /verify.mjs /bundle --write-manifest
[ -s "$STAGE/manifest.json" ] || fail "Archive verification did not produce a manifest."
# Publish only a complete verified directory. The result contains no test data.
mv "$STAGE" "$BUNDLE"
printf '%s\n' "Complete offline release: $BUNDLE" \
  "Existing application containers and household data were not modified."
