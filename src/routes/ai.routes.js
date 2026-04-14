import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { generateAssistantReply } from '../services/ai.service.js';
import { ProjectModel } from '../models/Project.js';
import { TaskModel } from '../models/Task.js';

const router = express.Router();

const lastBulkCompletionByUser = new Map();

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests. Try again later.' },
});

const chatSchema = z.object({
  prompt: z.string().min(1),
  context: z
    .object({
      activeTasks: z.number().optional(),
      activeProjects: z.number().optional(),
      totalTasks: z.number().optional(),
      doneTasks: z.number().optional(),
      userId: z.string().optional(),
      projectTitles: z.array(z.string()).optional(),
      priorityTasks: z.array(z.string()).optional(),
    })
    .optional(),
});

const TASK_STATUS_PATTERNS = [
  { status: 'in-progress', test: (text) => /(в\s*работе|in\s*progress|в\s*процессе)/i.test(text) },
  { status: 'review', test: (text) => /(на\s*проверке|в\s*проверке|review)/i.test(text) },
  { status: 'queue', test: (text) => /(в\s*очереди|очеред|queue|to\s*do|нов(ые|ая|ых)\s*задач)/i.test(text) },
  { status: 'done', test: (text) => /(готов(ые|ая|ых)?|выполн(ен|ено|ены|енные)?|done)/i.test(text) },
];

const TASK_STATUS_LABELS = {
  queue: 'В очереди',
  'in-progress': 'В работе',
  review: 'На проверке',
  done: 'Готово',
};

const isCompleteAllTasksCommand = (prompt) => {
  return (
    /(отправ(ь|ьте)|перевед(и|ите)|постав(ь|ьте)|сделай|сделайте|перенес(и|ите)|перемест(и|ите)|заверш(и|ите)).*(все).*(готов)/i.test(
      prompt
    ) || /(все).*(задач).*(в\s*готов|готов)/i.test(prompt)
  );
};

const isCompleteAllProjectsCommand = (prompt) => {
  return /(заверши|завершите|закрой|закройте).*(все).*(проект)/i.test(prompt);
};

const isUndoBulkCompletionCommand = (prompt) => {
  return /(отмена|отмени|верни.*(обратно|назад|по местам)|откат(и|ить))/i.test(prompt);
};

const isReviewCountQuestion = (prompt) => {
  return /(сколько).*(на проверке|в проверке|review)/i.test(prompt);
};

const isActiveCountQuestion = (prompt) => {
  return /(сколько).*(активн).*(задач)/i.test(prompt);
};

const isDoneCountQuestion = (prompt) => {
  return /(сколько).*((готов|выполн).*(задач)|задач.*(готов|выполн))/i.test(prompt);
};

const isLowSignalPrompt = (prompt) => {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  // Слишком коротко или почти без слов
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= 1 && normalized.length < 12) {
    return true;
  }

  // Похоже на шум/случайный набор символов
  if (/^[a-zа-я0-9]{1,12}$/i.test(normalized) && !/[аеёиоуыэюяaeyuio]/i.test(normalized)) {
    return true;
  }

  return false;
};

const detectStatusIntent = (prompt) => {
  const normalized = prompt.trim().toLowerCase();
  const statusHit = TASK_STATUS_PATTERNS.find((item) => item.test(normalized));

  if (!statusHit) {
    return null;
  }

  const isCountMode = /(сколько|кол-?во|количество|count)/i.test(normalized);
  return {
    status: statusHit.status,
    mode: isCountMode ? 'count' : 'summary',
  };
};

const executeCompleteAllTasks = async (ownerId) => {
  const tasksToComplete = await TaskModel.find({ ownerId, status: { $ne: 'done' } })
    .select('id projectId status completedAt')
    .lean();

  if (tasksToComplete.length === 0) {
    return {
      updatedTasksCount: 0,
      affectedProjectsCount: 0,
    };
  }

  const affectedProjectsCount = new Set(tasksToComplete.map((task) => task.projectId).filter(Boolean)).size;

  await TaskModel.updateMany(
    { ownerId, status: { $ne: 'done' } },
    {
      $set: {
        status: 'done',
        completedAt: new Date(),
      },
    }
  );

  lastBulkCompletionByUser.set(ownerId, {
    timestamp: Date.now(),
    tasks: tasksToComplete.map((task) => ({
      id: task.id,
      status: task.status,
      completedAt: task.completedAt ?? null,
    })),
  });

  return {
    updatedTasksCount: tasksToComplete.length,
    affectedProjectsCount,
  };
};

const executeUndoLastBulkCompletion = async (ownerId) => {
  const lastOperation = lastBulkCompletionByUser.get(ownerId);

  if (!lastOperation || !Array.isArray(lastOperation.tasks) || lastOperation.tasks.length === 0) {
    return { restoredCount: 0 };
  }

  await TaskModel.bulkWrite(
    lastOperation.tasks.map((task) => ({
      updateOne: {
        filter: { ownerId, id: task.id },
        update: {
          $set: {
            status: task.status,
            completedAt: task.completedAt,
          },
        },
      },
    }))
  );

  lastBulkCompletionByUser.delete(ownerId);
  return { restoredCount: lastOperation.tasks.length };
};

router.use(authRequired);
router.use(aiLimiter);

router.post('/chat', validate(chatSchema), async (req, res) => {
  try {
    const ownerId = req.user.id;
    const prompt = req.body.prompt.trim();

    if (isLowSignalPrompt(prompt)) {
      return res.json({
        message:
          'Не до конца понял запрос. Уточните, пожалуйста, что нужно сделать:\n1) Показать статистику\n2) Изменить статусы задач\n3) Показать проекты',
        confidence: 0.99,
        suggestions: ['Сколько у меня активных задач', 'Перенеси все задачи в готовые', 'Покажи мои проекты'],
      });
    }

    if (isUndoBulkCompletionCommand(prompt)) {
      const { restoredCount } = await executeUndoLastBulkCompletion(ownerId);

      if (restoredCount === 0) {
        return res.json({
          message: 'Отменять нечего: не найдено последней массовой операции.',
          confidence: 0.99,
          suggestions: ['Показать активные задачи', 'Показать готовые задачи'],
          effects: { tasksChanged: false },
        });
      }

      return res.json({
        message: `Готово: отменена последняя массовая операция, восстановлено ${restoredCount} задач(и).`,
        confidence: 0.99,
        suggestions: ['Показать активные задачи', 'Показать статус задач'],
        effects: { tasksChanged: true },
      });
    }

    if (isCompleteAllTasksCommand(prompt)) {
      const { updatedTasksCount } = await executeCompleteAllTasks(ownerId);

      if (updatedTasksCount === 0) {
        return res.json({
          message: 'Готово: все задачи уже находятся в статусе "Готово".',
          confidence: 0.99,
          suggestions: ['Показать готовые задачи', 'Показать сводку по задачам'],
          effects: { tasksChanged: false },
        });
      }

      return res.json({
        message: `Готово: переведено в статус "Готово" ${updatedTasksCount} задач(и).`,
        confidence: 0.99,
        suggestions: ['Показать готовые задачи', 'Показать сводку по задачам'],
        effects: { tasksChanged: true },
      });
    }

    const statusIntent = detectStatusIntent(prompt);
    if (statusIntent) {
      const tasksByStatus = await TaskModel.find({ ownerId, status: statusIntent.status }).select('title').lean();
      const count = tasksByStatus.length;
      const label = TASK_STATUS_LABELS[statusIntent.status] ?? 'Статус';

      if (statusIntent.mode === 'count') {
        return res.json({
          message: `${label}: ${count} задач(и).`,
          confidence: 0.99,
          suggestions: ['Показать активные задачи', 'Показать готовые задачи'],
        });
      }

      const topTitles = tasksByStatus
        .slice(0, 3)
        .map((task) => task.title)
        .filter(Boolean);

      return res.json({
        message: `${label}: ${count} задач(и)${topTitles.length ? `\nПримеры: ${topTitles.join(', ')}` : ''}.`,
        confidence: 0.99,
        suggestions: ['Сколько активных задач', 'Перенести все задачи в готовые'],
      });
    }

    if (isReviewCountQuestion(prompt)) {
      const reviewCount = await TaskModel.countDocuments({ ownerId, status: 'review' });
      return res.json({
        message: `На проверке: ${reviewCount} задач(и).`,
        confidence: 0.99,
        suggestions: ['Показать задачи на проверке', 'Показать активные задачи'],
      });
    }

    if (isActiveCountQuestion(prompt)) {
      const activeCount = await TaskModel.countDocuments({ ownerId, status: { $ne: 'done' } });
      return res.json({
        message: `Активных задач: ${activeCount}.`,
        confidence: 0.99,
        suggestions: ['Показать активные задачи', 'Перенести все в готовые'],
      });
    }

    if (isDoneCountQuestion(prompt)) {
      const doneCount = await TaskModel.countDocuments({ ownerId, status: 'done' });
      return res.json({
        message: `Готовых задач: ${doneCount}.`,
        confidence: 0.99,
        suggestions: ['Показать готовые задачи', 'Показать активные задачи'],
      });
    }

    if (isCompleteAllProjectsCommand(prompt)) {
      const { updatedTasksCount, affectedProjectsCount } = await executeCompleteAllTasks(ownerId);

      if (updatedTasksCount === 0) {
        return res.json({
          message: 'Готово: проекты уже завершены (все задачи в статусе "Готово").',
          confidence: 0.99,
          suggestions: ['Показать список проектов', 'Показать сводку по задачам'],
          effects: { tasksChanged: false },
        });
      }

      return res.json({
        message: `Готово: завершение применено. В статус "Готово" переведено ${updatedTasksCount} задач(и) в ${affectedProjectsCount} проект(ах).`,
        confidence: 0.99,
        suggestions: ['Показать список проектов', 'Показать сводку по задачам'],
        effects: { tasksChanged: true },
      });
    }

    const [projectRows, activeTasksCount, totalTasksCount, doneTasksCount, queueTasks, inProgressTasks] =
      await Promise.all([
        ProjectModel.find({ ownerId }).sort({ createdAt: -1 }).limit(5).lean(),
        TaskModel.countDocuments({ ownerId, status: { $ne: 'done' } }),
        TaskModel.countDocuments({ ownerId }),
        TaskModel.countDocuments({ ownerId, status: 'done' }),
        TaskModel.find({ ownerId, status: 'queue' }).sort({ createdAt: -1 }).limit(3).lean(),
        TaskModel.find({ ownerId, status: 'in-progress' }).sort({ updatedAt: -1 }).limit(3).lean(),
      ]);

    const projectTitles = projectRows.map((project) => project.title).filter(Boolean);
    const priorityTasks = [...inProgressTasks, ...queueTasks]
      .slice(0, 5)
      .map((task) => task.title)
      .filter(Boolean);

    const mergedContext = {
      ...(req.body.context ?? {}),
      userId: ownerId,
      activeTasks: req.body.context?.activeTasks ?? activeTasksCount,
      activeProjects: req.body.context?.activeProjects ?? projectTitles.length,
      totalTasks: req.body.context?.totalTasks ?? totalTasksCount,
      doneTasks: req.body.context?.doneTasks ?? doneTasksCount,
      projectTitles,
      priorityTasks,
    };

    const result = await generateAssistantReply({
      prompt: req.body.prompt,
      context: mergedContext,
    });
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI provider request failed';
    return res.status(502).json({ error: message });
  }
});

router.post('/analyze-tasks', validate(z.object({ prompt: z.string().min(1) })), (req, res) => {
  return res.json({
    message: `Анализ задач: ${req.body.prompt}`,
    confidence: 0.65,
    suggestions: ['Выделить 2 приоритетные задачи', 'Оценить риски дедлайнов'],
  });
});

router.post('/suggest-priorities', validate(z.object({ taskIds: z.array(z.string()).min(1) })), (req, res) => {
  const sorted = [...req.body.taskIds].sort();
  return res.json({
    message: 'Сформирован список приоритетов.',
    confidence: 0.67,
    suggestions: sorted,
  });
});

export default router;
