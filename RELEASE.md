# Инструкция по созданию релиза

## Локальная сборка

### Сборка MSI инсталлера:
```bash
npm run tauri:build:msi
```

### Сборка NSIS (EXE) инсталлера:
```bash
npm run tauri:build:nsis
```

### Сборка всех форматов:
```bash
npm run tauri:build
```

Собранные файлы будут в `src-tauri/target/release/bundle/`:
- `msi/` - MSI инсталлер
- `nsis/` - NSIS (EXE) инсталлер

## Создание GitHub релиза

### Автоматически (через GitHub Actions):

1. Обнови версию в файлах:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`

2. Закоммить изменения:
   ```bash
   git add .
   git commit -m "Bump version to X.X.X"
   git push
   ```

3. Создать тег и запушить:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

4. GitHub Actions автоматически соберет релиз и загрузит файлы (MSI и NSIS)

### Вручную:

1. Собери релиз локально:
   ```bash
   npm run tauri:build
   ```

2. Создай релиз на GitHub:
   - Перейди в раздел Releases
   - Нажми "Draft a new release"
   - Укажи версию тега (например, v1.0.0)
   - Загрузи файлы из `src-tauri/target/release/bundle/msi/` и `src-tauri/target/release/bundle/nsis/`

## Версионирование

Версия должна быть одинаковой в трех местах:
- `package.json` - поле `version`
- `src-tauri/Cargo.toml` - поле `version`
- `src-tauri/tauri.conf.json` - поле `version`

Формат версии: `MAJOR.MINOR.PATCH` (например, 1.0.0)

