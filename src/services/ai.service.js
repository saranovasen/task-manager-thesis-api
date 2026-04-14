const AI_PROVIDER = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'meta-llama/llama-3.3-8b-instruct:free';
const AI_MODELS = (process.env.AI_MODELS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions';
const APP_URL = process.env.APP_URL || process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const APP_NAME = process.env.APP_NAME || 'Task Manager Thesis';

const DEFAULT_OPENROUTER_FALLBACK_MODELS = [
  'openrouter/auto',
  AI_MODEL,
  'qwen/qwen-2.5-7b-instruct:free',
  'google/gemma-2-9b-it:free',
  'deepseek/deepseek-r1-0528:free',
];

const buildFallbackReply = ({ prompt, context }) => {
  const activeTasks = context?.activeTasks ?? 'неизвестно';
  const activeProjects = context?.activeProjects ?? 'неизвестно';

  return {
    message: [
      'Принято. Вот краткий ответ ассистента:',
      '',
      `Запрос: ${prompt}`,
      `Активные задачи: ${activeTasks}`,
      `Активные проекты: ${activeProjects}`,
      '',
      'Рекомендация: начни с задач с ближайшим дедлайном и разбей крупные задачи на подзадачи.',
    ].join('\n'),
    confidence: 0.72,
    suggestions: ['Показать задачи на сегодня', 'Отсортировать задачи по дедлайну', 'Сформировать план на неделю'],
  };
};

const isProjectsQuestion = (prompt) => /какие.*проект|мои\s+проекты|список\s+проект|проекты\s+у\s+меня/i.test(prompt);
const isProjectCountQuestion = (prompt) => /сколько\s+.*проект/i.test(prompt);
const isDoneTasksCountQuestion = (prompt) =>
  /(сколько\s+.*(готов|выполн).*(задач|задачи))|((готов|выполн).*(задач|задачи).*(сколько))/i.test(prompt);
const isTasksCountQuestion = (prompt) => /сколько\s+.*задач/i.test(prompt);

const buildGroundedProjectsReply = (context) => {
  const projectTitles = Array.isArray(context?.projectTitles) ? context.projectTitles.filter(Boolean) : [];

  if (projectTitles.length === 0) {
    return {
      message:
        'Сейчас у вас нет проектов в системе.\n\nЕсли хотите, могу подсказать, как быстро создать первый проект и структуру задач.',
      confidence: 0.95,
      suggestions: ['Создать первый проект', 'Показать шаблон структуры проекта'],
    };
  }

  const list = projectTitles.map((title, index) => `${index + 1}. ${title}`).join('\n');

  return {
    message: `Ваши проекты:\n${list}\n\nНужно показать задачи по какому-то из них?`,
    confidence: 0.95,
    suggestions: ['Показать задачи по первому проекту', 'Показать только активные проекты'],
  };
};

const buildGroundedProjectCountReply = (context) => {
  const count = typeof context?.activeProjects === 'number' ? context.activeProjects : undefined;

  if (count === undefined) {
    return {
      message: 'Не вижу точного количества проектов в контексте. Обновить данные и повторить запрос?',
      confidence: 0.9,
      suggestions: ['Обновить данные', 'Показать список проектов'],
    };
  }

  return {
    message: `Сейчас у вас ${count} ${count === 1 ? 'проект' : count < 5 && count > 1 ? 'проекта' : 'проектов'}.`,
    confidence: 0.98,
    suggestions: ['Показать список проектов'],
  };
};

const buildGroundedTasksCountReply = (context) => {
  const total = typeof context?.totalTasks === 'number' ? context.totalTasks : undefined;
  const active = typeof context?.activeTasks === 'number' ? context.activeTasks : undefined;
  const done = typeof context?.doneTasks === 'number' ? context.doneTasks : undefined;

  if (total === undefined && active === undefined && done === undefined) {
    return {
      message: 'Не вижу точного количества задач в контексте. Обновить данные и повторить запрос?',
      confidence: 0.9,
      suggestions: ['Обновить данные', 'Показать активные задачи'],
    };
  }

  if (total !== undefined) {
    const details = [];
    if (active !== undefined) details.push(`активных: ${active}`);
    if (done !== undefined) details.push(`готовых: ${done}`);
    return {
      message: `Всего задач: ${total}${details.length ? ` (${details.join(', ')})` : ''}.`,
      confidence: 0.98,
      suggestions: ['Показать активные задачи', 'Показать готовые задачи'],
    };
  }

  return {
    message: `Активных задач: ${active ?? 0}. Готовых задач: ${done ?? 0}.`,
    confidence: 0.97,
    suggestions: ['Показать активные задачи', 'Показать готовые задачи'],
  };
};

const buildGroundedDoneTasksCountReply = (context) => {
  const done = typeof context?.doneTasks === 'number' ? context.doneTasks : undefined;

  if (done === undefined) {
    return {
      message: 'Не вижу количества готовых задач в контексте. Обновить данные и повторить запрос?',
      confidence: 0.9,
      suggestions: ['Обновить данные', 'Показать статус задач'],
    };
  }

  return {
    message: `Готовых задач: ${done}.`,
    confidence: 0.98,
    suggestions: ['Показать готовые задачи', 'Показать активные задачи'],
  };
};

export const generateAssistantReply = async ({ prompt, context }) => {
  if (isProjectCountQuestion(prompt)) {
    return buildGroundedProjectCountReply(context);
  }

  if (isDoneTasksCountQuestion(prompt)) {
    return buildGroundedDoneTasksCountReply(context);
  }

  if (isTasksCountQuestion(prompt)) {
    return buildGroundedTasksCountReply(context);
  }

  if (isProjectsQuestion(prompt)) {
    return buildGroundedProjectsReply(context);
  }

  if (!AI_API_KEY || AI_PROVIDER !== 'openrouter') {
    return buildFallbackReply({ prompt, context });
  }

  const modelCandidates = Array.from(new Set(AI_MODELS.length > 0 ? AI_MODELS : DEFAULT_OPENROUTER_FALLBACK_MODELS));

  const contextText = [
    context?.activeTasks !== undefined ? `Активные задачи: ${context.activeTasks}` : null,
    context?.activeProjects !== undefined ? `Активные проекты: ${context.activeProjects}` : null,
    context?.totalTasks !== undefined ? `Всего задач: ${context.totalTasks}` : null,
    context?.doneTasks !== undefined ? `Готовые задачи: ${context.doneTasks}` : null,
    context?.projectTitles?.length ? `Проекты: ${context.projectTitles.join(', ')}` : null,
    context?.priorityTasks?.length ? `Ключевые задачи: ${context.priorityTasks.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const userPrompt = contextText ? `${prompt}\n\nКонтекст:\n${contextText}` : prompt;

  let lastErrorMessage = 'AI provider request failed';

  for (const model of modelCandidates) {
    const response = await fetch(AI_BASE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AI_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': APP_URL,
        'X-Title': APP_NAME,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Ты ассистент менеджера задач. Отвечай по-русски, четко и лаконично (до 8 строк). Используй ТОЛЬКО данные из контекста пользователя. Ничего не выдумывай (не придумывай названия проектов/задач). Если данных недостаточно — задай 1 уточняющий вопрос и перечисли, каких данных не хватает. Формат: 1) короткий вывод, 2) до 4 шагов, 3) топ-3 приоритета только если это уместно.',
          },
          {
            role: 'user',
            content: userPrompt,
          },
        ],
        temperature: 0.2,
        max_tokens: 260,
      }),
    });

    if (response.ok) {
      const payload = await response.json();
      const message = payload?.choices?.[0]?.message?.content?.trim();

      return {
        message: message || 'Не удалось получить текст ответа от AI.',
        confidence: undefined,
        suggestions: [],
      };
    }

    try {
      const payload = await response.json();
      const text = payload?.error?.message || payload?.error || payload?.message;
      if (text) {
        lastErrorMessage = String(text);
      } else {
        lastErrorMessage = `AI provider error: ${response.status}`;
      }
    } catch {
      lastErrorMessage = `AI provider error: ${response.status}`;
    }
  }

  return {
    ...buildFallbackReply({ prompt, context }),
    message: `${buildFallbackReply({ prompt, context }).message}\n\n(Внешний AI временно недоступен: ${lastErrorMessage})`,
  };
};
