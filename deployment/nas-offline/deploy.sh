#!/bin/sh
# Offline application image deployment. Run with "sh deploy.sh start".
set -eu
umask 077

fail() { printf '%s\n' "Error: $*" >&2; exit 1; }
SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"
ENV_FILE="$SCRIPT_DIR/.env"
COMPOSE_FILE_PATH="$SCRIPT_DIR/docker-compose.yml"
IMAGE_TAG=yingjian-server:0.1.4-nas1
IMAGE_ARCHIVE="$SCRIPT_DIR/image.tar"
ACTION=${1:-start}
case "$ACTION" in
  start|stop|update|status|validate) ;;
  *) fail "Usage: sh deploy.sh [start|stop|update|status|validate]" ;;
esac
[ "$#" -le 1 ] || fail "Pass configuration in .env, not command-line arguments."

# Never evaluate .env as code or accept inherited overrides.
unset ADMIN_PASSWORD LAN_BIND_IP HOST_PORT PUBLIC_ORIGIN DATA_VOLUME NODE_IMAGE
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES
unset IMAGE_ID IMAGE_PLATFORM
ADMIN_PASSWORD= LAN_BIND_IP= HOST_PORT= PUBLIC_ORIGIN= DATA_VOLUME=
IMAGE_ID= IMAGE_PLATFORM=
seen='|'
cr=$(printf '\r')
[ -f "$ENV_FILE" ] || fail "Missing .env. Copy .env.example and fill in your NAS settings."
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%"$cr"}
  case "$line" in ''|\#*) continue ;; esac
  case "$line" in *=*) ;; *) fail "Invalid .env line: expected KEY=value." ;; esac
  key=${line%%=*}
  raw=${line#*=}
  case "$key" in ADMIN_PASSWORD|LAN_BIND_IP|HOST_PORT|PUBLIC_ORIGIN|DATA_VOLUME|NODE_IMAGE) ;;
    *) fail "Unsupported .env key. Use only the documented settings." ;;
  esac
  case "$seen" in *"|$key|"*) fail "Duplicate .env key: $key." ;; esac
  seen="$seen$key|"
  case "$raw" in
    \'*\') value=${raw#\'}; value=${value%\'} ;;
    *) case "$raw" in *[!a-zA-Z0-9_./:@%+=,-]*) fail "Use single-quoted .env values for punctuation or spaces." ;; esac
       value=$raw ;;
  esac
  case "$value" in *"'"*|*\\*) fail "Apostrophes and backslashes are not supported in .env values." ;; esac
  if printf '%s' "$value" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1; then
    fail "Control characters are not supported in .env values."
  fi
  case "$key" in
    ADMIN_PASSWORD) ADMIN_PASSWORD=$value ;;
    LAN_BIND_IP) LAN_BIND_IP=$value ;;
    HOST_PORT) HOST_PORT=$value ;;
    PUBLIC_ORIGIN) PUBLIC_ORIGIN=$value ;;
    DATA_VOLUME) DATA_VOLUME=$value ;;
    NODE_IMAGE) : ;; # Compatibility with older source bundles; never used.
  esac
done < "$ENV_FILE"

[ "${#ADMIN_PASSWORD}" -ge 12 ] && [ "${#ADMIN_PASSWORD}" -le 128 ] ||
  fail "ADMIN_PASSWORD must contain 12 to 128 characters."
[ "$ADMIN_PASSWORD" != replace-with-your-own-password ] ||
  fail "Replace the example administrator password."
if ! printf '%s\n' "$LAN_BIND_IP" | awk -F. '
  NF != 4 { exit 1 }
  {
    for (i=1; i<=4; i++)
      if ($i !~ /^[0-9]+$/ || $i > 255 || (length($i)>1 && substr($i,1,1)=="0")) exit 1
    if (!($1==10 || ($1==172 && $2>=16 && $2<=31) || ($1==192 && $2==168))) exit 1
  }'; then
  fail "LAN_BIND_IP must be the NAS private IPv4 address."
fi
case "$HOST_PORT" in ''|0*|*[!0-9]*) fail "HOST_PORT must be an integer from 1 to 65535." ;; esac
[ "${#HOST_PORT}" -le 5 ] && [ "$HOST_PORT" -le 65535 ] ||
  fail "HOST_PORT must be an integer from 1 to 65535."
[ "$PUBLIC_ORIGIN" = "http://$LAN_BIND_IP:$HOST_PORT" ] ||
  fail "PUBLIC_ORIGIN must equal http://LAN_BIND_IP:HOST_PORT."
DATA_VOLUME=${DATA_VOLUME:-yingjian-data}
valid_volume() {
  case "$1" in
    [a-zA-Z0-9]*) case "$1" in *[!a-zA-Z0-9_.-]*) return 1 ;; esac ;;
    *) return 1 ;;
  esac
  [ "${#1}" -le 128 ]
}
valid_volume "$DATA_VOLUME" || fail "Invalid DATA_VOLUME name."
export ADMIN_PASSWORD LAN_BIND_IP HOST_PORT PUBLIC_ORIGIN DATA_VOLUME

# The release builder writes these exact values after validating the real image.
# No sourcing, substitutions, paths, or arbitrary image tags enter this parser.
[ -f image-metadata.txt ] || fail "Missing image-metadata.txt. This is not a complete offline release."
seen='|'
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%"$cr"}
  case "$line" in
    IMAGE_ID=*|IMAGE_PLATFORM=*) ;;
    *) fail "Invalid image metadata." ;;
  esac
  key=${line%%=*}
  value=${line#*=}
  case "$seen" in *"|$key|"*) fail "Duplicate image metadata: $key." ;; esac
  seen="$seen$key|"
  case "$key" in
    IMAGE_ID) IMAGE_ID=$value ;;
    IMAGE_PLATFORM) IMAGE_PLATFORM=$value ;;
  esac
done < image-metadata.txt
case "$IMAGE_ID" in sha256:*) digest=${IMAGE_ID#sha256:} ;; *) fail "Invalid image ID." ;; esac
case "$digest" in *[!a-f0-9]*|'') fail "Invalid image ID." ;; esac
[ "${#digest}" -eq 64 ] || fail "Invalid image ID."
[ "$IMAGE_PLATFORM" = linux/amd64 ] || fail "This bundle must contain a validated linux/amd64 image."

if [ "$ACTION" = validate ]; then
  printf '%s\n' "Configuration and image metadata are valid. NAS address: $PUBLIC_ORIGIN" \
    "Archive integrity and actual container startup are checked by start or update."
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "Install and start Docker on the NAS first."
docker info >/dev/null 2>&1 || fail "Docker is unavailable. Check the NAS Docker service and your account access."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required for offline pull_policy: never."
PROJECT_NAME=yingjian-server
compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE_PATH" -p "$PROJECT_NAME" "$@"
}

# Reuse the actual mount and project even if the previous container cannot start.
if docker container inspect yingjian-lan >/dev/null 2>&1; then
  mounted=$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Type}}:{{.Name}}{{end}}{{end}}' yingjian-lan)
  case "$mounted" in volume:?*) old_volume=${mounted#volume:} ;;
    *) fail "Existing yingjian-lan has an unsupported /app/data mount. It was left unchanged." ;;
  esac
  old_project=$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' yingjian-lan)
  old_service=$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' yingjian-lan)
  [ "$old_service" = yingjian ] || fail "Existing yingjian-lan belongs to another service. It was left unchanged."
  case "$old_project" in
    [a-z0-9]*) case "$old_project" in *[!a-z0-9_-]*) fail "Cannot determine the existing Compose project." ;; esac ;;
    *) fail "Cannot determine the existing Compose project." ;;
  esac
  PROJECT_NAME=$old_project
  if [ "$DATA_VOLUME" != yingjian-data ] && [ "$DATA_VOLUME" != "$old_volume" ]; then
    fail "DATA_VOLUME conflicts with the existing server. Keep its current volume to preserve data."
  fi
  DATA_VOLUME=$old_volume
elif [ "$DATA_VOLUME" = yingjian-data ]; then
  candidates=$(docker volume ls --filter label=com.docker.compose.volume=yingjian-data --format '{{.Name}}')
  count=$(printf '%s\n' "$candidates" | awk 'NF { count++ } END { print count+0 }')
  if [ "$count" -gt 1 ]; then
    fail "Multiple previous data volumes exist. Set DATA_VOLUME to the intended one; no container was changed."
  elif [ "$count" -eq 1 ]; then
    DATA_VOLUME=$candidates
  fi
fi
valid_volume "$DATA_VOLUME" || fail "Detected an invalid volume name."
export DATA_VOLUME
compose config --quiet >/dev/null || fail "Compose cannot validate this bundle. No container was changed."

case "$ACTION" in
  stop)
    compose stop
    printf '%s\n' "Server stopped. Data volume retained: $DATA_VOLUME"
    exit 0 ;;
  status)
    compose ps
    exit 0 ;;
esac

host_platform=$(docker info --format '{{.OSType}}/{{.Architecture}}')
case "$host_platform" in linux/amd64|linux/x86_64) ;;
  *) fail "This release requires a Linux x86-64 / AMD64 NAS; detected: $host_platform." ;;
esac
[ -f "$IMAGE_ARCHIVE" ] && [ -f image.tar.sha256 ] ||
  fail "Missing image.tar or image.tar.sha256. Use the complete offline release."
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required to verify the offline image."
# Validate the checksum file ourselves: it cannot select other files or options.
if ! expected_hash=$(LC_ALL=C awk '
  NR != 1 || NF != 2 || $2 != "image.tar" || $1 !~ /^[a-f0-9]+$/ || length($1) != 64 { invalid=1 }
  NR == 1 { hash=$1 }
  END { if (NR != 1 || invalid) exit 1; print hash }
' image.tar.sha256); then
  fail "Invalid image.tar.sha256."
fi
actual_hash=$(sha256sum "$IMAGE_ARCHIVE")
actual_hash=${actual_hash%% *}
[ "$actual_hash" = "$expected_hash" ] || fail "Image archive checksum mismatch. Copy the complete release again."
current_id=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG" 2>/dev/null || true)
if [ "$current_id" != "$IMAGE_ID" ]; then
  printf '%s\n' "Importing the included application image..."
  docker load --input "$IMAGE_ARCHIVE"
fi
loaded=$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$IMAGE_TAG") ||
  fail "The imported archive does not contain the expected application tag."
[ "$loaded" = "$IMAGE_ID $IMAGE_PLATFORM" ] ||
  fail "Imported image does not match this release's ID and platform. No container was changed."

# Persist only the selected volume so later GUI imports reuse the same data.
temp_env="$ENV_FILE.tmp.$$"
trap 'rm -f "$temp_env"' 0 HUP INT TERM
awk -v volume="$DATA_VOLUME" '
  /^DATA_VOLUME=/ { print "DATA_VOLUME=" volume; found=1; next }
  { sub(/\r$/, ""); print }
  END { if (!found) print "DATA_VOLUME=" volume }
' "$ENV_FILE" > "$temp_env"
mv "$temp_env" "$ENV_FILE"
trap - 0 HUP INT TERM

compose up -d --no-build --pull never
# "up -d" only means the process was created. Check real startup before success.
attempt=0
while [ "$attempt" -lt 30 ]; do
  state=$(docker container inspect --format '{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' yingjian-lan)
  case "$state" in
    running:healthy)
      printf '%s\n' "Server is healthy: $PUBLIC_ORIGIN" "Data volume retained: $DATA_VOLUME"
      exit 0 ;;
    running:starting|created:starting) ;;
    *) fail "Container did not become healthy (state: $state). Check yingjian-lan logs in the NAS Docker interface." ;;
  esac
  attempt=$((attempt + 1))
  sleep 2
done
fail "Container health check timed out. Check yingjian-lan logs in the NAS Docker interface."
