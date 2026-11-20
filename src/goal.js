'use strict';

function goalCommand(text) {
  const match = /^\/goal(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!match) return null;
  const input = match[1]?.trim() || 'status';
  if (['status', 'pause', 'resume'].includes(input)) return { action: input };
  const flags = /^(?:--budget (\d+)\s+)?(?:--turns (\d+)\s+)?([\s\S]+)$/.exec(input);
  const budget = Number(flags?.[1] || 100000);
  const maxTurns = Number(flags?.[2] || 5);
  const objective = flags?.[3]?.trim();
  if (!objective || /^[-/]/.test(objective) || objective.length > 8000 ||
      !Number.isSafeInteger(budget) || budget < 1000 || budget > 10000000 || maxTurns < 1 || maxTurns > 25) {
    throw Error('Используйте /goal [--budget 100000] [--turns 5] описание цели. Бюджет от 1 000 до 10 000 000, число ходов от 1 до 25.');
  }
  return {action:'start', objective, budget, maxTurns};
}

function goalSummary(goal) {
  if (!goal) return 'В чате нет цели. Запустите /goal описание цели.';
  const labels = {active:'в работе', paused:'на паузе', blocked:'остановлена', complete:'принята'};
  return [
    `Цель · ${labels[goal.status]} · ${goal.objective}`,
    `Ходы ${goal.turns}/${goal.maxTurns} · токены ${goal.spent}/${goal.budget} (вход без кэша и выход)`,
    goal.reason
  ].filter(Boolean).join('\n');
}

function goalLimit(goal) {
  if (goal.spent >= goal.budget) return 'Исчерпан бюджет цели.';
  if (goal.turns >= goal.maxTurns) return 'Исчерпан лимит ходов цели.';
  return '';
}

module.exports = { goalCommand, goalLimit, goalSummary };
