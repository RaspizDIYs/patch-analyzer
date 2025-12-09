#!/bin/bash

# Скрипт для создания beta релиза на GitHub
# Использование: GITHUB_TOKEN=your_token ./create-beta-release.sh

set -e

REPO="RaspizDIYs/patch-analyzer"
TAG="v1.0.1-beta"
VERSION="1.0.1-beta"
RELEASE_NAME="Beta Release v1.0.1"
RELEASE_NOTES="Beta канал обновлений

Новые возможности:
- Поддержка каналов обновлений (stable/beta)
- Темная тема
- Адаптивный дизайн
- Улучшения настроек"

if [ -z "$GITHUB_TOKEN" ]; then
    echo "Ошибка: GITHUB_TOKEN не установлен"
    echo "Использование: GITHUB_TOKEN=your_token ./create-beta-release.sh"
    exit 1
fi

echo "Создание релиза $TAG..."

# Создание релиза
RELEASE_RESPONSE=$(curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/$REPO/releases" \
  -d "{
    \"tag_name\": \"$TAG\",
    \"name\": \"$RELEASE_NAME\",
    \"body\": \"$RELEASE_NOTES\",
    \"prerelease\": true,
    \"draft\": false
  }")

RELEASE_ID=$(echo "$RELEASE_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)

if [ -z "$RELEASE_ID" ]; then
    echo "Ошибка при создании релиза:"
    echo "$RELEASE_RESPONSE"
    exit 1
fi

echo "Релиз создан с ID: $RELEASE_ID"
echo "Загрузка файлов..."

# Загрузка файлов
FILES=(
  "src-tauri/target/release/bundle/nsis/LoL Meta Analyzer_0.1.0_x64-setup.exe"
  "src-tauri/target/release/bundle/msi/LoL Meta Analyzer_0.1.0_x64_en-US.msi"
  "latest-beta.json"
)

for FILE in "${FILES[@]}"; do
    if [ ! -f "$FILE" ]; then
        echo "Предупреждение: файл $FILE не найден, пропускаю..."
        continue
    fi
    
    FILENAME=$(basename "$FILE")
    if [ "$FILENAME" == "latest-beta.json" ]; then
        FILENAME="latest.json"
    fi
    
    echo "Загрузка $FILENAME..."
    curl -s -X POST \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github.v3+json" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$FILE" \
      "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$FILENAME" > /dev/null
    
    echo "✓ $FILENAME загружен"
done

echo "Релиз успешно создан: https://github.com/$REPO/releases/tag/$TAG"

