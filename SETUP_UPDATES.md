# Настройка автообновлений и CI/CD

Мы настроили автоматическую сборку и обновление приложения через GitHub Actions.
Чтобы всё заработало, тебе нужно добавить секреты в репозиторий GitHub.

## 1. Добавление секретов в GitHub

1. Зайди в репозиторий: **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**.
2. Добавь следующие секреты:

| Имя | Значение | Описание |
|---|---|---|
| `TAURI_PRIVATE_KEY` | *(см. ниже)* | Приватный ключ для подписи обновлений |
| `TAURI_KEY_PASSWORD` | *(твой пароль)* | Пароль от ключа (если задавал, иначе оставь пустым) |
| `SUPABASE_URL` | `https://pnrixpwwjasjizuamuwu.supabase.co` | URL твоей базы данных |
| `SUPABASE_KEY` | *(твой anon ключ)* | Публичный ключ Supabase (из `secrets.env`) |

### Твой TAURI_PRIVATE_KEY
Скопируй и вставь это значение целиком (это результат генерации, который мы сохранили):

```text
dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5ClJXUlRZMEl5N2Y5c3pCdW9CVGwwUlc2TmljbGs2Y1BPY3J5K1hxeVRUWHlZUHhlai8rOEFBQkFBQUFBQUFBQUFBQUlBQUFBQVJVNzN6MGYvZ0xVUDdSRmkxcC9CcmIvdTVZbEtTcnFFSUpqRFJKdHZqMUpEQmczSGd5L1NlaXY0dnNLbVBmOGpOZ2dLam42VHpyWFg1a1VmSW1JQTZoWUxrYlZFbkI4dFV2YkFORHZHYTRyOTFFci9yeDFSZ3NmOWhoODdiMEo0MmNlTU1LSWpYMDg9Cg==
```

## 2. Как выпускать новую версию

Теперь процесс релиза полностью автоматизирован. Чтобы выпустить обновление для пользователей:

1.  Измени версию в файле `VERSION` (например, на `1.0.2`).
2.  Сделай коммит и пуш в ветку `main`.
    ```bash
    git add .
    git commit -m "Bump version to 1.0.2"
    git push origin main
    ```
3.  GitHub Action сам:
    *   Увидит изменение версии.
    *   Соберет приложение.
    *   Подпишет его ключом.
    *   Создаст релиз `v1.0.2` на GitHub.
    *   Загрузит туда установочные файлы и `latest.json`.

4.  У пользователей при следующем запуске появится окно с предложением обновиться.

## 3. Локальная разработка

Для локального запуска (`npm run tauri dev`) ничего дополнительно делать не нужно. Ключи нужны только для сборки релиза (`npm run tauri build`), который теперь делает GitHub.

