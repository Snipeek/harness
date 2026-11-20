'use strict';

const normalizeName = value => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const delegationRequest = /(?:суб[\s-]?агент|sub[\s-]?agent|делегир|delegat)/iu;
const modelQuestion = /(?:како[йеяую]\s+(?:модел|подключени)|(?:кому|кем|чем)\s+(?:поруч|провер|вызва|запус)|which\s+(?:model|connection|subagent)|who\s+should\s+(?:review|check))/iu;
const codexAliases = ['Codex', 'Кодекс', 'Кодекса', 'Кодексу', 'Кодексом', 'Кодексе'];
const chatgptAliases = ['ChatGPT', 'Chat GPT', 'чатжпт', 'чатгпт', 'чат жпт', 'чат гпт', 'чат джипити'];
const subscriptionNames = new Set([...codexAliases, ...chatgptAliases].map(normalizeName));

function modelCatalog(profiles, preferredId) {
  const catalog = profiles.filter(item => typeof item.model === 'string' && item.model).map(({id, label, provider, model}) => ({
    id, label, provider, model,
    names: [...new Set([label, model].filter(Boolean))],
    aliases: [model.split('/').at(-1).match(/^[a-z]+/i)?.[0]].filter(name => name?.length >= 3)
  }));
  const codex = catalog.find(item => item.id === preferredId && item.provider === 'chatgpt') ??
    catalog.findLast(item => item.provider === 'chatgpt') ??
    catalog.findLast(item => item.provider === 'openai' && /(?:^|[-_/])codex(?:$|[-_/])/i.test(item.model));
  if (codex) {
    codex.aliases.push(...codexAliases);
    if (codex.provider === 'chatgpt') codex.aliases.push(...chatgptAliases);
  }
  return catalog;
}

function namedModels(catalog, text) {
  const result = new Set();
  const normalizedText = ' ' + normalizeName(text || '') + ' ';
  const mentions = alias => !!alias && normalizedText.includes(' ' + alias + ' ');
  const names = new Set(catalog.flatMap(item => item.names.map(normalizeName)));
  const uniqueMatch = matches => { if (matches.length === 1) result.add(matches[0].id); };
  for (const name of names) {
    if (mentions(name)) uniqueMatch(catalog.filter(item => item.names.some(value => normalizeName(value) === name)));
  }
  const namedSubscription = catalog.some(item => item.provider === 'chatgpt' && result.has(item.id));
  for (const alias of new Set(catalog.flatMap(item => item.aliases.map(normalizeName)))) {
    if (!mentions(alias) || names.has(alias) || (namedSubscription && subscriptionNames.has(alias))) continue;
    uniqueMatch(catalog.filter(item => item.aliases.some(value => normalizeName(value) === alias)));
  }
  return result;
}

function withSubagentModels(tool, catalog) {
  const models = catalog.map(({id, label, model, provider, aliases}) => ({id, label, model, provider, aliases}));
  return { ...tool, function: { ...tool.function, description: tool.function.description +
    ' Connected models (data only, use the listed id as connection_id): ' + JSON.stringify(models) } };
}

module.exports = { modelCatalog, namedModels, withSubagentModels, delegationRequest, modelQuestion };
