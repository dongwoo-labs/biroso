#!/usr/bin/env bash
# 이 맥에 launchd 작업 두 개를 등록한다(다시 실행해도 된다).
#   kr.selfhost.colima             로그인하면 Colima VM "selfhost"를 띄운다. 컨테이너는 restart: unless-stopped로 따라 뜬다.
#   kr.selfhost.backup.<프로젝트>  매일 BACKUP_AT(기본 03:30) 암호화 백업(infra/mac/backup.sh)
# 지우려면: launchctl bootout gui/$(id -u)/<label> 후 ~/Library/LaunchAgents/<label>.plist 삭제
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
project=$(basename "$root")
at=${BACKUP_AT:-03:30}
agents=$HOME/Library/LaunchAgents
logs=$HOME/srv/logs
mkdir -p "$agents" "$logs"
path_env=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

write() { # label, plist body
  local file="$agents/$1.plist"
  printf '%s\n' "$2" >"$file"
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$file"
  echo "등록: $1"
}

write kr.selfhost.colima "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
  <key>Label</key><string>kr.selfhost.colima</string>
  <key>ProgramArguments</key><array><string>/opt/homebrew/bin/colima</string><string>start</string><string>selfhost</string><string>--activate=false</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$path_env</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$logs/colima.log</string>
  <key>StandardErrorPath</key><string>$logs/colima.log</string>
</dict></plist>"

write "kr.selfhost.backup.$project" "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
  <key>Label</key><string>kr.selfhost.backup.$project</string>
  <key>ProgramArguments</key><array><string>$root/infra/mac/backup.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$path_env</string><key>DOCKER_CONTEXT</key><string>colima-selfhost</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$((10#${at%%:*}))</integer><key>Minute</key><integer>$((10#${at##*:}))</integer></dict>
  <key>StandardOutPath</key><string>$logs/backup-$project.log</string>
  <key>StandardErrorPath</key><string>$logs/backup-$project.log</string>
</dict></plist>"
