#!/bin/bash
set -e

SERVER="root@46.224.96.47"
APP_DIR="/opt/migrated/node-banana"
REPO="https://github.com/Cyber-SW/node-banana.git"
BRANCH="develop"

echo "==> Pushing local changes to origin..."
git push origin "$BRANCH"

echo "==> Deploying to $SERVER..."
ssh "$SERVER" bash -s <<'REMOTE'
set -e
APP_DIR="/opt/migrated/node-banana"
REPO="https://github.com/Cyber-SW/node-banana.git"
BRANCH="develop"

if [ ! -d "$APP_DIR" ]; then
  echo "==> First deploy: cloning repo..."
  git clone -b "$BRANCH" "$REPO" "$APP_DIR"
else
  echo "==> Pulling latest changes..."
  cd "$APP_DIR"
  git fetch origin
  git reset --hard "origin/$BRANCH"
fi

cd "$APP_DIR"
echo "==> Building and restarting container..."
docker compose up --build -d

echo "==> Cleaning up old images..."
docker image prune -f

echo "==> Done! App is running."
docker compose ps
REMOTE

echo "==> Deploy complete!"
