# Настройка GitHub Secrets для автоматических релизов

Для работы автоматических релизов и доступа к Supabase необходимо настроить следующие secrets в GitHub:

## Необходимые Secrets

1. **SUPABASE_URL** - URL вашего Supabase проекта
   - Формат: `https://your-project.supabase.co`
   - Где найти: Supabase Dashboard → Settings → API → Project URL

2. **SUPABASE_KEY** - Anon/Public ключ Supabase
   - Формат: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`
   - Где найти: Supabase Dashboard → Settings → API → Project API keys → `anon` `public`

## Как добавить Secrets

1. Перейди в репозиторий: https://github.com/RaspizDIYs/patch-analyzer/settings/secrets/actions
2. Нажми "New repository secret"
3. Добавь каждый secret с соответствующим именем и значением
4. Сохрани

## Проверка

После добавления secrets, workflow автоматически будет:
- Использовать Supabase переменные при сборке приложения
- Передавать их в скомпилированное приложение через `option_env!`
- Любое скачанное приложение будет иметь доступ к Supabase данным

## Каналы обновлений

- **stable** - автоматически создается при push в `main`/`master`
- **beta** - автоматически создается при push в `beta`
- Можно также запустить вручную через "Run workflow" с выбором канала

## Файлы релиза

Каждый релиз автоматически включает:
- Установщики для всех платформ (Windows, Linux, macOS)
- Файл `latest.json` для автоматических обновлений
- Правильные теги и версии


