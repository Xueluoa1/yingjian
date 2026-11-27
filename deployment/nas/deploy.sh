#!/bin/sh
# Portable NAS server control. Run with "sh deploy.sh start"; executable bits are optional.
set -eu
umask 077

fail() { printf '%s\n' "Error: $*" >&2; exit 1; }
SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"
ENV_FILE="$SCRIPT_DIR/.env"
COMPOSE_FILE_PATH="$SCRIPT_DIR/docker-compose.yml"
TARGET_PLATFORM=
if [ -e "$SCRIPT_DIR/target-platform.txt" ]; then
  [ -f "$SCRIPT_DIR/target-platform.txt" ] && [ ! -L "$SCRIPT_DIR/target-platform.txt" ] || fail "Invalid target-platform.txt."
  TARGET_PLATFORM=$(cat "$SCRIPT_DIR/target-platform.txt")
  case "$TARGET_PLATFORM" in linux/amd64|linux/arm64) ;; *) fail "Unsupported target platform; choose AMD64 or ARM64." ;; esac
fi
ACTION=${1:-start}
case "$ACTION" in
  start|stop|update|status|validate) ;;
  *) fail "Usage: sh deploy.sh [start|stop|update|status|validate]" ;;
esac
[ "$#" -le 1 ] || fail "Pass configuration in .env, not command-line arguments."

# Never source/eval .env: only the documented values may enter the Compose environment.
# Clearing them first prevents an inherited shell value from replacing an exported setting.
unset ADMIN_PASSWORD LAN_BIND_IP HOST_PORT PUBLIC_ORIGIN DATA_VOLUME NODE_IMAGE
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES
ADMIN_PASSWORD= LAN_BIND_IP= HOST_PORT= PUBLIC_ORIGIN= DATA_VOLUME= NODE_IMAGE=
seen='|'
cr=$(printf '\r')
[ -f "$ENV_FILE" ] || fail "Missing .env. Export a configured bundle or copy .env.example and edit it."
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%"$cr"}
  case "$line" in ''|\#*) continue ;; esac
  case "$line" in *=*) ;; *) fail "Invalid .env line: expected KEY=value." ;; esac
  key=${line%%=*}
  raw=${line#*=}
  case "$key" in ADMIN_PASSWORD|LAN_BIND_IP|HOST_PORT|PUBLIC_ORIGIN|DATA_VOLUME|NODE_IMAGE) ;;
    *) fail "Unsupported .env key. Use only the six documented keys." ;;
  esac
  case "$seen" in *"|$key|"*) fail "Duplicate .env key: $key." ;; esac
  seen="$seen$key|"
  case "$raw" in
    \'*\') value=${raw#\'}; value=${value%\'} ;;
    *) case "$raw" in *[!a-zA-Z0-9_./:@%+=,-]*) fail "Use single-quoted .env values for punctuation or spaces." ;; esac
       value=$raw ;;
  esac
  # Both the parser and Docker Compose see the same literal value.
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
    NODE_IMAGE) NODE_IMAGE=$value ;;
  esac
done < "$ENV_FILE"

[ "${#ADMIN_PASSWORD}" -ge 12 ] && [ "${#ADMIN_PASSWORD}" -le 128 ] ||
  fail "ADMIN_PASSWORD must contain 12 to 128 characters."
[ "$ADMIN_PASSWORD" != 'replace-with-your-own-password' ] ||
  fail "Replace the example administrator password."

if ! printf '%s\n' "$LAN_BIND_IP" | awk -F. '
  NF != 4 { exit 1 }
  {
    for (i=1; i<=4; i++)
      if ($i !~ /^[0-9]+$/ || $i > 255 || (length($i)>1 && substr($i,1,1)=="0")) exit 1
    if (!($1==10 || ($1==172 && $2>=16 && $2<=31) || ($1==192 && $2==168))) exit 1
  }'; then
  fail "LAN_BIND_IP must be the NAS private IPv4 address (10.*, 172.16-31.*, or 192.168.*)."
fi
case "$HOST_PORT" in ''|0*|*[!0-9]*) fail "HOST_PORT must be an integer from 1 to 65535." ;; esac
[ "${#HOST_PORT}" -le 5 ] && [ "$HOST_PORT" -le 65535 ] ||
  fail "HOST_PORT must be an integer from 1 to 65535."
[ "$PUBLIC_ORIGIN" = "http://$LAN_BIND_IP:$HOST_PORT" ] ||
  fail "PUBLIC_ORIGIN must equal http://LAN_BIND_IP:HOST_PORT."
DATA_VOLUME=${DATA_VOLUME:-yingjian-data}
case "$DATA_VOLUME" in
  [a-zA-Z0-9]*) case "$DATA_VOLUME" in *[!a-zA-Z0-9_.-]*) fail "Invalid DATA_VOLUME name." ;; esac ;;
  *) fail "Invalid DATA_VOLUME name." ;;
esac
[ "${#DATA_VOLUME}" -le 128 ] || fail "DATA_VOLUME name is too long."

# Older exported bundles omit NODE_IMAGE and use this bundle's default.
NODE_IMAGE=${NODE_IMAGE:-public.ecr.aws/docker/library/node:24-alpine}
[ "${#NODE_IMAGE}" -le 512 ] || fail "NODE_IMAGE must contain at most 512 characters."
case "$NODE_IMAGE" in
  *[!a-zA-Z0-9._/:@+-]*) fail "NODE_IMAGE must be a Docker image reference without spaces or shell expressions." ;;
esac
if ! printf '%s\n' "$NODE_IMAGE" | LC_ALL=C awk '
  {
    count = split($0, reference, "@")
    if (count > 2) exit 1
    if (count == 2) {
      if (split(reference[2], digest, ":") != 2 ||
          digest[1] !~ /^[A-Za-z][A-Za-z0-9]*([+._-][A-Za-z][A-Za-z0-9]*)*$/ ||
          digest[2] !~ /^[a-fA-F0-9]+$/ || length(digest[2]) < 32) exit 1
      if ((digest[1] == "sha256" && length(digest[2]) != 64) ||
          (digest[1] == "sha384" && length(digest[2]) != 96) ||
          (digest[1] == "sha512" && length(digest[2]) != 128)) exit 1
    }
    parts = split(reference[1], path, "/")
    first = 1
    if (parts > 1 && (path[1] ~ /[.:]/ || path[1] == "localhost")) {
      hostparts = split(path[1], registry, ":")
      if (hostparts > 2 || registry[1] !~ /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/) exit 1
      labels = split(registry[1], label, ".")
      for (i = 1; i <= labels; i++)
        if (label[i] !~ /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/) exit 1
      if (hostparts == 2 && (registry[2] !~ /^[0-9]+$/ || registry[2] < 1 || registry[2] > 65535)) exit 1
      first = 2
    }
    tagparts = split(path[parts], tagged, ":")
    if (tagparts > 2 || (tagparts == 2 &&
        (tagged[2] !~ /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/ || length(tagged[2]) > 128))) exit 1
    path[parts] = tagged[1]
    for (i = first; i <= parts; i++)
      if (path[i] !~ /^[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*$/) exit 1
  }'; then
  fail "Invalid NODE_IMAGE. Use a repository with an optional registry:port, tag, or digest."
fi
export ADMIN_PASSWORD LAN_BIND_IP HOST_PORT PUBLIC_ORIGIN DATA_VOLUME NODE_IMAGE

if [ "$ACTION" = validate ]; then
  printf '%s\n' "Configuration is valid. NAS address: $PUBLIC_ORIGIN"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "Install and start Docker / Container Manager on the NAS first."
docker info >/dev/null 2>&1 || fail "Docker is unavailable. Check that its service is running and your NAS account has access."
if [ -n "$TARGET_PLATFORM" ]; then
  host_platform=$(docker info --format '{{.OSType}}/{{.Architecture}}')
  case "$host_platform" in
    linux/amd64|linux/x86_64) host_platform=linux/amd64 ;;
    linux/arm64|linux/aarch64) host_platform=linux/arm64 ;;
    *) fail "Unsupported NAS platform: $host_platform. This bundle requires $TARGET_PLATFORM." ;;
  esac
  [ "$host_platform" = "$TARGET_PLATFORM" ] || fail "Wrong deployment package: this NAS is $host_platform, but the bundle is $TARGET_PLATFORM. No container was changed."
  grep -Eq "^[[:space:]]+platform: $TARGET_PLATFORM[[:space:]]*$" "$COMPOSE_FILE_PATH" || fail "Compose platform does not match target-platform.txt."
fi
if docker compose version >/dev/null 2>&1; then
  COMPOSE_KIND=v2
elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
  COMPOSE_KIND=v1
else
  fail "Docker Compose is required (docker compose, or docker-compose with --env-file support)."
fi
PROJECT_NAME=yingjian-server
compose() {
  if [ "$COMPOSE_KIND" = v2 ]; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE_PATH" -p "$PROJECT_NAME" "$@"
  else
    docker-compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE_PATH" -p "$PROJECT_NAME" "$@"
  fi
}

# The old bundle used project-prefixed volumes. Reuse the actual mounted volume
# rather than silently creating an empty "yingjian-data" volume during an upgrade.
if docker container inspect yingjian-lan >/dev/null 2>&1; then
  mounted=$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Type}}:{{.Name}}{{end}}{{end}}' yingjian-lan)
  case "$mounted" in volume:?*) old_volume=${mounted#volume:} ;;
    *) fail "Existing yingjian-lan uses an unsupported /app/data mount. Keep it intact and migrate its data explicitly." ;;
  esac
  old_project=$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' yingjian-lan)
  old_service=$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' yingjian-lan)
  [ "$old_service" = yingjian ] ||
    fail "Existing yingjian-lan was not created by the expected Compose service. Keep it intact and inspect it first."
  case "$old_project" in ''|*[!a-zA-Z0-9_-]*) fail "Cannot determine the existing Compose project." ;; esac
  PROJECT_NAME=$old_project
  if [ "$DATA_VOLUME" != yingjian-data ] && [ "$DATA_VOLUME" != "$old_volume" ]; then
    fail "DATA_VOLUME differs from the existing server. Use its current volume name to preserve data."
  fi
  DATA_VOLUME=$old_volume
elif [ "$DATA_VOLUME" = yingjian-data ]; then
  # A stopped/removed old container can leave its data volume behind.
  candidates=$(docker volume ls --filter label=com.docker.compose.volume=yingjian-data --format '{{.Name}}')
  count=$(printf '%s\n' "$candidates" | awk 'NF { count++ } END { print count+0 }')
  if [ "$count" -gt 1 ]; then
    fail "Multiple previous data volumes exist. Set DATA_VOLUME to the intended one; no container was changed."
  elif [ "$count" -eq 1 ]; then
    DATA_VOLUME=$candidates
  fi
fi
case "$DATA_VOLUME" in
  [a-zA-Z0-9]*) case "$DATA_VOLUME" in *[!a-zA-Z0-9_.-]*) fail "Detected an invalid volume name." ;; esac ;;
  *) fail "Detected an invalid volume name." ;;
esac
export DATA_VOLUME

# Persist the selected volume for later GUI imports and invocations.
# All output is generated by this script; passwords are never printed or rewritten.
if [ "$ACTION" = start ] || [ "$ACTION" = update ]; then
  temp_env="$ENV_FILE.tmp.$$"
  trap 'rm -f "$temp_env"' 0 HUP INT TERM
  awk -v volume="$DATA_VOLUME" '
    /^DATA_VOLUME=/ { print "DATA_VOLUME=" volume; found=1; next }
    { sub(/\r$/, ""); print }
    END { if (!found) print "DATA_VOLUME=" volume }
  ' "$ENV_FILE" > "$temp_env"
  mv "$temp_env" "$ENV_FILE"
  trap - 0 HUP INT TERM
fi

# --quiet validates without exposing the administrator password.
compose config --quiet >/dev/null || fail "Compose cannot validate this bundle. Upgrade Compose or inspect the configuration locally."
case "$ACTION" in
  start)
    compose up -d --build
    printf '%s\n' "Server started: $PUBLIC_ORIGIN" "Run sh deploy.sh status to inspect startup and health."
    ;;
  update)
    compose build --pull
    compose up -d
    printf '%s\n' "Server updated; existing data volume retained: $DATA_VOLUME" "Address: $PUBLIC_ORIGIN"
    ;;
  stop)
    compose stop
    printf '%s\n' "Server stopped. Data volume retained: $DATA_VOLUME"
    ;;
  status)
    compose ps
    ;;
esac
