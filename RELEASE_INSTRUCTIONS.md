# Инструкция по созданию релиза

## Быстрый старт

### 1. Обновление версии (уже сделано)
Версия обновлена до **1.0.0** в:
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

### 2. Локальная сборка релиза

```bash
# Сборка всех форматов (MSI + NSIS)
npm run tauri:build
```

Или отдельно:
```bash
# Только MSI
npm run tauri:build:msi

# Только NSIS (EXE)
npm run tauri:build:nsis
```

**Время сборки:** ~5-10 минут (первая сборка может быть дольше)

**Результат:** Файлы будут в `src-tauri/target/release/bundle/`:
- `msi/LoL Meta Analyzer_1.0.0_x64_en-US.msi` - MSI инсталлер
- `nsis/LoL Meta Analyzer_1.0.0_x64-setup.exe` - NSIS (EXE) инсталлер

### 3. Создание GitHub релиза

#### Вариант A: Автоматически (рекомендуется)

1. Закоммить изменения:
   ```bash
   git add .
   git commit -m "Release v1.0.0"
   git push
   ```

2. Создать тег и запушить:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

3. GitHub Actions автоматически:
   - Соберет релиз на Windows
   - Создаст релиз с MSI и NSIS файлами
   - Загрузит файлы в релиз

#### Вариант B: Вручную

1. Собери релиз локально (см. шаг 2)

2. Создай релиз на GitHub:
   - Перейди: https://github.com/RaspizDIYs/lol-meta-analyzer/releases/new
   - Tag: `v1.0.0`
   - Title: `LoL Meta Analyzer v1.0.0`
   - Description: описание изменений
   - Загрузи файлы из `src-tauri/target/release/bundle/msi/` и `nsis/`

## Что включено в релиз

- ✅ MSI инсталлер (Windows Installer)
- ✅ NSIS инсталлер (EXE установщик)
- ✅ Автоматическая сборка через GitHub Actions
- ✅ Версионирование синхронизировано

## Следующие версии

Для следующего релиза:
1. Обнови версию в трех файлах (package.json, Cargo.toml, tauri.conf.json)
2. Закоммить изменения
3. Создать новый тег (например, v1.0.1)
4. Запушить тег - GitHub Actions соберет автоматически


