# Публикация Harness

Публичная страница загрузки — [ebuilde.ru/harness](https://ebuilde.ru/harness).

1. Соберите VSIX командой `npm run package` и вычислите SHA-256.
2. Опубликуйте версионный файл по пути `/harness/releases/Harness-<версия>.vsix`.
3. Переключите `/harness/download` на новый файл и обновите `/harness/latest.json` с полями `version`, `files.download` и `files.sha256`.
4. Проверьте SHA-256 пакетов по обеим публичным ссылкам. Сохраняйте предыдущие версионные пакеты для ранее открытых обновлений.

Шаблон страницы Harness и клиентские файлы находятся в этой папке.
